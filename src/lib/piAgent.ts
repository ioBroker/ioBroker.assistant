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
 */

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

export class PiAgentHarness {
    private seq = 0;

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
                requestId,
            },
            { timeout: this.timeoutMs },
        )) as { answer?: unknown; error?: unknown } | null | undefined;
        if (result?.error) {
            throw new Error(`${this.instance}: ${String(result.error)}`);
        }
        const answer = typeof result?.answer === 'string' ? result.answer.trim() : '';
        if (!answer) {
            throw new Error(`${this.instance} gave no answer`);
        }
        return answer;
    }
}
