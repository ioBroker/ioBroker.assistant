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
}

/** What the caller knows about a request before the pipeline starts. */
export interface JournalOrigin {
    transport?: JournalTransport;
    satellite?: string;
    room?: string;
    wakeWord?: string;
    sttMs?: number;
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

    constructor(private readonly opts: JournalOptions) {}

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
        this.scheduleSave();
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
        for (const key of ['satellite', 'room', 'wakeWord', 'sttMs'] as const) {
            if (origin[key] !== undefined && origin[key] !== '') {
                (entry as unknown as Record<string, unknown>)[key] = origin[key];
            }
        }
        // A satellite that re-opened its mic reports no wake word — say so instead of "unknown".
        if (origin.wakeWord === '') {
            entry.wakeWord = '';
        }
        this.entries.push(entry);
        this.publish(entry);
        try {
            const answer = await this.store.run(entry, fn);
            entry.answer = answer;
            return answer;
        } catch (e) {
            entry.error = (e as Error).message;
            throw e;
        } finally {
            entry.done = true;
            entry.ms = Date.now() - entry.ts;
            this.publish(entry);
            this.prune();
            this.scheduleSave();
        }
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
            this.entries = this.entries.slice(start);
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
    }
}
