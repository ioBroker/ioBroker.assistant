import { Adapter, type AdapterOptions } from '@iobroker/adapter-core';
import { createInProcessMcp, type InProcessMcp } from '@iobroker/mcp-server';

import { LlmAgent } from './lib/llm';
import { buildMcpTools, deviceKey } from './lib/tools';
import { resolveApiKey } from './lib/credentials';
import type { AdapterConfig } from './types';

class Assistant extends Adapter {
    declare config: AdapterConfig;
    private agent: LlmAgent | null = null;
    private mcp: InProcessMcp | null = null;

    public constructor(options: Partial<AdapterOptions> = {}) {
        super({ ...options, name: 'assistant' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        const cfg = this.config;
        const apiKey = await resolveApiKey(this, cfg);

        if (!apiKey) {
            this.log.warn(
                cfg.credentialType === 'manager'
                    ? 'No credential selected (manager mode) — pick an API-key credential in the adapter settings.'
                    : 'No API key configured — open the adapter settings and enter your LLM API key.',
            );
            await this.setStateAsync('info.connection', { val: false, ack: true });
            return;
        }

        try {
            this.mcp = await createInProcessMcp({
                adapter: this,
                language: this.language,
                allowSetState: cfg.allowWriteStates,
                allowObjectChange: cfg.allowObjectChange,
            });
            const { tools, denied } = await buildMcpTools(this.mcp, cfg);
            this.log.info(`ioBroker tools enabled (${tools.length}): ${tools.map(t => t.name).join(', ')}`);
            if (denied.length) {
                this.log.debug(`Tools denied by access settings: ${denied.join(', ')}`);
            }

            this.agent = new LlmAgent({
                provider: cfg.provider || 'openai',
                apiKey,
                model: cfg.model || (cfg.provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o-mini'),
                baseUrl: cfg.baseUrl || '',
                systemPrompt: cfg.systemPrompt || '',
                maxTokens: cfg.maxTokens || 1024,
                tools,
                log: this.log,
            });
        } catch (e) {
            this.log.error(`Could not initialise assistant: ${(e as Error).message}`);
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
        if (!obj || !obj.command) {
            return;
        }

        // Settings-dialog "Test connection" button.
        if (obj.command === 'testApiConnection') {
            const result = await this.testApiConnection(
                (obj.message || {}) as {
                    provider?: 'openai' | 'anthropic' | 'custom';
                    apiKey?: string;
                    credentialType?: 'manual' | 'manager';
                    credentialId?: string;
                },
            );
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, result, obj.callback);
            }
            return;
        }

        // Settings-dialog model dropdown (selectSendTo).
        if (obj.command === 'getModels') {
            const models = await this.getModels(
                (obj.message || {}) as {
                    provider?: 'openai' | 'anthropic' | 'custom';
                    apiKey?: string;
                    credentialType?: 'manual' | 'manager';
                    credentialId?: string;
                    baseUrl?: string;
                },
            );
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, models, obj.callback);
            }
            return;
        }

        // Custom admin component: device list for the per-device ACL editor.
        if (obj.command === 'getDevices') {
            const devices = await this.getDeviceList();
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, devices, obj.callback);
            }
            return;
        }

        if (obj.command !== 'ask') {
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

    /** Flattened device list (name, type, room, state ids) for the admin per-device ACL component. */
    private async getDeviceList(): Promise<
        { key: string; name: string; type: string; room: string; stateIds: string[]; writableStateIds: string[] }[]
    > {
        if (!this.mcp) {
            return [];
        }
        try {
            const res = await this.mcp.callTool('list_devices', { language: this.language });
            const parsed = JSON.parse(res.text) as {
                data?: {
                    rooms?: {
                        roomName: string;
                        devicesInRoom?: {
                            deviceName?: string;
                            deviceType?: string;
                            controls?: Record<string, { stateId?: string; writable?: boolean }>;
                        }[];
                    }[];
                };
            };
            const out: {
                key: string;
                name: string;
                type: string;
                room: string;
                stateIds: string[];
                writableStateIds: string[];
            }[] = [];
            for (const room of parsed.data?.rooms || []) {
                for (const dev of room.devicesInRoom || []) {
                    const controls = Object.values(dev.controls || {});
                    out.push({
                        key: deviceKey(room.roomName, String(dev.deviceName ?? ''), String(dev.deviceType ?? '')),
                        name: String(dev.deviceName ?? ''),
                        type: String(dev.deviceType ?? ''),
                        room: String(room.roomName ?? ''),
                        stateIds: controls.map(c => c.stateId).filter((x): x is string => !!x),
                        writableStateIds: controls
                            .filter(c => c.writable)
                            .map(c => c.stateId)
                            .filter((x): x is string => !!x),
                    });
                }
            }
            return out;
        } catch (e) {
            this.log.warn(`getDevices failed: ${(e as Error).message}`);
            return [];
        }
    }

    /** Load the available models for a provider (used by the settings model dropdown / selectSendTo). */
    private async getModels(msg: {
        provider?: 'openai' | 'anthropic' | 'custom';
        apiKey?: string;
        credentialType?: 'manual' | 'manager';
        credentialId?: string;
        baseUrl?: string;
    }): Promise<string[]> {
        const cfg = this.config;
        const provider = msg.provider || cfg.provider || 'openai';
        const apiKey = await resolveApiKey(this, cfg, {
            credentialType: msg.credentialType,
            apiKey: msg.apiKey,
            credentialId: msg.credentialId,
        });
        if (!apiKey) {
            return [];
        }
        try {
            const agent = new LlmAgent({
                provider,
                apiKey,
                model: '',
                baseUrl: msg.baseUrl ?? cfg.baseUrl ?? '',
                maxTokens: 16,
                tools: [],
                log: this.log,
            });
            return await agent.listModels();
        } catch (e) {
            this.log.warn(`getModels failed: ${(e as Error).message}`);
            return [];
        }
    }

    /** Validate a provider + key from the settings dialog without persisting anything. */
    private async testApiConnection(msg: {
        provider?: 'openai' | 'anthropic' | 'custom';
        apiKey?: string;
        credentialType?: 'manual' | 'manager';
        credentialId?: string;
    }): Promise<{ result?: string; error?: string }> {
        const cfg = this.config;
        const provider = msg.provider || cfg.provider || 'openai';
        const apiKey = await resolveApiKey(this, cfg, {
            credentialType: msg.credentialType,
            apiKey: msg.apiKey,
            credentialId: msg.credentialId,
        });
        if (!apiKey) {
            return { error: 'No API key / credential available.' };
        }
        const agent = new LlmAgent({
            provider,
            apiKey,
            model: cfg.model || (provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o-mini'),
            baseUrl: cfg.baseUrl || '',
            maxTokens: 16,
            tools: [],
            log: this.log,
        });
        const res = await agent.testConnection();
        return res.ok ? { result: 'Connection OK' } : { error: res.error || 'unknown error' };
    }

    private async onUnload(callback: () => void): Promise<void> {
        try {
            await this.mcp?.close();
        } catch {
            // ignore
        } finally {
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
