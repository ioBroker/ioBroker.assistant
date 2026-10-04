/**
 * Pending questions — the other direction of a conversation: the adapter asks and waits for the answer.
 *
 * Everywhere else the user starts the exchange. Here a script, a timer or (later) a trigger asks
 * something ("The fryer has been on for 5 hours. Shall I switch it off?") and the *next* utterance from
 * that source is the answer: it must not go to the NLU or the LLM, which would treat a bare "yes" as a
 * command and swallow it.
 *
 * A question is armed for one or more **sources** — the same key the answer pipeline sees: a satellite's
 * device name, `'chat'`, `'telegram:<user>'`, … — or for {@link ANY_SOURCE} when it was broadcast and
 * whoever hears it may answer. If nothing arrives within the timeout the promise resolves with `null`,
 * so a question can never block the pipeline for good.
 */

/** Key for a question that any source may answer (a broadcast question). */
export const ANY_SOURCE = '*';

/** Default time to wait for an answer before giving up. */
export const ASK_TIMEOUT_MS = 60_000;

interface Entry {
    keys: string[];
    question: string;
    asked: number;
    timer: NodeJS.Timeout | null;
    done: boolean;
    settle: (answer: string | null) => void;
}

/** One open question, for logging and diagnostics. */
export interface PendingInfo {
    question: string;
    /** Sources that may answer it (`'*'` = any). */
    keys: string[];
    /** When it was asked (ms epoch). */
    asked: number;
}

export class PendingQuestions {
    /** Every armed key points at its entry; several keys can share one (a question asked in two rooms). */
    private readonly byKey = new Map<string, Entry>();

    constructor(private readonly defaultTimeoutMs = ASK_TIMEOUT_MS) {}

    /**
     * Arm `question` for `keys` (empty → {@link ANY_SOURCE}) and resolve with the first answer from one of
     * them, or with `null` on timeout. Arming a key that already holds a question cancels that older one:
     * the newest question is the one the user just heard, so it has to be the one that wins.
     */
    ask(keys: string[], question: string, timeoutMs?: number): Promise<string | null> {
        const unique = [...new Set(keys.map(k => String(k ?? '').trim()).filter(Boolean))];
        if (!unique.length) {
            unique.push(ANY_SOURCE);
        }
        for (const key of unique) {
            this.cancel(key);
        }
        return new Promise<string | null>(resolve => {
            const entry: Entry = {
                keys: unique,
                question,
                asked: Date.now(),
                timer: null,
                done: false,
                settle: resolve,
            };
            // Deliberately not unref'd: the timeout is what releases the caller, so it has to fire. It is
            // cleared on an answer, on cancel, and by cancelAll() on unload, so nothing is held for long.
            entry.timer = setTimeout(() => this.finish(entry, null), timeoutMs ?? this.defaultTimeoutMs);
            for (const key of unique) {
                this.byKey.set(key, entry);
            }
        });
    }

    /**
     * Consume an utterance as the answer to an open question. Returns true when it was taken — the caller
     * must then stop processing it. Blank text is never an answer (a dropped utterance would otherwise
     * silently satisfy the question).
     */
    deliver(source: string, text: string): boolean {
        if (!String(text ?? '').trim()) {
            return false;
        }
        const entry = this.find(source);
        if (!entry) {
            return false;
        }
        this.finish(entry, text);
        return true;
    }

    /** Whether an open question would take the next utterance from `source`. */
    has(source: string): boolean {
        return !!this.find(source);
    }

    /** The open question `source` is expected to answer, if any (for logs). */
    question(source: string): string {
        return this.find(source)?.question ?? '';
    }

    /** Give up on the question armed for `key` (resolves it with `null`). */
    cancel(key: string): boolean {
        const entry = this.byKey.get(key);
        if (!entry) {
            return false;
        }
        this.finish(entry, null);
        return true;
    }

    /** Give up on every open question — on unload, so no caller is left hanging. */
    cancelAll(): void {
        for (const entry of [...new Set(this.byKey.values())]) {
            this.finish(entry, null);
        }
        this.byKey.clear();
    }

    /** All open questions (one entry per question, not per key). */
    list(): PendingInfo[] {
        return [...new Set(this.byKey.values())].map(e => ({
            question: e.question,
            keys: [...e.keys],
            asked: e.asked,
        }));
    }

    /** The entry responsible for `source`: armed for it by name, else the broadcast one. */
    private find(source: string): Entry | undefined {
        const key = String(source ?? '').trim();
        return (key ? this.byKey.get(key) : undefined) ?? this.byKey.get(ANY_SOURCE);
    }

    private finish(entry: Entry, answer: string | null): void {
        if (entry.done) {
            return;
        }
        entry.done = true;
        if (entry.timer) {
            clearTimeout(entry.timer);
            entry.timer = null;
        }
        for (const key of entry.keys) {
            // Only drop keys still pointing here — a newer question may already have taken one over.
            if (this.byKey.get(key) === entry) {
                this.byKey.delete(key);
            }
        }
        entry.settle(answer);
    }
}
