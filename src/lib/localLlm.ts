import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
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
    /** Writable instance data dir (from `adapter.getAbsoluteInstanceDataDir()`). */
    dataDir: string;
    /** Direct URL of a GGUF model file. */
    modelUrl: string;
    systemPrompt?: string;
    maxTokens?: number;
    log: Logger;
}

/** Directory the on-demand npm install targets (`<dataDir>/node_modules/node-llama-cpp`). */
function moduleDir(dataDir: string): string {
    return path.join(dataDir, 'node_modules', 'node-llama-cpp');
}

/** Local file path a model URL is cached to. */
function modelPathFor(dataDir: string, url: string): string {
    const file = url.split('/').pop() || 'model.gguf';
    return path.join(dataDir, 'models', file);
}

/** True once `node-llama-cpp` has been installed into the data dir. */
export function isLocalLlmInstalled(dataDir: string): boolean {
    try {
        return fs.existsSync(path.join(moduleDir(dataDir), 'package.json'));
    } catch {
        return false;
    }
}

/** True once the model file has been downloaded. */
export function isModelDownloaded(dataDir: string, url: string): boolean {
    try {
        return fs.existsSync(modelPathFor(dataDir, url));
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
 * A loaded local model. `load()` imports the on-demand module, downloads the GGUF if missing, and
 * spins up a llama context. `ask()` returns the model's answer (or {@link HANDOFF}).
 */
export class LocalLlm {
    private session: any = null;
    private model: any = null;
    private context: any = null;

    constructor(private readonly opts: LocalLlmOptions) {}

    /** Full system prompt = caller prompt + the HANDOFF rule. */
    private systemPrompt(): string {
        const base = this.opts.systemPrompt?.trim();
        const handoff =
            `If a request needs the current value/state of an ioBroker device, room or sensor, or you are ` +
            `not sure, reply with exactly "${HANDOFF}" and nothing else. Otherwise answer briefly in plain text.`;
        return base ? `${base}\n\n${handoff}` : handoff;
    }

    async load(onProgress?: (line: string) => void): Promise<void> {
        const dir = moduleDir(this.opts.dataDir);
        if (!fs.existsSync(path.join(dir, 'package.json'))) {
            throw new Error('node-llama-cpp is not installed — run the install first');
        }
        // Resolve the package entry from the data dir and import it (v3 is ESM-only → dynamic import).
        const req = createRequire(path.join(this.opts.dataDir, 'package.json'));
        const entry = req.resolve('node-llama-cpp');
        const mod: any = await import(pathToFileURL(entry).href);
        const { getLlama, LlamaChatSession, createModelDownloader } = mod;

        const modelPath = modelPathFor(this.opts.dataDir, this.opts.modelUrl);
        if (!fs.existsSync(modelPath)) {
            this.opts.log.info(`Downloading local model → ${modelPath}`);
            fs.mkdirSync(path.dirname(modelPath), { recursive: true });
            const downloader = await createModelDownloader({
                modelUri: this.opts.modelUrl,
                dirPath: path.dirname(modelPath),
                fileName: path.basename(modelPath),
                onProgress: (p: { downloadedSize: number; totalSize: number }) => {
                    if (p.totalSize) {
                        onProgress?.(`download ${Math.round((100 * p.downloadedSize) / p.totalSize)}%`);
                    }
                },
            });
            await downloader.download();
        }

        const llama = await getLlama();
        this.model = await llama.loadModel({ modelPath });
        this.context = await this.model.createContext();
        this.session = new LlamaChatSession({
            contextSequence: this.context.getSequence(),
            systemPrompt: this.systemPrompt(),
        });
        this.opts.log.info('Local model loaded.');
    }

    /** Ask the local model. Returns its answer, or {@link HANDOFF} to escalate to the cloud LLM. */
    async ask(question: string): Promise<string> {
        if (!this.session) {
            return HANDOFF;
        }
        // Reset per-question so prompts stay independent (best-effort across node-llama-cpp versions).
        try {
            this.session.setChatHistory?.([]);
        } catch {
            /* ignore */
        }
        const answer: string = await this.session.prompt(question, { maxTokens: this.opts.maxTokens || 512 });
        return (answer || '').trim();
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

/** True if the model's answer signals a hand-off to the cloud LLM. */
export function isHandoff(answer: string): boolean {
    const a = answer.trim().toUpperCase();
    return a === HANDOFF || a.startsWith(`${HANDOFF} `) || a === `"${HANDOFF}"`;
}
