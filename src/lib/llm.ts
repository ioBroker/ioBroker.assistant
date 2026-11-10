import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { Tool } from './tools';
import { errorInfo, type JournalTokens, type TraceFn } from './journal';
import { redactImages, type ImageInput } from './media';

/** All selectable LLM providers. gemini/deepseek/openrouter/custom all use the OpenAI-compatible SDK path. */
export type Provider = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'openrouter' | 'custom';

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
    // OpenRouter names a model with its vendor in front
    openrouter: { sdk: 'openai', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4o-mini' },
    custom: { sdk: 'openai', baseUrl: '', defaultModel: '' },
};

/** OpenRouter shows the calling app in its statistics (same attribution as `@iobroker/ai-core`) */
export const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://www.iobroker.net', 'X-Title': 'ioBroker' };

/** Lowest `max_completion_tokens` sent to OpenAI (see {@link LlmAgent.openAiLimit}). */
const MIN_OPENAI_COMPLETION_TOKENS = 1024;

/** Reasoning effort of OpenAI reasoning models (`system.ai`); '' = the model's default. */
export type ReasoningEffort = '' | 'none' | 'minimal' | 'low' | 'medium' | 'high';

/**
 * `provider:model` of the reasoning models that take function tools on Chat Completions only with
 * `reasoning_effort: 'none'` — learned from their 400, so the next question does not fail first.
 */
const needEffortNone = new Set<string>();
/** `provider:model` of the models that take function tools only on the Responses API (not even with 'none'). */
const needResponsesApi = new Set<string>();
/** `provider:model` of the models that refuse the configured reasoning effort (no reasoning model, 'none' unknown …). */
const rejectsEffort = new Set<string>();

/** What {@link LlmAgent.chatWithFallback} gives back when the question has to go over the Responses API. */
const USE_RESPONSES_API = Symbol('use the Responses API');

/** An HTTP 400 of the API, if `pattern` is given one whose message or parameter matches it. */
function isBadRequest(e: unknown, pattern?: RegExp): boolean {
    const err = e as { status?: number; message?: string; param?: string } | null;
    return err?.status === 400 && (!pattern || pattern.test(`${err.param || ''} ${err.message || ''}`));
}

/** "Function tools with reasoning_effort are not supported for … in /v1/chat/completions." */
function rejectsToolsWithEffort(e: unknown): boolean {
    return isBadRequest(e, /reasoning_effort/i) && isBadRequest(e, /function tools/i);
}

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

/**
 * API key to use for `provider`: a local OpenAI-compatible server (the `custom` provider) usually has no
 * key at all, but the OpenAI SDK refuses to start without one — a placeholder goes into the
 * `Authorization` header, which such servers ignore. Empty for every other provider without a key.
 */
export function effectiveApiKey(provider: string | undefined, apiKey: string): string {
    return apiKey || (provider === 'custom' ? 'no-key' : '');
}

export interface LlmAgentOptions {
    provider: Provider;
    apiKey: string;
    model: string;
    baseUrl?: string;
    /** Only sent to OpenAI and the custom server; '' = the model's default */
    reasoningEffort?: ReasoningEffort;
    systemPrompt?: string;
    maxTokens?: number;
    tools: Tool[];
    log: ioBroker.Logger;
    /** Records the prompt and every round of {@link LlmAgent.ask} (the request journal's debug view). */
    trace?: TraceFn;
}

/** Normalised token counts of an OpenAI-compatible or Anthropic `usage` block. */
function tokensOf(usage: any): JournalTokens | undefined {
    if (!usage || typeof usage !== 'object') {
        return undefined;
    }
    if (usage.input_tokens !== undefined) {
        return {
            input: Number(usage.input_tokens) || 0,
            output: Number(usage.output_tokens) || 0,
            cacheRead: Number(usage.cache_read_input_tokens) || undefined,
            cacheWrite: Number(usage.cache_creation_input_tokens) || undefined,
        };
    }
    return {
        input: Number(usage.prompt_tokens) || 0,
        output: Number(usage.completion_tokens) || 0,
        cacheRead: Number(usage.prompt_tokens_details?.cached_tokens) || undefined,
    };
}

/** "Round 2 → get_states, set_state" or "Round 3 → answer" — the title of a round in the trace. */
function roundTitle(round: number, toolNames: string[]): string {
    return `Round ${round + 1} → ${toolNames.length ? toolNames.join(', ') : 'answer'}`;
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
    /** Configured model; empty means "ask the server" (see {@link ensureModel}). */
    private configuredModel: string;
    private modelLookup: Promise<string> | null = null;

    private readonly systemPrompt: string;
    private readonly maxTokens: number;
    private readonly tools: Tool[];
    private readonly toolMap: Record<string, Tool>;
    private readonly log: ioBroker.Logger;
    private readonly maxRounds = 6; // safety cap against tool-call loops
    /** Configured provider (gemini, deepseek, custom … — {@link provider} is only the SDK). */
    private readonly providerName: string;
    private readonly baseUrl: string;
    private readonly reasoningEffort: ReasoningEffort;
    private readonly trace?: TraceFn;

    private readonly openai?: OpenAI;
    private readonly anthropic?: Anthropic;

    constructor(opts: LlmAgentOptions) {
        this.provider = opts.provider === 'anthropic' ? 'anthropic' : 'openai';
        this.providerName = opts.provider || this.provider;
        this.baseUrl = opts.baseUrl || '';
        this.reasoningEffort = opts.reasoningEffort || '';
        this.trace = opts.trace;
        this.configuredModel = (opts.model || '').trim();
        this.systemPrompt = opts.systemPrompt || '';
        this.maxTokens = opts.maxTokens || 1024;
        this.tools = opts.tools || [];
        this.log = opts.log;
        this.toolMap = Object.fromEntries(this.tools.map(t => [t.name, t]));

        if (this.provider === 'anthropic') {
            this.anthropic = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl || undefined });
        } else {
            this.openai = new OpenAI({
                apiKey: opts.apiKey,
                baseURL: opts.baseUrl || undefined,
                defaultHeaders: opts.provider === 'openrouter' ? OPENROUTER_HEADERS : undefined,
            });
        }
    }

    /** The model requests go to — empty until {@link ensureModel} has looked it up, if none was configured. */
    public get model(): string {
        return this.configuredModel;
    }

    /**
     * Make sure there is a model to send. A local OpenAI-compatible server (Ollama, LM Studio, llama.cpp
     * server, …) is usually set up with the `custom` provider and no model typed in — and sending
     * `"model": ""` gets a 400 from the server ("unknown provider for model" and the like) that says
     * nothing about the real cause. So an empty model is looked up once from the server's `/models` list
     * (with one model loaded, that is the one), and a server that lists nothing gets a clear error.
     */
    private async ensureModel(): Promise<string> {
        if (this.configuredModel) {
            return this.configuredModel;
        }
        this.modelLookup ||= this.listModels()
            .then(models => {
                if (!models.length) {
                    throw new Error('no model configured and the server lists none');
                }
                this.configuredModel = models[0];
                this.log.info(
                    `No model configured — using "${models[0]}" from the server${
                        models.length > 1 ? ` (available: ${models.join(', ')})` : ''
                    }. Select a model in the adapter settings to choose another.`,
                );
                return models[0];
            })
            .catch(e => {
                this.modelLookup = null; // let the next request try again (server may still be starting)
                throw new Error(
                    `No model configured — select one in the adapter settings (lookup failed: ${(e as Error).message})`,
                );
            });
        return this.modelLookup;
    }

    /**
     * `systemPrompt` overrides the configured one for this call (e.g. to inject a device list).
     * `history` are prior turns (user/assistant) prepended so the model can resolve follow-ups.
     * `images` go with the question (a photo from Telegram); the model must be able to see.
     */
    public async ask(
        question: string,
        systemPrompt?: string,
        history: { role: 'user' | 'assistant'; content: string }[] = [],
        images: ImageInput[] = [],
    ): Promise<string> {
        await this.ensureModel();
        this.log.debug(
            `llm ask [${this.provider}/${this.model}] (${history.length} history${images.length ? `, ${images.length} picture(s)` : ''}): ${question}`,
        );
        const started = Date.now();
        const sys = systemPrompt ?? this.systemPrompt;
        this.trace?.({
            stage: 'cloud',
            title: `${this.providerName} · ${this.model}: ${this.tools.length} tools, ${history.length} earlier turn(s)`,
            data: {
                provider: this.providerName,
                sdk: this.provider,
                model: this.model,
                baseUrl: this.baseUrl || undefined,
                maxTokens: this.maxTokens,
                maxRounds: this.maxRounds,
                reasoningEffort: this.reasoningEffort || undefined,
                system: sys,
                tools: this.tools.map(t => t.name),
                images: images.length ? images.map(i => i.mimeType) : undefined,
            },
        });
        const answer =
            this.provider === 'anthropic'
                ? await this.askAnthropic(question, sys, history, images)
                : needResponsesApi.has(this.modelKey)
                  ? await this.askOpenAIResponses(question, sys, history, images)
                  : await this.askOpenAI(question, sys, history, images);
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
            // base64 of a picture would fill the whole excerpt
            text = JSON.stringify(redactImages(payload));
        } catch {
            text = String(payload);
        }
        this.log.debug(`${label}: ${text.length > max ? `${text.slice(0, max)}…[${text.length}]` : text}`);
    }

    /**
     * Token limit for an OpenAI-SDK request. OpenAI itself rejects `max_tokens` on newer (reasoning)
     * models and wants `max_completion_tokens`; the OpenAI-compatible providers (Gemini, DeepSeek,
     * OpenRouter, custom/Ollama …) keep `max_tokens`, which they may only know under that name.
     * Reasoning tokens count against `max_completion_tokens`, so the tiny limits of the side jobs
     * (classify 8, translate 64 …) would leave no room for the answer — OpenAI gets at least
     * {@link MIN_OPENAI_COMPLETION_TOKENS}.
     */
    private openAiLimit(tokens: number): Record<string, number> {
        if (this.providerName === 'openai') {
            return { max_completion_tokens: Math.max(tokens, MIN_OPENAI_COMPLETION_TOKENS) };
        }
        return { max_tokens: tokens };
    }

    /** Key of {@link needEffortNone}, {@link needResponsesApi} and {@link rejectsEffort}. */
    private get modelKey(): string {
        return `${this.providerName}:${this.model}`;
    }

    /** Only OpenAI and the custom server (often a proxy to OpenAI) get a reasoning effort. */
    private get sendsReasoning(): boolean {
        return this.providerName === 'openai' || this.providerName === 'custom';
    }

    /** `reasoning_effort` of a Chat Completions request with tools: 'none' if the model wants it for tools. */
    private openAiReasoning(): { reasoning_effort?: ReasoningEffort } {
        if (!this.sendsReasoning) {
            return {};
        }
        if (needEffortNone.has(this.modelKey)) {
            return { reasoning_effort: 'none' };
        }
        if (!this.reasoningEffort || rejectsEffort.has(this.modelKey)) {
            return {};
        }
        return { reasoning_effort: this.reasoningEffort };
    }

    /** A fallback of the request, in the log and as its own step of the trace. */
    private traceRetry(title: string, e: unknown): void {
        this.log.info(`${title}: ${(e as Error).message}`);
        this.trace?.({ stage: 'cloud', level: 'warn', title, data: { error: errorInfo(e) } });
    }

    /**
     * One prompt in, one line out — no tools, no history, no system prompt. The small side jobs
     * (translate/rephrase/classify) all run through here.
     */
    private async complete(prompt: string, maxTokens: number): Promise<string> {
        await this.ensureModel();
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
        const request: any = {
            model: this.model,
            ...this.openAiLimit(maxTokens),
            messages: [{ role: 'user', content: prompt }],
        };
        const resp: any = await client.chat.completions.create(request);
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
                    model: await this.ensureModel(),
                    max_tokens: 1,
                    messages: [{ role: 'user', content: 'ping' }],
                });
            } else {
                const client = this.openai as OpenAI;
                if (this.providerName === 'openrouter') {
                    // its model list is public and accepts any key; /key needs a valid one
                    await client.get('/key');
                } else {
                    await client.models.list();
                }
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

    /**
     * One model request of the tool loop, timed. A failure goes into the trace together with what was sent
     * (status, API error body, stack) before it is rethrown.
     */
    private async timedRound(
        round: number,
        sent: unknown[],
        call: () => Promise<any>,
    ): Promise<{ resp: any; ms: number }> {
        const start = Date.now();
        try {
            return { resp: await call(), ms: Date.now() - start };
        } catch (e) {
            this.trace?.({
                stage: 'cloud',
                level: 'error',
                title: `Round ${round + 1} failed: ${(e as Error).message}`,
                ms: Date.now() - start,
                data: { sent: redactImages(sent), error: errorInfo(e) },
            });
            throw e;
        }
    }

    private tooManyRounds(): string {
        this.trace?.({ stage: 'cloud', level: 'warn', title: `Gave up after ${this.maxRounds} rounds of tool calls` });
        return 'Ich konnte die Anfrage nicht abschließen (zu viele Tool-Schritte).';
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
        images: ImageInput[] = [],
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
        messages.push({ role: 'user', content: openAiUserContent(question, images) });
        // Messages the trace has shown already: the system prompt is part of the opening step.
        let shown = systemPrompt ? 1 : 0;

        for (let round = 0; round < this.maxRounds; round++) {
            const request: any = {
                model: this.model,
                messages,
                tools: tools.length ? tools : undefined,
                ...this.openAiLimit(this.maxTokens),
                ...this.openAiReasoning(),
            };
            this.dump(`llm → openai round ${round}`, request);
            const sent = messages.slice(shown);
            const { resp, ms } = await this.timedRound(round, sent, () =>
                this.chatWithFallback(client, request, round === 0),
            );
            if (resp === USE_RESPONSES_API) {
                return this.askOpenAIResponses(question, systemPrompt, history, images);
            }
            const msg = resp.choices[0].message;
            this.dump(`llm ← openai round ${round}`, { message: msg, usage: resp.usage });
            messages.push(msg);
            shown = messages.length;
            this.trace?.({
                stage: 'cloud',
                title: roundTitle(
                    round,
                    (msg.tool_calls || []).map((tc: any) => String(tc.function?.name)),
                ),
                ms,
                tokens: tokensOf(resp.usage),
                data: {
                    sent: redactImages(sent),
                    response: { finish_reason: resp.choices[0].finish_reason, message: msg },
                    model: resp.model,
                    usage: resp.usage,
                },
            });

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
        return this.tooManyRounds();
    }

    /**
     * One Chat Completions request. OpenAI reasoning models refuse function tools unless `reasoning_effort` is
     * 'none' ("Function tools with reasoning_effort are not supported …"): retried with 'none', and if the model
     * does not take that either, {@link USE_RESPONSES_API} says to ask over the Responses API instead — only in
     * the first round (`mayFallback`), so no tool runs twice. A model that refuses the effort itself (no
     * reasoning model) is asked again without it. Each model is remembered, so the next question goes the right
     * way at once.
     */
    private async chatWithFallback(client: OpenAI, request: any, mayFallback: boolean): Promise<any> {
        try {
            return await client.chat.completions.create(request);
        } catch (e) {
            if (!this.sendsReasoning || !isBadRequest(e, /reasoning_effort/i)) {
                throw e;
            }
            if (!rejectsToolsWithEffort(e)) {
                if (!request.reasoning_effort) {
                    throw e;
                }
                rejectsEffort.add(this.modelKey);
                this.traceRetry(
                    `${this.model} does not take reasoning_effort "${request.reasoning_effort}" — retrying without`,
                    e,
                );
                delete request.reasoning_effort;
                return this.chatWithFallback(client, request, mayFallback);
            }
            let error = e;
            if (request.reasoning_effort !== 'none') {
                needEffortNone.add(this.modelKey);
                this.traceRetry(`${this.model} refuses function tools with reasoning — retrying with "none"`, e);
                request.reasoning_effort = 'none';
                try {
                    return await client.chat.completions.create(request);
                } catch (e2) {
                    if (!isBadRequest(e2)) {
                        throw e2;
                    }
                    error = e2;
                }
            }
            if (!mayFallback) {
                throw error;
            }
            needEffortNone.delete(this.modelKey);
            needResponsesApi.add(this.modelKey);
            this.traceRetry(`${this.model} takes function tools only over the Responses API — switching`, error);
            return USE_RESPONSES_API;
        }
    }

    // ── OpenAI (Responses API + function tools, for reasoning models) ──────────
    private async askOpenAIResponses(
        question: string,
        systemPrompt: string,
        history: { role: 'user' | 'assistant'; content: string }[] = [],
        images: ImageInput[] = [],
    ): Promise<string> {
        const client = this.openai as OpenAI;
        // strict would demand schemas with every property required and no additional ones
        const tools = this.tools.map(t => ({
            type: 'function' as const,
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            strict: false,
        }));

        const input: any[] = [
            ...history.map(t => ({ role: t.role, content: t.content })),
            { role: 'user', content: openAiResponsesUserContent(question, images) },
        ];
        // Items the trace has shown already (the system prompt is part of the opening step).
        let shown = 0;

        for (let round = 0; round < this.maxRounds; round++) {
            const effort = this.sendsReasoning && !rejectsEffort.has(this.modelKey) ? this.reasoningEffort : '';
            const request: any = {
                model: this.model,
                instructions: systemPrompt || undefined,
                input,
                tools: tools.length ? tools : undefined,
                max_output_tokens: Math.max(this.maxTokens, MIN_OPENAI_COMPLETION_TOKENS),
                ...(effort ? { reasoning: { effort } } : {}),
                // nothing is kept at OpenAI: the reasoning items go back to the model encrypted
                store: false,
                include: ['reasoning.encrypted_content'],
            };
            this.dump(`llm → openai responses round ${round}`, request);
            const sent = input.slice(shown);
            const { resp, ms } = await this.timedRound(round, sent, () => this.responsesWithFallback(client, request));
            const output: any[] = resp.output || [];
            this.dump(`llm ← openai responses round ${round}`, { output, usage: resp.usage });
            const calls = output.filter(item => item.type === 'function_call');
            // the reasoning items too: the model continues its reasoning after the tool results
            input.push(...output);
            shown = input.length;
            this.trace?.({
                stage: 'cloud',
                title: roundTitle(
                    round,
                    calls.map(call => String(call.name)),
                ),
                ms,
                tokens: tokensOf(resp.usage),
                data: {
                    sent: redactImages(sent),
                    response: { status: resp.status, output },
                    model: resp.model,
                    usage: resp.usage,
                },
            });

            if (!calls.length) {
                return responsesText(resp);
            }

            for (const call of calls) {
                let args: Record<string, unknown> = {};
                try {
                    args = JSON.parse(call.arguments || '{}');
                } catch {
                    /* leave empty */
                }
                const result = await this.runTool(call.name, args);
                input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
            }
        }
        return this.tooManyRounds();
    }

    /** One Responses API request; a model that refuses the configured effort ('none' …) is asked again without. */
    private async responsesWithFallback(client: OpenAI, request: any): Promise<any> {
        try {
            return await client.responses.create(request);
        } catch (e) {
            if (!request.reasoning || !isBadRequest(e, /effort/i)) {
                throw e;
            }
            rejectsEffort.add(this.modelKey);
            this.traceRetry(
                `${this.model} does not take reasoning effort "${request.reasoning.effort}" — retrying without`,
                e,
            );
            delete request.reasoning;
            return client.responses.create(request);
        }
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
        images: ImageInput[] = [],
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
            { role: 'user', content: anthropicUserContent(question, images) },
        ];
        // Messages the trace has shown already (the system prompt is part of the opening step).
        let shown = 0;

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
            const sent = messages.slice(shown);
            const { resp, ms } = await this.timedRound(round, sent, () => client.messages.create(request));
            this.dump(`llm ← anthropic round ${round}`, { content: resp.content, usage: resp.usage });

            const toolUses = resp.content.filter((b: any) => b.type === 'tool_use');
            this.trace?.({
                stage: 'cloud',
                title: roundTitle(
                    round,
                    toolUses.map((b: any) => String(b.name)),
                ),
                ms,
                tokens: tokensOf(resp.usage),
                data: {
                    sent: redactImages(sent),
                    response: { stop_reason: resp.stop_reason, content: resp.content },
                    model: resp.model,
                    usage: resp.usage,
                },
            });
            if (!toolUses.length) {
                return resp.content
                    .filter((b: any) => b.type === 'text')
                    .map((b: any) => b.text)
                    .join('')
                    .trim();
            }

            messages.push({ role: 'assistant', content: resp.content });
            shown = messages.length;
            const toolResults = [];
            for (const tu of toolUses) {
                const result = await this.runTool(tu.name, tu.input);
                toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
            }
            messages.push({ role: 'user', content: toolResults });
        }
        return this.tooManyRounds();
    }
}

/**
 * The user turn of the OpenAI Chat Completions API (also Gemini, OpenRouter …): the plain question, or text and
 * pictures as data URLs.
 *
 * @param question the question
 * @param images pictures that came with it
 */
export function openAiUserContent(question: string, images: ImageInput[] = []): string | unknown[] {
    if (!images.length) {
        return question;
    }
    return [
        { type: 'text', text: question },
        ...images.map(i => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${i.data}` } })),
    ];
}

/**
 * The user turn of the OpenAI Responses API: the plain question, or text and pictures as data URLs.
 *
 * @param question the question
 * @param images pictures that came with it
 */
export function openAiResponsesUserContent(question: string, images: ImageInput[] = []): string | unknown[] {
    if (!images.length) {
        return question;
    }
    return [
        { type: 'input_text', text: question },
        ...images.map(i => ({
            type: 'input_image',
            detail: 'auto',
            image_url: `data:${i.mimeType};base64,${i.data}`,
        })),
    ];
}

/**
 * The text of a Responses API answer: the SDK's `output_text`, or the text parts of the output messages.
 *
 * @param resp the response
 */
function responsesText(resp: any): string {
    if (typeof resp.output_text === 'string') {
        return resp.output_text.trim();
    }
    return (resp.output || [])
        .filter((item: any) => item.type === 'message')
        .flatMap((item: any) => item.content || [])
        .filter((part: any) => part.type === 'output_text')
        .map((part: any) => part.text)
        .join('')
        .trim();
}

/**
 * The user turn of the Anthropic Messages API: the plain question, or the pictures first and then the text (what
 * Anthropic recommends).
 *
 * @param question the question
 * @param images pictures that came with it
 */
export function anthropicUserContent(question: string, images: ImageInput[] = []): string | unknown[] {
    if (!images.length) {
        return question;
    }
    return [
        ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.data } })),
        { type: 'text', text: question },
    ];
}
