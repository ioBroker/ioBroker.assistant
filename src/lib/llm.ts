import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { Tool } from './tools';

export interface LlmAgentOptions {
    provider: 'openai' | 'anthropic' | 'custom';
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

    public async ask(question: string): Promise<string> {
        return this.provider === 'anthropic' ? this.askAnthropic(question) : this.askOpenAI(question);
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
        const EXCLUDE = /embedding|whisper|tts|audio|dall-e|moderation|image|realtime|transcribe|search|davinci|babbage|codex/i;
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
            this.log.debug(`tool ${name}(${JSON.stringify(args)}) → ${JSON.stringify(result).slice(0, 300)}`);
            return result;
        } catch (e) {
            this.log.warn(`tool ${name} failed: ${(e as Error).message}`);
            return { error: (e as Error).message };
        }
    }

    // ── OpenAI (Chat Completions + function tools) ──────────────────────────
    private async askOpenAI(question: string): Promise<string> {
        const client = this.openai as OpenAI;
        const tools = this.tools.map(t => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.parameters },
        }));

        const messages: any[] = [];
        if (this.systemPrompt) {
            messages.push({ role: 'system', content: this.systemPrompt });
        }
        messages.push({ role: 'user', content: question });

        for (let round = 0; round < this.maxRounds; round++) {
            const resp: any = await client.chat.completions.create({
                model: this.model,
                messages,
                tools: tools.length ? tools : undefined,
                max_tokens: this.maxTokens,
            });
            const msg = resp.choices[0].message;
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

    // ── Anthropic (Messages API + tool_use) ─────────────────────────────────
    private async askAnthropic(question: string): Promise<string> {
        const client = this.anthropic as Anthropic;
        const tools = this.tools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters as Anthropic.Tool.InputSchema,
        }));

        const messages: any[] = [{ role: 'user', content: question }];

        for (let round = 0; round < this.maxRounds; round++) {
            const resp: any = await client.messages.create({
                model: this.model,
                max_tokens: this.maxTokens,
                system: this.systemPrompt || undefined,
                tools: tools.length ? tools : undefined,
                messages,
            });

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
