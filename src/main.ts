import { Adapter, type AdapterOptions } from '@iobroker/adapter-core';

import { LlmAgent } from './lib/llm';
import { createTools } from './lib/tools';
import type { AdapterConfig } from './types';

class Assistant extends Adapter {
    declare config: AdapterConfig;
    private agent: LlmAgent | null = null;

    public constructor(options: Partial<AdapterOptions> = {}) {
        super({ ...options, name: 'assistant' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        const cfg = this.config;

        if (!cfg.apiKey) {
            this.log.warn('No API key configured — open the adapter settings and enter your LLM API key.');
            await this.setStateAsync('info.connection', { val: false, ack: true });
            return;
        }

        try {
            this.agent = new LlmAgent({
                provider: cfg.provider || 'openai',
                apiKey: cfg.apiKey,
                model: cfg.model || (cfg.provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o-mini'),
                baseUrl: cfg.baseUrl || '',
                systemPrompt: cfg.systemPrompt || '',
                maxTokens: cfg.maxTokens || 1024,
                tools: createTools(this, this.config),
                log: this.log,
            });
        } catch (e) {
            this.log.error(`Could not initialise LLM client: ${(e as Error).message}`);
            await this.setStateAsync('info.connection', { val: false, ack: true });
            return;
        }

        await this.setStateAsync('info.connection', { val: true, ack: true });
        this.subscribeStates('text.request');
        this.log.info(`Assistant ready (provider=${cfg.provider}, model=${this.agent.model}).`);
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack) {
            return;
        } // ignore our own ack-writes
        if (!id.endsWith('.text.request')) {
            return;
        }
        if (!this.agent) {
            return;
        }

        const question = String(state.val ?? '').trim();
        if (!question) {
            return;
        }

        this.log.info(`Q: ${question}`);
        try {
            const answer = await this.agent.ask(question);
            this.log.info(`A: ${answer}`);
            await this.setStateAsync('text.response', { val: answer, ack: true });
        } catch (e) {
            this.log.error(`Assistant error: ${(e as Error).message}`);
            await this.setStateAsync('text.response', {
                val: `Fehler: ${(e as Error).message}`,
                ack: true,
            });
        }
    }

    /** Allow scripts to ask via sendTo('assistant.0', 'ask', { text: '...' }, cb). */
    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (!obj || obj.command !== 'ask') {
            return;
        }
        const message = obj.message as { text?: string } | string;
        const text = typeof message === 'string' ? message : message?.text;

        if (!this.agent) {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { error: 'agent not ready' }, obj.callback);
            }
            return;
        }
        try {
            const answer = await this.agent.ask(String(text ?? ''));
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { answer }, obj.callback);
            }
        } catch (e) {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { error: (e as Error).message }, obj.callback);
            }
        }
    }

    private onUnload(callback: () => void): void {
        try {
            callback();
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    // compact mode: export the factory
    module.exports = (options: Partial<AdapterOptions> | undefined) => new Assistant(options);
} else {
    // started directly
    (() => new Assistant())();
}
