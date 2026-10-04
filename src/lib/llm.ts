import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { Tool } from './tools';

/** All selectable LLM providers. gemini/deepseek/custom all use the OpenAI-compatible SDK path. */
export type Provider = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'custom';

interface ProviderPreset {
    /** Which vendor SDK to use. */
    sdk: 'openai' | 'anthropic';
    /** Fixed API base URL ('' = SDK default; for 'custom' the user's baseUrl is used instead). */
    baseUrl: string;
    /** Default model when none is configured. */
    defaultModel: string;
}

/** Per-provider SDK, endpoint and default model. Gemini/DeepSeek expose OpenAI-compatible endpoints. */
export const PROVIDER_PRESETS: Record<Provider, ProviderPreset> = {
    openai: { sdk: 'openai', baseUrl: '', defaultModel: 'gpt-4o-mini' },
    anthropic: { sdk: 'anthropic', baseUrl: '', defaultModel: 'claude-sonnet-4-6' },
    gemini: {
        sdk: 'openai',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        defaultModel: 'gemini-2.0-flash',
    },
    deepseek: { sdk: 'openai', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' },
    custom: { sdk: 'openai', baseUrl: '', defaultModel: '' },
};

/** Resolve the effective SDK, base URL and default model for a provider (custom uses `configBaseUrl`). */
export function resolveProvider(
    provider: string | undefined,
    configBaseUrl?: string,
): { sdk: 'openai' | 'anthropic'; baseUrl: string; defaultModel: string } {
    const preset = PROVIDER_PRESETS[(provider as Provider) || 'openai'] || PROVIDER_PRESETS.openai;
    return {
        sdk: preset.sdk,
        baseUrl: provider === 'custom' ? configBaseUrl || '' : preset.baseUrl,
        defaultModel: preset.defaultModel,
    };
}

export interface LlmAgentOptions {
    provider: Provider;
    apiKey: string;
    model: string;
    baseUrl?: string;
    systemPrompt?: string;
    maxTokens?: number;
    tools: Tool[];
    log: ioBroker.Logger;
}

/**
 * Provider-agnostic LLM agent with tool-calling.
 *
 * `ask(question)` runs the model, executes any tool calls it requests, feeds the
 * results back, and repeats until the model returns a final text answer.
 *
 * The request/response plumbing of the vendor SDKs is intentionally loosely typed
 * (`any`) so the code stays robust across minor SDK type changes; the public API
 * (options, `ask`, tools) is fully typed.
 */
export class LlmAgent {
    public readonly provider: 'openai' | 'anthropic';
    public readonly model: string;

    private readonly systemPrompt: string;
    private readonly maxTokens: number;
    private readonly tools: Tool[];
    private readonly toolMap: Record<string, Tool>;
    private readonly log: ioBroker.Logger;
    private readonly maxRounds = 6; // safety cap against tool-call loops

    private readonly openai?: OpenAI;
    private readonly anthropic?: Anthropic;

    constructor(opts: LlmAgentOptions) {
        this.provider = opts.provider === 'anthropic' ? 'anthropic' : 'openai';
        this.model = opts.model;
        this.systemPrompt = opts.systemPrompt || '';
        this.maxTokens = opts.maxTokens || 1024;
        this.tools = opts.tools || [];
        this.log = opts.log;
        this.toolMap = Object.fromEntries(this.tools.map(t => [t.name, t]));

        if (this.provider === 'anthropic') {
            this.anthropic = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl || undefined });
        } else {
            this.openai = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl || undefined });
        }
    }

    /**
     * `systemPrompt` overrides the configured one for this call (e.g. to inject a device list).
     * `history` are prior turns (user/assistant) prepended so the model can resolve follow-ups.
     */
    public async ask(
        question: string,
        systemPrompt?: string,
        history: { role: 'user' | 'assistant'; content: string }[] = [],
    ): Promise<string> {
        this.log.debug(`llm ask [${this.provider}/${this.model}] (${history.length} history): ${question}`);
        const started = Date.now();
        const sys = systemPrompt ?? this.systemPrompt;
        const answer =
            this.provider === 'anthropic'
                ? await this.askAnthropic(question, sys, history)
                : await this.askOpenAI(question, sys, history);
        this.log.debug(`llm answer (${Date.now() - started} ms): ${answer}`);
        return answer;
    }

    /** Compact, truncated JSON for debug logging of LLM requests/responses. */
    private dump(label: string, payload: unknown): void {
        if (this.log.level !== 'silly' && this.log.level !== 'debug') {
            return; // avoid stringifying large payloads when debug logging is off
        }
        const max = this.log.level === 'silly' ? 8000 : 1500;
        let text: string;
        try {
            text = JSON.stringify(payload);
        } catch {
            text = String(payload);
        }
        this.log.debug(`${label}: ${text.length > max ? `${text.slice(0, max)}…[${text.length}]` : text}`);
    }

    /**
     * One prompt in, one line out — no tools, no history, no system prompt. The small side jobs
     * (translate/rephrase/classify) all run through here.
     */
    private async complete(prompt: string, maxTokens: number): Promise<string> {
        if (this.provider === 'anthropic') {
            const client = this.anthropic as Anthropic;
            const resp: any = await client.messages.create({
                model: this.model,
                max_tokens: maxTokens,
                messages: [{ role: 'user', content: prompt }],
            });
            return resp.content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join('')
                .trim();
        }
        const client = this.openai as OpenAI;
        const resp: any = await client.chat.completions.create({
            model: this.model,
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: prompt }],
        });
        return String(resp.choices[0].message.content || '').trim();
    }

    /** Translate a short device/room name into `targetLanguage` (single completion, no tools). */
    public async translate(text: string, targetLanguage: string): Promise<string> {
        const trimmed = (text || '').trim();
        if (!trimmed) {
            return '';
        }
        return this.complete(
            `Translate the following smart-home device or room name into ${targetLanguage}. ` +
                `Reply with ONLY the translation — no quotes, no punctuation, no explanation.\n\nName: ${trimmed}`,
            64,
        );
    }

    /**
     * Reword a canned sentence (a trigger's announcement or question) so it sounds spoken rather than
     * templated, keeping every concrete detail. `persona` is the adapter's system prompt, so the reworded
     * line still sounds like the same assistant. Returns the input unchanged on any problem — a trigger
     * must still fire when the model is unavailable.
     */
    public async rephrase(text: string, language: string, persona = ''): Promise<string> {
        const trimmed = (text || '').trim();
        if (!trimmed) {
            return '';
        }
        try {
            const result = await this.complete(
                `${persona ? `${persona.trim()}\n\n` : ''}Reword the following sentence so it sounds natural and ` +
                    `spoken${language ? `, in ${language}` : ''}. Keep every concrete detail (names, numbers, ` +
                    `versions, times) and keep it one short sentence. If it is a question, keep it a question. ` +
                    `Reply with ONLY the sentence.\n\nSentence: ${trimmed}`,
                200,
            );
            return result || trimmed;
        } catch (e) {
            this.log.warn(`rephrase failed, using the original text: ${(e as Error).message}`);
            return trimmed;
        }
    }

    /**
     * Reword an ioBroker system notification into one spoken sentence, in the given `tone` (see
     * `notifications.toneFor`). Separate from {@link rephrase} because of the hints below: they are
     * specific to how ioBroker words its notifications, and each one comes from a real text that was
     * read out wrongly — version numbers mistaken for dates, origin prefixes spelled out letter by
     * letter, an empty `{}` announced as a problem. Returns the input unchanged on any failure.
     */
    public async rewordNotification(text: string, tone: string, language: string, persona = ''): Promise<string> {
        const trimmed = (text || '').trim();
        if (!trimmed) {
            return '';
        }
        try {
            const result = await this.complete(
                `${persona ? `${persona.trim()}\n\n` : ''}Reword the following system notification into one ` +
                    `short, natural, spoken sentence${language ? `, in ${language}` : ''}. ` +
                    `Keep every concrete detail such as adapter names and version numbers. ` +
                    `Dates like M/D/YYYY or M/D/YYYY, H:MM:SS AM/PM are timestamps — say them as a date or ` +
                    `a time, never as a version number. Technical prefixes such as ` +
                    `"system.host.XYZ: adapter.0:" only say where it came from and need not be repeated. ` +
                    `Empty values such as "onedrive: {}" mean there is nothing wrong there — only mention ` +
                    `them if it matters. ${tone} Reply with ONLY the sentence.\n\nNotification: ${trimmed}`,
                300,
            );
            return result || trimmed;
        } catch (e) {
            this.log.warn(`notification rewording failed, speaking the original: ${(e as Error).message}`);
            return trimmed;
        }
    }

    /**
     * Does `answer` express `category` ("agreement", "Zustimmung", "refusal", …)? This is the classifier
     * behind a trigger's response rules, where a spoken "ja, mach das" has to map onto one rule. Decided
     * by the model because the wording is open-ended; a failure answers `false`, so an unclassifiable
     * reply falls through to the trigger's fallback rule instead of acting on a guess.
     */
    public async classify(answer: string, category: string): Promise<boolean> {
        const text = (answer || '').trim();
        const want = (category || '').trim();
        if (!text || !want) {
            return false;
        }
        try {
            const verdict = await this.complete(
                `Does the following reply express "${want}"? Consider the meaning, in any language, ` +
                    `including short or indirect phrasings. Answer with exactly YES or NO.\n\nReply: ${text}`,
                8,
            );
            return /^\s*(yes|ja|да)\b/i.test(verdict);
        } catch (e) {
            this.log.warn(`classify failed ('${want}'): ${(e as Error).message}`);
            return false;
        }
    }

    /** Lightweight validation of the provider credentials (used by the settings Test button). */
    public async testConnection(): Promise<{ ok: boolean; error?: string }> {
        try {
            if (this.provider === 'anthropic') {
                const client = this.anthropic as Anthropic;
                await client.messages.create({
                    model: this.model,
                    max_tokens: 1,
                    messages: [{ role: 'user', content: 'ping' }],
                });
            } else {
                const client = this.openai as OpenAI;
                await client.models.list();
            }
            return { ok: true };
        } catch (e) {
            return { ok: false, error: (e as Error).message };
        }
    }

    /** List the provider's available model ids (for the settings autocomplete). */
    public async listModels(): Promise<string[]> {
        if (this.provider === 'anthropic') {
            const client = this.anthropic as Anthropic;
            const res = (await client.models.list()) as unknown as { data?: { id: string }[] };
            return (res.data || []).map(m => m.id);
        }
        const client = this.openai as OpenAI;
        const res = (await client.models.list()) as unknown as { data?: { id: string }[] };
        // OpenAI lists many non-chat models (embeddings, tts, whisper, …) — filter to chat-capable-ish.
        const EXCLUDE =
            /embedding|whisper|tts|audio|dall-e|moderation|image|realtime|transcribe|search|davinci|babbage|codex/i;
        return (res.data || [])
            .map(m => String(m.id))
            .filter(id => !EXCLUDE.test(id))
            .sort();
    }

    private async runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        const tool = this.toolMap[name];
        if (!tool) {
            return { error: `unknown tool: ${name}` };
        }
        try {
            const result = await tool.run(args || {});
            this.log.info(`tool ${name}(${JSON.stringify(args)}) → ${JSON.stringify(result).slice(0, 200)}`);
            return result;
        } catch (e) {
            this.log.warn(`tool ${name} failed: ${(e as Error).message}`);
            return { error: (e as Error).message };
        }
    }

    // ── OpenAI (Chat Completions + function tools) ──────────────────────────
    private async askOpenAI(
        question: string,
        systemPrompt: string,
        history: { role: 'user' | 'assistant'; content: string }[] = [],
    ): Promise<string> {
        const client = this.openai as OpenAI;
        const tools = this.tools.map(t => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.parameters },
        }));

        const messages: any[] = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        for (const t of history) {
            messages.push({ role: t.role, content: t.content });
        }
        messages.push({ role: 'user', content: question });

        for (let round = 0; round < this.maxRounds; round++) {
            const request = {
                model: this.model,
                messages,
                tools: tools.length ? tools : undefined,
                max_tokens: this.maxTokens,
            };
            this.dump(`llm → openai round ${round}`, request);
            const resp: any = await client.chat.completions.create(request);
            const msg = resp.choices[0].message;
            this.dump(`llm ← openai round ${round}`, { message: msg, usage: resp.usage });
            messages.push(msg);

            if (!msg.tool_calls || !msg.tool_calls.length) {
                return String(msg.content || '').trim();
            }

            for (const tc of msg.tool_calls) {
                let args: Record<string, unknown> = {};
                try {
                    args = JSON.parse(tc.function.arguments || '{}');
                } catch {
                    /* leave empty */
                }
                const result = await this.runTool(tc.function.name, args);
                messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
            }
        }
        return 'Ich konnte die Anfrage nicht abschließen (zu viele Tool-Schritte).';
    }

    /**
     * Keep a single cache breakpoint on the last content block of the last message (Anthropic allows
     * ≤4 total; we also mark system + last tool). Strips prior message breakpoints so we never exceed it.
     */
    private markLastMessageForCache(messages: any[]): void {
        for (const m of messages) {
            if (Array.isArray(m.content)) {
                for (const b of m.content) {
                    if (b && typeof b === 'object') {
                        delete b.cache_control;
                    }
                }
            }
        }
        const last = messages[messages.length - 1];
        if (!last) {
            return;
        }
        if (typeof last.content === 'string') {
            last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
        } else if (Array.isArray(last.content) && last.content.length) {
            const b = last.content[last.content.length - 1];
            if (b && typeof b === 'object') {
                b.cache_control = { type: 'ephemeral' };
            }
        }
    }

    // ── Anthropic (Messages API + tool_use) ─────────────────────────────────
    private async askAnthropic(
        question: string,
        systemPrompt: string,
        history: { role: 'user' | 'assistant'; content: string }[] = [],
    ): Promise<string> {
        const client = this.anthropic as Anthropic;
        const tools: any[] = this.tools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters as Anthropic.Tool.InputSchema,
        }));
        // Prompt caching: mark the last tool → the static prefix (system + all tools) is cached and
        // read back on every later round/request (5-min TTL), cutting latency & cost on the big context.
        if (tools.length) {
            tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: 'ephemeral' } };
        }
        const system: any = systemPrompt
            ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
            : undefined;

        const messages: any[] = [
            ...history.map(t => ({ role: t.role, content: t.content })),
            { role: 'user', content: question },
        ];

        for (let round = 0; round < this.maxRounds; round++) {
            // Cache the growing conversation prefix too (e.g. the large list_devices result): move a
            // single cache breakpoint to the last content block of the last message each round.
            this.markLastMessageForCache(messages);
            const request = {
                model: this.model,
                max_tokens: this.maxTokens,
                system,
                tools: tools.length ? tools : undefined,
                messages,
            };
            this.dump(`llm → anthropic round ${round}`, request);
            const resp: any = await client.messages.create(request);
            this.dump(`llm ← anthropic round ${round}`, { content: resp.content, usage: resp.usage });

            const toolUses = resp.content.filter((b: any) => b.type === 'tool_use');
            if (!toolUses.length) {
                return resp.content
                    .filter((b: any) => b.type === 'text')
                    .map((b: any) => b.text)
                    .join('')
                    .trim();
            }

            messages.push({ role: 'assistant', content: resp.content });
            const toolResults = [];
            for (const tu of toolUses) {
                const result = await this.runTool(tu.name, tu.input);
                toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
            }
            messages.push({ role: 'user', content: toolResults });
        }
        return 'Ich konnte die Anfrage nicht abschließen (zu viele Tool-Schritte).';
    }
}
