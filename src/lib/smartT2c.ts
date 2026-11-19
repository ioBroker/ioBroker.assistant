/**
 * The adapter smart-text2command (oweitman) as the device-command tier, instead of the built-in rules
 * (`nluEngine: 'smart-text2command'`). It understands a command with a trained NLP model (NLP.js), runs only the
 * actions the admin approved there, and asks back when the room, the device or the value is unclear. The assistant
 * calls it with `sendTo(<instance>, 'processText', {requestId, sessionId, language, text, mode:'execute'})`
 * (its `documentation/SENDTO_API.md`).
 *
 * What it does not understand (`rejected`: unclear intent, unknown room, a device it has not approved …) goes on to
 * the local and the cloud model, as if it had not been asked. A question it asks is kept per request source: the next
 * utterance of that source goes to it first, as the answer (`clarificationId`). Its own limit for an open question is
 * five minutes, kept here too, so an answer to a question it has forgotten is not sent as one.
 */

import { createHash, randomUUID } from 'node:crypto';

/** Default wait for its answer: the NLP model runs locally, so this only matters when it hangs. */
export const SMART_T2C_TIMEOUT_MS = 10_000;

/** How long smart-text2command keeps a question open (its own limit). */
export const T2C_QUESTION_MS = 5 * 60_000;

/** Its intents that write (the confirmation tone is played instead of their sentence). */
const WRITE_INTENTS = new Set([
    'device.turnOn',
    'device.turnOff',
    'device.setLevel',
    'device.setTemperature',
    'device.setValue',
    'device.press',
]);

/** Ids it accepts for requestId/sessionId/clarificationId. */
const ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;

export interface T2cAction {
    deviceId?: string;
    stateId?: string;
    /** `planned` | `accepted` (a write was handed over) | `confirmed` (a value was read) | `rejected` | `failed` */
    status?: string;
    value?: unknown;
    message?: string;
}

/** Its `CommandResult`, or `{error}` from its message router. */
export interface T2cResult {
    requestId?: string;
    status?: 'success' | 'clarification' | 'cancelled' | 'rejected' | 'error';
    language?: string;
    intent?: string;
    confidence?: number;
    /** Text to show or speak */
    response?: string;
    errorCode?: string;
    clarification?: {
        id?: string;
        key?: string;
        parameter?: string;
        options?: { id: string; label: string }[];
    };
    actions?: T2cAction[];
    durationMs?: number;
    error?: string;
}

/** What the assistant does with an answer of smart-text2command. */
export type T2cOutcome =
    /** It handled the request: say `text`. `control` = a write command that was handed over, nothing to tell. */
    | { kind: 'answer'; text: string; control: boolean; result: T2cResult }
    /** It asks back: say `text` and send the next utterance of the source to it as the answer. */
    | { kind: 'question'; text: string; result: T2cResult }
    /** Not for it: the request goes on to the next tier. */
    | { kind: 'pass'; reason: string; result?: T2cResult };

/** The part of the adapter this module needs (kept small so tests can fake it). */
export interface SmartT2cHost {
    sendToAsync(instance: string, command: string, message: unknown, options?: { timeout?: number }): Promise<unknown>;
    getForeignStateAsync(id: string): Promise<ioBroker.State | null | undefined>;
}

/**
 * Session of a request source for smart-text2command: it allows only `A–Z a–z 0–9 . _ : -`. A source with other
 * characters ("telegram:Denis Haev", a Cyrillic satellite name) gets a short hash, so two of them do not share one.
 */
export function t2cSessionId(source: string): string {
    const raw = source || 'default';
    if (ID_RE.test(raw)) {
        return raw;
    }
    const hash = createHash('sha1').update(raw).digest('hex').slice(0, 8);
    const readable = raw.replace(/[^A-Za-z0-9._:-]+/g, '_').replace(/^_+|_+$/g, '');
    return `${readable.slice(0, 90)}${readable ? '-' : ''}${hash}`;
}

/**
 * What an answer of smart-text2command means for the pipeline (see {@link T2cOutcome}). Everything it rejects goes
 * on; an error after it tried is said (a write may have happened, the model must not repeat it), an internal error
 * before that goes on.
 */
export function interpretT2cResult(raw: unknown): T2cOutcome {
    let result = raw as T2cResult | null | undefined;
    // the reply as the callback of `sendTo` sees it, or wrapped once more (as its documentation shows it)
    if (result && typeof result === 'object' && !('status' in result) && 'message' in result) {
        const inner = (result as { message?: unknown }).message;
        if (inner && typeof inner === 'object') {
            result = inner;
        }
    }
    if (!result || typeof result !== 'object') {
        return { kind: 'pass', reason: 'no answer' };
    }
    const text = typeof result.response === 'string' ? result.response.trim() : '';
    switch (result.status) {
        case 'success':
            return {
                kind: 'answer',
                text,
                control:
                    WRITE_INTENTS.has(result.intent || '') &&
                    !!result.actions?.length &&
                    result.actions.every(a => a.status === 'accepted'),
                result,
            };
        case 'cancelled':
            return { kind: 'answer', text, control: false, result };
        case 'clarification':
            // The reply did not fit the question: it would ask the same again. Taken as a new request instead — over
            // voice the user has usually moved on, and the next tiers see the question in the conversation context.
            if (result.errorCode === 'INVALID_SELECTION') {
                return { kind: 'pass', reason: 'the reply does not fit its question', result };
            }
            if (typeof result.clarification?.id === 'string' && ID_RE.test(result.clarification.id) && text) {
                return { kind: 'question', text, result };
            }
            return text
                ? { kind: 'answer', text, control: false, result }
                : { kind: 'pass', reason: 'a question without text', result };
        case 'rejected':
            return { kind: 'pass', reason: result.errorCode || 'rejected', result };
        case 'error':
            if (!text || !result.errorCode || result.errorCode === 'PROCESSING_ERROR') {
                return { kind: 'pass', reason: result.errorCode || 'error', result };
            }
            return { kind: 'answer', text, control: false, result };
        default:
            return {
                kind: 'pass',
                reason: typeof result.error === 'string' && result.error ? result.error : 'unexpected answer',
                result,
            };
    }
}

export class SmartText2Command {
    /** Per request source: the question smart-text2command asked last and when. */
    private readonly questions = new Map<string, { id: string; at: number }>();
    /** Languages it refused ("Unsupported language"): not asked again for them until the adapter restarts. */
    private readonly refusedLanguages = new Set<string>();

    public constructor(
        private readonly host: SmartT2cHost,
        /** e.g. `smart-text2command.0` */
        public readonly instance: string,
        private readonly timeoutMs: number = SMART_T2C_TIMEOUT_MS,
        private readonly now: () => number = Date.now,
    ) {}

    /** Whether smart-text2command waits for an answer of this source. */
    public hasQuestion(source: string): boolean {
        const open = this.questions.get(source);
        if (open && this.now() - open.at > T2C_QUESTION_MS) {
            this.questions.delete(source);
            return false;
        }
        return !!open;
    }

    /** Forget its open question for this source (the request went elsewhere). */
    public forget(source: string): void {
        this.questions.delete(source);
    }

    /**
     * A new request. Its open question for this source, if any, ends with it (smart-text2command does the same on
     * its side for a request without `clarificationId`).
     *
     * @param text the request
     * @param source the request source (satellite, `chat`, `telegram:<user>`)
     * @param language language of the request (`de`, `en`); a language it does not speak is not sent again
     */
    public async ask(text: string, source: string, language: string): Promise<T2cOutcome> {
        this.questions.delete(source);
        const lang = (language || '').toLowerCase().split(/[-_]/)[0];
        if (lang && this.refusedLanguages.has(lang)) {
            return { kind: 'pass', reason: `it does not understand '${lang}'` };
        }
        const outcome = await this.call(text, source, lang);
        if (outcome.kind === 'pass' && lang && /unsupported language/i.test(outcome.result?.error || '')) {
            this.refusedLanguages.add(lang);
            return { kind: 'pass', reason: `it does not understand '${lang}'`, result: outcome.result };
        }
        return outcome;
    }

    /**
     * The answer to its open question for this source. `pass` when there is none (any more) or the reply does not
     * fit — the caller then handles the text as a new request.
     */
    public async reply(text: string, source: string): Promise<T2cOutcome> {
        if (!this.hasQuestion(source)) {
            return { kind: 'pass', reason: 'no open question' };
        }
        const open = this.questions.get(source)!;
        this.questions.delete(source);
        // the language of the question applies (smart-text2command keeps it); the reply may be one word of any
        return this.call(text, source, '', open.id);
    }

    private async call(text: string, source: string, language: string, clarificationId?: string): Promise<T2cOutcome> {
        const alive = await this.host.getForeignStateAsync(`system.adapter.${this.instance}.alive`);
        if (!alive?.val) {
            return { kind: 'pass', reason: `${this.instance} is not running` };
        }
        let raw: unknown;
        try {
            raw = await this.host.sendToAsync(
                this.instance,
                'processText',
                {
                    // a new one per round: it answers a repeated id with the stored result
                    requestId: randomUUID(),
                    sessionId: t2cSessionId(source),
                    ...(language ? { language } : {}),
                    text: text.slice(0, 1000),
                    mode: 'execute',
                    ...(clarificationId ? { clarificationId } : {}),
                },
                { timeout: this.timeoutMs },
            );
        } catch (e) {
            return { kind: 'pass', reason: (e as Error).message || String(e) };
        }
        const outcome = interpretT2cResult(raw);
        if (outcome.kind === 'question') {
            this.questions.set(source, { id: outcome.result.clarification!.id!, at: this.now() });
        }
        return outcome;
    }
}
