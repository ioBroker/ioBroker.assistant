/**
 * The adapter `pi-agent` as the cloud tier ("harness"): instead of running its own tool loop, the assistant
 * hands the question to a pi-agent instance via `sendTo(<instance>, 'ask', …)`. pi-agent stores every model
 * and tool call as a checkpoint before it runs (an interrupted request continues after a restart, a write is
 * never repeated), enforces its own write permissions and confirmations, and can use the system-wide AI
 * settings of admin — none of which the built-in `LlmAgent` does.
 *
 * Each request source (satellite, `chat`, `telegram:<user>`) gets a conversation of its own in pi-agent
 * (`conversation`), so two rooms do not see each other's follow-ups. The source-independent part of the
 * prompt (style, follow-up marker, memory, device list) goes along as the `instructions` of that
 * conversation; what changes every turn (time, weather, presence) is prepended to the question.
 * pi-agent 0.3.0 and older ignore both fields and answer everything in their root conversation.
 *
 * With "Confirmation by text in sendTo conversations", pi-agent answers a write it may not do unasked with a
 * question ending in `[[LISTEN]]`, and the next `ask` of the conversation is the yes or no. `language` makes it
 * ask that question in the language the satellite listens in.
 *
 * pi-agent 0.10.1+ also answers with `language`, the language it wrote the answer in; the voice that speaks the
 * answer is chosen by it ({@link PiAgentHarness.languageOf}).
 */

import type { ImageInput } from './media';

/** Longest instructions pi-agent accepts for a conversation; anything beyond is cut there. */
export const PI_AGENT_MAX_INSTRUCTIONS = 20000;

/** Default for `piAgentTimeoutSec`: a tool loop with several reads can take a while. */
export const PI_AGENT_TIMEOUT_SEC = 60;

/** The part of the adapter this module needs (kept small so tests can fake it). */
export interface PiAgentHost {
    sendToAsync(instance: string, command: string, message: unknown, options?: { timeout?: number }): Promise<unknown>;
    getForeignStateAsync(id: string): Promise<ioBroker.State | null | undefined>;
}

export interface PiAgentRequest {
    /** The text pi-agent answers: context lines + the question. */
    text: string;
    /** Conversation of the caller, e.g. the satellite name. */
    conversation: string;
    /** Instructions of that conversation. */
    instructions: string;
    /**
     * Language the user speaks, e.g. `ru`. pi-agent asks its questions to confirm in it; older versions ask in the
     * system language, and a satellite listening in Russian does not hear a German "Ja" (the STT returns nothing).
     */
    language?: string;
    /**
     * Pictures that came with the question (`{ data: base64, mimeType }`, the form of pi-ai's `ImageContent`).
     * Versions of pi-agent before image support ignore them; the text then says that pictures came along.
     */
    images?: ImageInput[];
    /**
     * Only for a request from a voice satellite: its id under `assistant.N.satellites.*`, and the full id of its `tts`
     * state. Writing text there speaks it on that satellite — so pi-agent can answer later where it was asked (a
     * reminder, the end of a background task). Chat and Telegram requests have neither.
     */
    satellite?: string;
    tts?: string;
}

/**
 * Join instruction blocks, leaving out optional ones from the end until the result fits into pi-agent's
 * limit — pi-agent would cut the text in the middle, and a half device list is worse than none.
 *
 * @param required blocks that always go along (style, follow-up marker)
 * @param optional blocks in order of importance (memory before the device list)
 */
export function composeInstructions(required: string[], optional: string[]): { text: string; dropped: number } {
    const blocks = [...required.filter(Boolean)];
    const extra = optional.filter(Boolean);
    let dropped = 0;
    while (extra.length) {
        const text = [...blocks, ...extra].join('\n\n');
        if (text.length <= PI_AGENT_MAX_INSTRUCTIONS) {
            return { text, dropped };
        }
        extra.pop();
        dropped++;
    }
    return { text: blocks.join('\n\n').slice(0, PI_AGENT_MAX_INSTRUCTIONS), dropped };
}

/** Conversation name for a request source; pi-agent uses "/" as separator in its keys. */
export function conversationOf(source: string): string {
    return (source || 'default').replace(/\//g, '_').slice(0, 100);
}

/** How many answers {@link PiAgentHarness.languageOf} remembers. */
const KEPT_LANGUAGES = 50;

export class PiAgentHarness {
    private seq = 0;
    /** Language pi-agent reported per answer text (pi-agent 0.10.1+), for the voice that speaks it. */
    private readonly languages = new Map<string, string>();

    public constructor(
        private readonly host: PiAgentHost,
        /** e.g. `pi-agent.0` */
        public readonly instance: string,
        private readonly timeoutMs: number = PI_AGENT_TIMEOUT_SEC * 1000,
    ) {}

    /**
     * Ask pi-agent. Fails fast when the instance is not running (otherwise the caller would wait for the whole
     * timeout), and turns pi-agent's `{error}` into an exception so the caller can fall back to the local model.
     */
    public async ask(req: PiAgentRequest): Promise<string> {
        const alive = await this.host.getForeignStateAsync(`system.adapter.${this.instance}.alive`);
        if (!alive?.val) {
            throw new Error(`${this.instance} is not running`);
        }
        // Unique per request: pi-agent answers a repeated requestId only once.
        const requestId = `assistant-${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
        const result = (await this.host.sendToAsync(
            this.instance,
            'ask',
            {
                text: req.text,
                conversation: conversationOf(req.conversation),
                instructions: req.instructions,
                ...(req.language ? { language: req.language } : {}),
                ...(req.images?.length ? { images: req.images } : {}),
                ...(req.satellite ? { satellite: req.satellite } : {}),
                ...(req.tts ? { tts: req.tts } : {}),
                requestId,
            },
            { timeout: this.timeoutMs },
        )) as { answer?: unknown; error?: unknown; language?: unknown } | null | undefined;
        if (result?.error) {
            const error = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
            throw new Error(`${this.instance}: ${error}`);
        }
        const answer = typeof result?.answer === 'string' ? result.answer.trim() : '';
        if (!answer) {
            throw new Error(`${this.instance} gave no answer`);
        }
        const language = typeof result?.language === 'string' ? result.language.trim().toLowerCase() : '';
        if (/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(language)) {
            this.languages.delete(answer);
            this.languages.set(answer, language);
            if (this.languages.size > KEPT_LANGUAGES) {
                this.languages.delete(this.languages.keys().next().value as string);
            }
        }
        return answer;
    }

    /**
     * The language pi-agent wrote an answer in (`ru`, `de` …), '' when it did not say (older pi-agent, or the model
     * left its mark out). The answer travels as plain text through the tiers; this finds its language again by text.
     */
    public languageOf(answer: string): string {
        return this.languages.get(answer.trim()) || '';
    }
}
