import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Tier-1a local LLM via `node-llama-cpp` — installed **on demand** (not a package.json dependency, so
 * users who don't enable it never pay the large native download). Everything lives in the writable
 * instance data dir (`<iobroker-data>/assistant.<n>/`), which survives adapter upgrades; on a fresh
 * upgrade the module is simply re-installed on request.
 *
 * The model runs **tool-free**: it answers general questions and, when a request needs live ioBroker
 * state or it is unsure, it emits the {@link HANDOFF} sentinel so the orchestrator escalates to the
 * cloud LLM (which has the tools). Small models handle a "say HANDOFF" rule far more reliably than
 * real tool-calling.
 */

/** Sentinel the local model returns to escalate a request to the cloud LLM. */
export const HANDOFF = 'HANDOFF';

/** Default local model: small enough for arm64 (Raspi/NanoPi), tool-free chat, ~1 GB. */
export const DEFAULT_LOCAL_MODEL_URL =
    'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

type Logger = Pick<ioBroker.Logger, 'info' | 'warn' | 'debug' | 'error'>;

export interface LocalLlmOptions {
    /** Writable instance data dir (from `adapter.getAbsoluteInstanceDataDir()`) — where node-llama-cpp lives. */
    dataDir: string;
    /** Full path of the GGUF model file (the model manager downloads it). */
    modelPath: string;
    systemPrompt?: string;
    maxTokens?: number;
    /** The model writes a chain of thought first (Qwen3): give it no thought budget, it costs seconds. */
    noThoughts?: boolean;
    log: Logger;
}

/** Measurements of the last {@link LocalLlm.ask}. */
export interface LocalLlmRun {
    /** Whole call, prompt processing included. */
    ms: number;
    /** Tokens of the prompt (question + facts; the system prompt is cached in the session). */
    promptTokens?: number;
    /** Generated tokens. */
    tokens: number;
    /** From the call to the first generated token (= prompt processing). */
    firstTokenMs?: number;
    /** From the first to the last generated token; tokens/s = tokens / genMs. */
    genMs: number;
}

/** Directory the on-demand npm install targets (`<dataDir>/node_modules/node-llama-cpp`). */
function moduleDir(dataDir: string): string {
    return path.join(dataDir, 'node_modules', 'node-llama-cpp');
}

/** True once `node-llama-cpp` has been installed into the data dir. */
export function isLocalLlmInstalled(dataDir: string): boolean {
    try {
        return fs.existsSync(path.join(moduleDir(dataDir), 'package.json'));
    } catch {
        return false;
    }
}

/**
 * Install `node-llama-cpp` (with its prebuilt native binary) into the data dir via a spawned `npm
 * install`. Streams npm output to `onProgress`. Idempotent-ish: npm is a no-op if already present.
 */
export function installLocalLlm(dataDir: string, onProgress: (line: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(dataDir, { recursive: true });
        // A local package.json makes npm install into <dataDir>/node_modules (and not walk up).
        const pkg = path.join(dataDir, 'package.json');
        if (!fs.existsSync(pkg)) {
            fs.writeFileSync(pkg, JSON.stringify({ name: 'assistant-local-llm', private: true, version: '1.0.0' }));
        }
        const child = spawn(NPM, ['install', 'node-llama-cpp@3', '--omit=dev', '--no-audit', '--no-fund'], {
            cwd: dataDir,
            shell: process.platform === 'win32', // npm.cmd needs a shell on Windows
        });
        child.stdout.on('data', d => onProgress(String(d).trim()));
        child.stderr.on('data', d => onProgress(String(d).trim()));
        child.on('error', reject);
        child.on('close', code => (code === 0 ? resolve() : reject(new Error(`npm install exited with code ${code}`))));
    });
}

/**
 * A loaded local model. `load()` imports the on-demand module and spins up a llama context for the GGUF
 * file (the model manager has downloaded it). `ask()` returns the model's answer (or {@link HANDOFF}) and
 * leaves its measurements in {@link lastRun}.
 */
export class LocalLlm {
    private session: any = null;
    private model: any = null;
    private context: any = null;
    /** A prompt is running — the session takes one at a time. */
    private busy = false;
    /** Measurements of the last answered call. */
    lastRun: LocalLlmRun | null = null;
    /** How long {@link load} took. */
    loadMs = 0;

    constructor(private readonly opts: LocalLlmOptions) {}

    /** A prompt is running, so {@link ask} would hand off at once. */
    get running(): boolean {
        return this.busy;
    }

    /** Full system prompt = the strict HANDOFF rule (device work must escalate to the tool-enabled cloud LLM). */
    systemPrompt(): string {
        // The local model has NO tools and cannot touch the smart home. Anything device-related MUST hand off,
        // including control commands — otherwise a small model tends to "helpfully" refuse instead of escalating.
        return (
            `You are a smart-home assistant, but you have NO ability to read or control anything in the home. ` +
            `If the user wants to control or query ANYTHING in the home — e.g. turn on/off, switch, dim, ` +
            `open/close, start/stop, set, activate, or ask for the value/state/status of a light, socket, ` +
            `sensor, device, room, or the home — OR if you are unsure — you MUST reply with EXACTLY "${HANDOFF}" ` +
            `and nothing else. Do NOT apologise, do NOT explain, do NOT say you are an AI. ` +
            `Reply directly ONLY for general knowledge, small talk, or questions unrelated to the home.`
        );
    }

    async load(): Promise<void> {
        const started = Date.now();
        const dir = moduleDir(this.opts.dataDir);
        if (!fs.existsSync(path.join(dir, 'package.json'))) {
            throw new Error('node-llama-cpp is not installed — run the install first');
        }
        if (!fs.existsSync(this.opts.modelPath)) {
            throw new Error(`model file not found: ${this.opts.modelPath}`);
        }
        // Resolve the package entry from the data dir and import it (v3 is ESM-only → dynamic import).
        const req = createRequire(path.join(this.opts.dataDir, 'package.json'));
        const entry = req.resolve('node-llama-cpp');
        const mod: any = await import(pathToFileURL(entry).href);
        const { getLlama, LlamaChatSession } = mod;

        const llama = await getLlama();
        this.model = await llama.loadModel({ modelPath: this.opts.modelPath });
        // Leave one core to js-controller and the other adapters: llama.cpp takes all of them otherwise, and on
        // a Raspberry Pi the whole host — the voice server included — stalls for the length of an answer.
        const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
        this.context = await this.model.createContext({ threads: Math.max(1, cores - 1) });
        this.session = new LlamaChatSession({
            contextSequence: this.context.getSequence(),
            systemPrompt: this.systemPrompt(),
        });
        this.loadMs = Date.now() - started;
        this.opts.log.info(`Local model ${path.basename(this.opts.modelPath)} loaded in ${this.loadMs} ms.`);
    }

    /** Number of tokens of a text, or undefined when the model cannot tell. */
    private countTokens(text: string): number | undefined {
        try {
            const tokens = this.model?.tokenize?.(text);
            return Array.isArray(tokens) ? tokens.length : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Ask the local model. Returns its answer, or {@link HANDOFF} to escalate to the cloud LLM — also when
     * another question is still being answered (waiting for it would only add its run time to this one).
     * With `timeoutMs` the generation is aborted after that long and the call throws.
     */
    async ask(question: string, timeoutMs = 0): Promise<string> {
        if (!this.session || this.busy) {
            return HANDOFF;
        }
        this.busy = true;
        const abort = new AbortController();
        const timer = timeoutMs > 0 ? setTimeout(() => abort.abort(), timeoutMs) : null;
        const started = Date.now();
        let firstAt = 0;
        let lastAt = 0;
        let tokens = 0;
        this.lastRun = null;
        try {
            // Reset per-question so prompts stay independent (best-effort across node-llama-cpp versions).
            try {
                this.session.setChatHistory?.([]);
            } catch {
                /* ignore */
            }
            const answer: string = await this.session.prompt(question, {
                maxTokens: this.opts.maxTokens || 256,
                signal: abort.signal,
                // Older node-llama-cpp versions ignore unknown options.
                ...(this.opts.noThoughts ? { budgets: { thoughtTokens: 0 } } : {}),
                onToken: (chunk: unknown[]) => {
                    const now = Date.now();
                    if (!firstAt) {
                        firstAt = now;
                    }
                    lastAt = now;
                    tokens += Array.isArray(chunk) ? chunk.length : 1;
                },
            });
            if (abort.signal.aborted) {
                throw new Error('aborted');
            }
            this.lastRun = {
                ms: Date.now() - started,
                promptTokens: this.countTokens(question),
                tokens,
                firstTokenMs: firstAt ? firstAt - started : undefined,
                // The first token's own time belongs to prompt processing, so count the rest.
                genMs: tokens > 1 ? lastAt - firstAt : 0,
            };
            if (this.lastRun.genMs > 0) {
                this.lastRun.tokens = tokens - 1;
            }
            return (answer || '').trim();
        } catch (e) {
            if (abort.signal.aborted) {
                throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`);
            }
            throw e;
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
            this.busy = false;
        }
    }

    async dispose(): Promise<void> {
        try {
            await this.context?.dispose?.();
            await this.model?.dispose?.();
        } catch {
            /* ignore */
        }
        this.session = this.context = this.model = null;
    }
}

/**
 * Refusal patterns (de/en/ru) a small tool-free model emits when it *should* have handed off — e.g.
 * "I'm an AI and can't control real devices". Treated as a hand-off so the tool-enabled cloud LLM runs.
 */
const REFUSAL = [
    /\bhandoff\b/i,
    // en
    /\bi('?m| am)\s+an?\s+ai\b/i,
    /\bas\s+an?\s+ai\b/i, // "as an AI language model, I don't have the ability …"
    /\bi\s+(can('?t|not)|am\s+unable\s+to)\b.*\b(turn|switch|control|access|interact|device|light)\b/i,
    /\bi\s+(don'?t|do\s+not)\s+have\s+(the\s+ability|any\s+(information|data|way)|access|real[- ]time)\b/i,
    // de
    /\bich\s+bin\s+eine?\s+(ki|künstliche)\b/i,
    /\bals\s+(eine?\s+)?(ki|künstliche)\b/i,
    /\bkann\s+.*\bnicht\b.*\b(schalten|steuern|einschalten|zugreifen|geräte?|licht)\b/i,
    /\bhabe\s+keinen?\s+(zugriff|zugang|möglichkeit)\b/i,
    // ru (\w/\b are ASCII-only → use Cyrillic classes / plain substrings)
    /искусственн[а-яё]*\s+интеллект/i,
    /не\s+(могу|имею)/i,
];

/** True if the model's answer signals (or implies) a hand-off to the cloud LLM. */
export function isHandoff(answer: string): boolean {
    const trimmed = answer.trim();
    const up = trimmed.toUpperCase();
    if (up === HANDOFF || up.startsWith(`${HANDOFF} `) || up === `"${HANDOFF}"`) {
        return true;
    }
    return REFUSAL.some(re => re.test(trimmed));
}
