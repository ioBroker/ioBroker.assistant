/**
 * Conversation journal: one entry per request the assistant answered — where it came from (chat, script,
 * Telegram, which satellite, which wake word), which tier answered it (routine, rule-based NLU, local
 * model, cloud model), which tools the model called and which state ids were read or written along the
 * way. The admin chat shows it live, so one can check what a satellite heard and what was done about it.
 *
 * Tools and state accesses happen deep inside the pipeline (NLU executor, LLM tool loop, routine
 * executor). Instead of threading an entry object through all of them, the entry rides along in an
 * {@link AsyncLocalStorage}: {@link Journal.run} opens it, and {@link Journal.note}/{@link Journal.tool}/
 * {@link Journal.stateAccess} write to whatever entry the current call chain belongs to — and do nothing
 * outside of one (a trigger writing a state is not a conversation).
 *
 * Besides the entry, every request keeps a **trace**: the steps of its processing with their timing and
 * whatever explains them — the NLU's parse, the full prompt and every round of the model, tool arguments
 * and results in full, speech recognition and synthesis. Traces are too big to ride along in `journal.last`
 * and in `journal.json`, so the chat fetches one when a request is opened ({@link Journal.trace}); each is
 * kept in a file of its own and only for the newest {@link MAX_TRACES} requests.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** How a request reached us. */
export type JournalTransport = 'chat' | 'script' | 'state' | 'telegram' | 'esphome' | 'udp' | 'native' | 'wyoming';

/** Which stage of the pipeline produced the answer. */
export type JournalTier =
    | 'stop' // stop word silenced a ringing timer/alarm
    | 'askReply' // the utterance answered an open `askUser` question
    | 'routine'
    | 'nlu'
    | 'localLlm'
    | 'cloud'
    | 'none'; // nothing local understood it and there is no cloud provider

/** Tokens a model call used (summed over the rounds of a request in {@link JournalEntry.tokens}). */
export interface JournalTokens {
    input: number;
    output: number;
    /** Prompt tokens served from the provider's prompt cache. */
    cacheRead?: number;
    /** Prompt tokens written to the provider's prompt cache (Anthropic). */
    cacheWrite?: number;
}

/** One step of how a request was processed — what the debug view of the admin chat shows. */
export interface JournalStep {
    /** Start of the step in ms after the request started (negative for speech recognition, which comes first). */
    t: number;
    /** Duration, for steps that took time. */
    ms?: number;
    /** Pipeline stage: request, stt, context, stop, askReply, routine, youtube, nlu, localLlm, cloud, tool, state, answer, tts, error. */
    stage: string;
    title: string;
    level?: 'warn' | 'error';
    tokens?: JournalTokens;
    /** Whatever explains the step (prompts, model responses, parse results) — a JSON snapshot. */
    data?: unknown;
}

/** What a caller records; the journal adds the timing. */
export type JournalStepInput = Omit<JournalStep, 't'>;

/** Hook for library code that should not know the journal (the LLM agent). */
export type TraceFn = (step: JournalStepInput) => void;

export interface JournalTool {
    name: string;
    args: Record<string, unknown>;
    ms: number;
    /** Result, JSON, shortened. */
    result?: string;
    error?: string;
}

export interface JournalEntry {
    id: string;
    /** Start of the answer, ms. */
    ts: number;
    /** False while the answer is still being produced. */
    done: boolean;
    /** Time to produce the answer (without STT/TTS). */
    ms?: number;
    source: string;
    transport: JournalTransport;
    satellite?: string;
    room?: string;
    /** Wake word the satellite reported; '' = the mic was re-opened for a follow-up, absent = unknown. */
    wakeWord?: string;
    /** Speech recognition time, for voice requests. */
    sttMs?: number;
    /** Length of the recorded utterance. */
    audioMs?: number;
    /** Speech synthesis time of the reply (voice requests, filled in after the answer). */
    ttsMs?: number;
    /** Length of the spoken reply. */
    replyAudioMs?: number;
    question: string;
    answer?: string;
    error?: string;
    tier?: JournalTier;
    /** Model name, routine name or NLU actions — whatever explains the tier. */
    detail?: string;
    tools: JournalTool[];
    /** State ids read to produce the answer. */
    read: string[];
    /** States written to produce the answer. */
    written: { id: string; value: unknown }[];
    /** The reply asks back, so a satellite re-opened its mic. */
    followUp?: boolean;
    /** Tokens of all model calls, when a cloud model answered. */
    tokens?: JournalTokens;
}

/** What the caller knows about a request before the pipeline starts. */
export interface JournalOrigin {
    transport?: JournalTransport;
    satellite?: string;
    room?: string;
    wakeWord?: string;
    sttMs?: number;
    audioMs?: number;
    /** Voice activity detection of the utterance (ESPHome) — trace only. */
    vad?: { peak: number; noiseFloor: number; startLevel: number; endLevel: number };
}

/** What a transport reports after it synthesised the reply. */
export interface JournalSpeech {
    ms: number;
    audioMs: number;
    provider: string;
    fallback?: string;
    voice?: string;
}

export interface JournalOptions {
    /** Retention in hours; 0 disables the journal entirely. */
    hours: number;
    /** File the journal is kept in across restarts ('' = memory only). */
    file: string;
    /** Called with every new or updated entry (drives the `journal.last` state the chat listens to). */
    onChange?: (entry: JournalEntry) => void;
    log: ioBroker.Logger;
}

/** Hard cap independent of the retention — a script asking every few seconds must not fill the disk. */
const MAX_ENTRIES = 3000;
const SAVE_DELAY_MS = 5000;
const RESULT_CHARS = 300;
/** Requests whose trace is kept on disk. */
export const MAX_TRACES = 200;
/** Traces held in memory (the newest ones — the ones somebody is about to open). */
const MEMORY_TRACES = 30;
/** Steps per request; a tool loop gone wild must not grow one trace without end. */
const MAX_STEPS = 400;
/** Longer strings are cut — enough for a system prompt with a few hundred devices. */
const STEP_STRING_CHARS = 100_000;
/** A reply is matched to its synthesis only this long after the answer. */
const SPEECH_WINDOW_MS = 120_000;
/** Entry ids as {@link Journal.run} makes them — checked before one becomes a file name. */
const ID_RE = /^[a-z0-9-]+$/;

/** Directory the traces of a journal file are kept in. */
export function traceDirFor(file: string): string {
    return path.join(path.dirname(file), 'journal-trace');
}

/**
 * JSON snapshot of a step's data — taken when it is recorded, because the objects go on changing (the
 * model's message list grows, cache markers move). Long strings are cut and buffers summarised.
 */
export function snapshot(value: unknown): unknown {
    if (value === undefined) {
        return undefined;
    }
    try {
        const text = JSON.stringify(value, (_key, v: unknown) => {
            if (typeof v === 'string' && v.length > STEP_STRING_CHARS) {
                return `${v.slice(0, STEP_STRING_CHARS)}… [+${v.length - STEP_STRING_CHARS} chars]`;
            }
            if (typeof v === 'bigint') {
                return v.toString();
            }
            // Buffer.toJSON() has already run when the replacer sees it.
            const b = v as { type?: unknown; data?: unknown } | null;
            if (b && typeof b === 'object' && b.type === 'Buffer' && Array.isArray(b.data)) {
                return `<${b.data.length} bytes>`;
            }
            return v;
        });
        return text === undefined ? undefined : JSON.parse(text);
    } catch (e) {
        return `<not serializable: ${(e as Error).message}>`;
    }
}

/** Everything an error carries that helps — an API error's status and body, the stack. */
export function errorInfo(e: unknown): Record<string, unknown> {
    if (!(e instanceof Error)) {
        return { message: String(e) };
    }
    const info: Record<string, unknown> = { name: e.name, message: e.message };
    for (const key of ['status', 'code', 'type', 'param', 'error', 'request_id', 'requestID']) {
        const v = (e as unknown as Record<string, unknown>)[key];
        if (v !== undefined && v !== null) {
            info[key] = v;
        }
    }
    if (e.stack) {
        info.stack = e.stack;
    }
    return info;
}

/** Derive the transport from a request source when the caller did not say. */
export function transportForSource(source: string): JournalTransport {
    if (source === 'chat') {
        return 'chat';
    }
    if (source === '') {
        return 'state';
    }
    if (source === 'wyoming') {
        return 'wyoming';
    }
    if (source.startsWith('telegram:')) {
        return 'telegram';
    }
    return 'script';
}

export class Journal {
    private entries: JournalEntry[] = [];
    private readonly store = new AsyncLocalStorage<JournalEntry>();
    private saveTimer: NodeJS.Timeout | null = null;
    private counter = 0;
    /** Steps of the newest requests; older ones are read back from their file. */
    private readonly traces = new Map<string, JournalStep[]>();
    /** Traces changed since they were last written. */
    private readonly dirty = new Set<string>();
    /** LLM tool calls in progress per request: a state access inside one belongs to that tool's step. */
    private readonly toolDepth = new WeakMap<JournalEntry, number>();
    private readonly traceDir: string;

    constructor(private readonly opts: JournalOptions) {
        this.traceDir = opts.file ? traceDirFor(opts.file) : '';
    }

    get enabled(): boolean {
        return this.opts.hours > 0;
    }

    /** Load the entries of the last run (silently starts empty when there are none). */
    async load(): Promise<void> {
        if (!this.enabled || !this.opts.file) {
            return;
        }
        try {
            const raw = JSON.parse(await fs.readFile(this.opts.file, 'utf8')) as unknown;
            if (Array.isArray(raw)) {
                // An entry still open at shutdown never got its answer.
                this.entries = (raw as JournalEntry[])
                    .filter(e => e && typeof e.id === 'string' && typeof e.ts === 'number')
                    .map(e => (e.done ? e : { ...e, done: true, error: e.error || 'interrupted' }));
                this.prune();
            }
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.opts.log.warn(`Journal could not be read: ${(e as Error).message}`);
            }
        }
    }

    /** Entries newer than `since` (ms), oldest first. */
    list(since = 0): JournalEntry[] {
        this.prune();
        return this.entries.filter(e => e.ts > since);
    }

    clear(): void {
        this.entries = [];
        this.traces.clear();
        this.dirty.clear();
        this.scheduleSave();
    }

    /** The entry of a request (the chat asks for it together with its trace). */
    get(id: string): JournalEntry | undefined {
        return this.entries.find(e => e.id === id);
    }

    /** The processing steps of a request, or null when none were kept (too old, or from an older version). */
    async trace(id: string): Promise<JournalStep[] | null> {
        if (!ID_RE.test(id) || !this.get(id)) {
            return null;
        }
        const steps = this.traces.get(id);
        if (steps) {
            return steps;
        }
        if (!this.traceDir) {
            return null;
        }
        try {
            const raw = JSON.parse(await fs.readFile(path.join(this.traceDir, `${id}.json`), 'utf8')) as {
                steps?: unknown;
            };
            return Array.isArray(raw?.steps) ? (raw.steps as JournalStep[]) : null;
        } catch {
            return null;
        }
    }

    /**
     * Run `fn` as one journalled request. The entry is published once when the request starts (so the
     * chat shows the question while the answer is still being worked out) and once when it is finished.
     */
    async run(question: string, source: string, origin: JournalOrigin, fn: () => Promise<string>): Promise<string> {
        if (!this.enabled) {
            return fn();
        }
        const entry: JournalEntry = {
            id: `${Date.now().toString(36)}-${(this.counter++).toString(36)}`,
            ts: Date.now(),
            done: false,
            source,
            transport: origin.transport || transportForSource(source),
            question,
            tools: [],
            read: [],
            written: [],
        };
        for (const key of ['satellite', 'room', 'wakeWord', 'sttMs', 'audioMs'] as const) {
            if (origin[key] !== undefined && origin[key] !== '') {
                (entry as unknown as Record<string, unknown>)[key] = origin[key];
            }
        }
        // A satellite that re-opened its mic reports no wake word — say so instead of "unknown".
        if (origin.wakeWord === '') {
            entry.wakeWord = '';
        }
        this.entries.push(entry);
        this.traces.set(entry.id, []);
        this.addStep(entry, {
            stage: 'request',
            title: `Request from ${source || entry.transport} (${entry.transport})`,
            data: { question, source, origin },
        });
        this.publish(entry);
        try {
            const answer = await this.store.run(entry, fn);
            entry.answer = answer;
            return answer;
        } catch (e) {
            entry.error = (e as Error).message;
            this.addStep(entry, { stage: 'error', level: 'error', title: entry.error, data: errorInfo(e) });
            throw e;
        } finally {
            entry.done = true;
            entry.ms = Date.now() - entry.ts;
            this.dirty.add(entry.id);
            this.publish(entry);
            this.prune();
            this.scheduleSave();
        }
    }

    /** Add a step to the current request's trace (nothing outside of one). */
    step(input: JournalStepInput): void {
        const entry = this.store.getStore();
        if (entry) {
            this.addStep(entry, input);
        }
    }

    /**
     * Run an LLM tool as part of the current request: the call lands in the entry's tool list and, with the
     * full arguments and result, in the trace.
     */
    async toolCall<T>(name: string, args: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
        const entry = this.store.getStore();
        if (!entry) {
            return fn();
        }
        this.toolDepth.set(entry, (this.toolDepth.get(entry) || 0) + 1);
        const start = Date.now();
        try {
            const result = await fn();
            const ms = Date.now() - start;
            this.addStep(entry, { stage: 'tool', title: `Tool ${name}`, ms, data: { args, result } });
            this.tool(name, args, ms, result);
            return result;
        } catch (e) {
            const ms = Date.now() - start;
            const message = (e as Error).message;
            this.addStep(entry, {
                stage: 'tool',
                level: 'error',
                title: `Tool ${name} failed: ${message}`,
                ms,
                data: { args, error: errorInfo(e) },
            });
            this.tool(name, args, ms, undefined, message);
            throw e;
        } finally {
            this.toolDepth.set(entry, (this.toolDepth.get(entry) || 1) - 1);
        }
    }

    /**
     * Run a state call (MCP `get_states`/`set_state`/…) as part of the current request: the ids land in the
     * entry's read/written lists, and — unless an LLM tool made the call, whose step already shows it — the
     * call with its result in the trace.
     */
    async stateCall<T>(name: string, args: Record<string, unknown> | undefined, fn: () => Promise<T>): Promise<T> {
        const entry = this.store.getStore();
        if (!entry) {
            return fn();
        }
        this.stateAccess(name, args);
        if (this.toolDepth.get(entry)) {
            return fn();
        }
        const start = Date.now();
        try {
            const result = await fn();
            this.addStep(entry, { stage: 'state', title: name, ms: Date.now() - start, data: { args, result } });
            return result;
        } catch (e) {
            this.addStep(entry, {
                stage: 'state',
                level: 'error',
                title: `${name} failed: ${(e as Error).message}`,
                ms: Date.now() - start,
                data: { args, error: errorInfo(e) },
            });
            throw e;
        }
    }

    /**
     * A transport synthesised the reply to the latest request of `source`. That happens after the answer,
     * outside of the request, so the entry is found by its source.
     */
    spoken(source: string, speech: JournalSpeech): void {
        const now = Date.now();
        for (let i = this.entries.length - 1; i >= 0; i--) {
            const entry = this.entries[i];
            if (entry.source !== source) {
                continue;
            }
            if (!entry.done || entry.ttsMs !== undefined || now - entry.ts - (entry.ms || 0) > SPEECH_WINDOW_MS) {
                return;
            }
            entry.ttsMs = speech.ms;
            entry.replyAudioMs = Math.round(speech.audioMs);
            const voice = speech.voice ? ` (${speech.voice})` : '';
            this.addStep(entry, {
                stage: 'tts',
                title: `Speech synthesis: ${speech.provider}${voice}, ${(speech.audioMs / 1000).toFixed(1)} s of audio`,
                ms: speech.ms,
                data: speech,
            });
            this.dirty.add(entry.id);
            this.publish(entry);
            this.scheduleSave();
            return;
        }
    }

    private addStep(entry: JournalEntry, input: JournalStepInput): void {
        const steps = this.traces.get(entry.id);
        if (!steps || steps.length > MAX_STEPS) {
            return;
        }
        if (steps.length === MAX_STEPS) {
            steps.push({
                t: Date.now() - entry.ts,
                stage: 'error',
                level: 'warn',
                title: `More than ${MAX_STEPS} steps — the rest is not recorded`,
            });
            return;
        }
        const step: JournalStep = {
            t: Date.now() - entry.ts - (input.ms || 0),
            stage: input.stage,
            title: input.title,
        };
        if (input.ms !== undefined) {
            step.ms = input.ms;
        }
        if (input.level) {
            step.level = input.level;
        }
        if (input.tokens) {
            step.tokens = input.tokens;
            const sum = (entry.tokens ||= { input: 0, output: 0 });
            sum.input += input.tokens.input || 0;
            sum.output += input.tokens.output || 0;
            if (input.tokens.cacheRead) {
                sum.cacheRead = (sum.cacheRead || 0) + input.tokens.cacheRead;
            }
            if (input.tokens.cacheWrite) {
                sum.cacheWrite = (sum.cacheWrite || 0) + input.tokens.cacheWrite;
            }
        }
        if (input.data !== undefined) {
            step.data = snapshot(input.data);
        }
        steps.push(step);
    }

    /** Fill in fields of the current request's entry (tier, detail, followUp …). */
    note(fields: Partial<Pick<JournalEntry, 'tier' | 'detail' | 'followUp'>>): void {
        const entry = this.store.getStore();
        if (entry) {
            Object.assign(entry, fields);
        }
    }

    /** Record a tool call the model made for the current request. */
    tool(name: string, args: Record<string, unknown>, ms: number, result: unknown, error?: string): void {
        const entry = this.store.getStore();
        if (!entry) {
            return;
        }
        const item: JournalTool = { name, args: args || {}, ms };
        if (error) {
            item.error = error;
        } else {
            let text: string;
            try {
                text = typeof result === 'string' ? result : JSON.stringify(result);
            } catch {
                text = String(result);
            }
            item.result = text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}…` : text;
        }
        entry.tools.push(item);
        // Live view: show each tool call as it happens, a cloud round can take seconds.
        this.publish(entry);
    }

    /** Record which states a call reads or writes (MCP `get_states`/`set_state`/`set_states`, routines). */
    stateAccess(tool: string, args: Record<string, unknown> | undefined): void {
        const entry = this.store.getStore();
        if (!entry || !args) {
            return;
        }
        if (tool === 'get_states' && Array.isArray(args.ids)) {
            for (const id of args.ids) {
                if (typeof id === 'string' && !entry.read.includes(id)) {
                    entry.read.push(id);
                }
            }
        } else if (tool === 'get_state' && typeof args.id === 'string') {
            if (!entry.read.includes(args.id)) {
                entry.read.push(args.id);
            }
        } else if (tool === 'set_state' && typeof args.id === 'string') {
            entry.written.push({ id: args.id, value: args.value });
        } else if (tool === 'set_states' && Array.isArray(args.states)) {
            for (const s of args.states as { id?: unknown; value?: unknown }[]) {
                if (typeof s?.id === 'string') {
                    entry.written.push({ id: s.id, value: s.value });
                }
            }
        }
    }

    /** Write pending changes now (on unload). */
    async flush(): Promise<void> {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        await this.save();
    }

    private publish(entry: JournalEntry): void {
        try {
            this.opts.onChange?.(entry);
        } catch {
            // a listener must never break the answer
        }
    }

    private prune(): void {
        const cutoff = Date.now() - this.opts.hours * 3600_000;
        let start = 0;
        while (start < this.entries.length && this.entries[start].ts < cutoff) {
            start++;
        }
        start = Math.max(start, this.entries.length - MAX_ENTRIES);
        if (start > 0) {
            for (const e of this.entries.slice(0, start)) {
                this.traces.delete(e.id);
                this.dirty.delete(e.id);
            }
            this.entries = this.entries.slice(start);
        }
        // Without a file the memory is all there is: keep as many as would be on disk.
        const keep = this.traceDir ? MEMORY_TRACES : MAX_TRACES;
        for (const id of this.traces.keys()) {
            if (this.traces.size <= keep) {
                break;
            }
            // Not written yet, or still being answered: needed until it is on disk.
            if ((!this.traceDir || !this.dirty.has(id)) && this.get(id)?.done !== false) {
                this.traces.delete(id);
            }
        }
    }

    private scheduleSave(): void {
        if (!this.opts.file || this.saveTimer) {
            return;
        }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.save();
        }, SAVE_DELAY_MS);
        this.saveTimer.unref?.();
    }

    private async save(): Promise<void> {
        if (!this.opts.file) {
            return;
        }
        try {
            await fs.mkdir(path.dirname(this.opts.file), { recursive: true });
            await fs.writeFile(this.opts.file, JSON.stringify(this.entries.filter(e => e.done)));
        } catch (e) {
            this.opts.log.warn(`Journal could not be saved: ${(e as Error).message}`);
        }
        await this.saveTraces();
        this.prune();
    }

    /** Write the traces that changed, and delete the files of requests that are no longer kept. */
    private async saveTraces(): Promise<void> {
        try {
            await fs.mkdir(this.traceDir, { recursive: true });
            for (const id of [...this.dirty]) {
                const steps = this.traces.get(id);
                this.dirty.delete(id);
                if (steps) {
                    await fs.writeFile(path.join(this.traceDir, `${id}.json`), JSON.stringify({ id, steps }));
                }
            }
            const keep = new Set(this.entries.slice(-MAX_TRACES).map(e => e.id));
            for (const name of await fs.readdir(this.traceDir)) {
                if (name.endsWith('.json') && !keep.has(name.slice(0, -5))) {
                    await fs.rm(path.join(this.traceDir, name), { force: true });
                }
            }
        } catch (e) {
            this.opts.log.warn(`Journal traces could not be saved: ${(e as Error).message}`);
        }
    }
}
