/**
 * Short-term conversation memory, keyed by request source (e.g. 'chat', 'telegram:Max', a satellite
 * name). Lets the LLM resolve follow-ups like "…and the kitchen light too" or "turn it back off".
 * Each source is an independent thread; entries expire after a TTL so a new conversation starts fresh.
 */
export interface ConversationTurn {
    role: 'user' | 'assistant';
    content: string;
}

export class ConversationStore {
    private readonly map = new Map<string, { turns: ConversationTurn[]; ts: number }>();

    constructor(
        /** Keep at most this many turns (user+assistant messages) per source. */
        private readonly maxTurns = 6,
        /** Drop a thread after this idle time (ms). */
        private readonly ttlMs = 5 * 60 * 1000,
    ) {}

    /** Recent turns for a source (empty if none or expired). */
    get(source: string): ConversationTurn[] {
        const e = this.map.get(source);
        if (!e) {
            return [];
        }
        if (Date.now() - e.ts > this.ttlMs) {
            this.map.delete(source);
            return [];
        }
        return e.turns;
    }

    /** Append a completed exchange (question + answer) and cap/refresh the buffer. */
    add(source: string, user: string, assistant: string): void {
        if (!user || !assistant) {
            return;
        }
        const e = this.map.get(source) ?? { turns: [], ts: 0 };
        e.turns.push({ role: 'user', content: user }, { role: 'assistant', content: assistant });
        while (e.turns.length > this.maxTurns) {
            e.turns.shift();
        }
        e.ts = Date.now();
        this.map.set(source, e);
    }

    /** Reset one source (or all if omitted). */
    clear(source?: string): void {
        if (source === undefined) {
            this.map.clear();
        } else {
            this.map.delete(source);
        }
    }
}
