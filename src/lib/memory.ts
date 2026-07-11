/**
 * Long-term memory (roadmap #6) — durable facts the assistant remembers across sessions/restarts
 * ("meine Tochter heißt Lena", "das WLAN-Passwort steht im Flur"). Storage is ioBroker-first: this store
 * holds the facts in memory and emits an `onChange` callback; `main.ts` mirrors them into `memory.*` states
 * (+ one editable object per entry) and, before each cloud-LLM call, injects them compactly into the system
 * prompt (retrieval = "inject all", capped — enough for the handful of household facts a home assistant
 * accumulates; semantic search can be added later without touching the storage format).
 *
 * The store itself is transport-agnostic and testable (CRUD + dedup + caps + persistence round-trip).
 */

/** One remembered fact. Plain data so it round-trips through JSON for persistence. */
export interface MemoryEntry {
    /** Short unique id (also the `memory.items.<id>` state-object segment). */
    id: string;
    /** The fact text. */
    text: string;
    /** Optional short key/topic ("tochter", "wlan") used for dedup and targeted forgetting; '' if none. */
    key: string;
    /** Where it came from (satellite / 'chat' / '' …), for context. */
    source: string;
    createdAt: number;
    updatedAt: number;
}

export interface MemoryStoreOptions {
    /** Called whenever the list changes (add/update/forget/clear/restore) with the new list. */
    onChange: (entries: MemoryEntry[]) => void;
    /** Max number of stored facts; the oldest (by updatedAt) are dropped past this. Default 100. */
    maxEntries?: number;
    /** Max characters per fact (longer is truncated). Default 500. */
    maxTextLength?: number;
    log?: Pick<ioBroker.Log, 'debug' | 'info' | 'warn'>;
    /** Injectable clock (tests). Defaults to `Date.now`. */
    now?: () => number;
}

/** In-memory long-term fact store with dedup, size caps and JSON persistence (no scheduling). */
export class MemoryStore {
    private readonly entries = new Map<string, MemoryEntry>();
    private seq = 0;
    private readonly now: () => number;
    private readonly maxEntries: number;
    private readonly maxTextLength: number;

    constructor(private readonly opts: MemoryStoreOptions) {
        this.now = opts.now || Date.now;
        this.maxEntries = opts.maxEntries ?? 100;
        this.maxTextLength = opts.maxTextLength ?? 500;
    }

    /**
     * Remember a fact. If `key` is given and already exists (or, without a key, an identical text exists),
     * the existing entry is updated instead of duplicated. Enforces the size cap by dropping the oldest.
     * Returns the stored entry, or null for empty text.
     */
    add(o: { text: string; key?: string; source?: string }): MemoryEntry | null {
        const text = (o.text || '').trim().slice(0, this.maxTextLength);
        if (!text) {
            return null;
        }
        const key = (o.key || '').trim().toLowerCase();
        const source = o.source || '';
        const now = this.now();

        // Dedup: same key, or (keyless) identical text → update in place.
        const existing = key
            ? [...this.entries.values()].find(e => e.key === key)
            : [...this.entries.values()].find(e => e.text.toLowerCase() === text.toLowerCase());
        if (existing) {
            existing.text = text;
            existing.source = source || existing.source;
            existing.updatedAt = now;
            this.emitChange();
            return existing;
        }

        const entry: MemoryEntry = { id: this.genId(now), text, key, source, createdAt: now, updatedAt: now };
        this.entries.set(entry.id, entry);
        this.enforceCap();
        this.opts.log?.debug(`memory added: ${entry.id}${key ? ` [${key}]` : ''} "${text}"`);
        this.emitChange();
        return entry;
    }

    /** Update an entry's text by id. Returns true if it existed. */
    update(id: string, text: string): boolean {
        const e = this.entries.get(id);
        if (!e) {
            return false;
        }
        const t = (text || '').trim().slice(0, this.maxTextLength);
        if (!t) {
            return this.forgetById(id);
        }
        e.text = t;
        e.updatedAt = this.now();
        this.emitChange();
        return true;
    }

    /** Forget entries matching an id or a key. Returns the number removed. */
    forget(idOrKey: string): number {
        const needle = (idOrKey || '').trim().toLowerCase();
        if (!needle) {
            return 0;
        }
        const victims = [...this.entries.values()].filter(
            e => e.id.toLowerCase() === needle || (e.key && e.key === needle),
        );
        for (const v of victims) {
            this.entries.delete(v.id);
        }
        if (victims.length) {
            this.emitChange();
        }
        return victims.length;
    }

    /** Remove exactly one entry by id (no key match). Returns true if it existed. */
    forgetById(id: string): boolean {
        if (!this.entries.delete(id)) {
            return false;
        }
        this.emitChange();
        return true;
    }

    /** Forget everything. Returns the number removed. */
    clear(): number {
        const n = this.entries.size;
        if (n) {
            this.entries.clear();
            this.emitChange();
        }
        return n;
    }

    /** All facts, newest-updated first. */
    list(): MemoryEntry[] {
        return [...this.entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    get(id: string): MemoryEntry | undefined {
        return this.entries.get(id);
    }

    size(): number {
        return this.entries.size;
    }

    /** Load persisted facts (replacing the current set). Returns how many were restored. */
    restore(list: MemoryEntry[]): number {
        this.entries.clear();
        let n = 0;
        for (const e of Array.isArray(list) ? list : []) {
            if (!e || typeof e.id !== 'string' || typeof e.text !== 'string' || !e.text.trim()) {
                continue;
            }
            this.entries.set(e.id, {
                id: e.id,
                text: e.text,
                key: e.key || '',
                source: e.source || '',
                createdAt: e.createdAt || this.now(),
                updatedAt: e.updatedAt || e.createdAt || this.now(),
            });
            n++;
        }
        this.enforceCap();
        this.emitChange();
        return n;
    }

    private enforceCap(): void {
        if (this.entries.size <= this.maxEntries) {
            return;
        }
        // Drop the oldest (least-recently-updated) until within the cap.
        const byAge = [...this.entries.values()].sort((a, b) => a.updatedAt - b.updatedAt);
        for (const e of byAge) {
            if (this.entries.size <= this.maxEntries) {
                break;
            }
            this.entries.delete(e.id);
        }
    }

    private genId(now: number): string {
        return `m${now.toString(36)}${(this.seq++).toString(36)}`;
    }

    private emitChange(): void {
        try {
            this.opts.onChange(this.list());
        } catch (e) {
            this.opts.log?.warn(`memory onChange failed: ${(e as Error).message}`);
        }
    }
}

/**
 * Compact system-prompt block of all remembered facts (retrieval = "inject all"), localized header. Returns
 * '' when there is nothing to inject. `budget` caps the number of characters to keep the prompt bounded.
 */
export function buildMemoryPrompt(entries: MemoryEntry[], lang: string, budget = 4000): string {
    if (!entries.length) {
        return '';
    }
    const header =
        lang === 'ru'
            ? 'Известные факты о пользователе/доме (используй их, если уместно; не выдумывай новые):'
            : lang === 'de'
              ? 'Bekannte Fakten über den Nutzer/Haushalt (nutze sie, wenn relevant; erfinde keine neuen):'
              : 'Known facts about the user/household (use them when relevant; do not invent new ones):';
    const lines: string[] = [];
    let used = header.length;
    for (const e of entries) {
        const line = `- ${e.text}`;
        if (used + line.length + 1 > budget) {
            break;
        }
        lines.push(line);
        used += line.length + 1;
    }
    return `${header}\n${lines.join('\n')}`;
}
