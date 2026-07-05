import { Adapter, type AdapterOptions } from '@iobroker/adapter-core';
import { createInProcessMcp, type InProcessMcp } from '@iobroker/mcp-server';
import * as os from 'node:os';
import { spawn } from 'node:child_process';

import { LlmAgent } from './lib/llm';
import { buildMcpTools, deviceKey, ListCache } from './lib/tools';
import { Nlu, type NluDevice, type NluIntent } from './lib/nlu';
import { LocalLlm, installLocalLlm, isLocalLlmInstalled, isHandoff, DEFAULT_LOCAL_MODEL_URL } from './lib/localLlm';
import { resolveApiKey, resolveVoiceCredentials } from './lib/credentials';
import { VoiceServer } from './lib/voice/voiceServer';
import {
    createSttEngine,
    createTtsEngine,
    listVoices,
    type EngineContext,
    type VoiceCredentials,
    type SpeechProvider,
} from './lib/voice/engines';
import type { SttEngine } from './lib/voice/stt';
import type { TtsEngine } from './lib/voice/tts';
import type { SatelliteState } from './lib/voice/protocol';
import type { AdapterConfig } from './types';

/** A tts value is treated as an audio file (not text) when it looks like an mp3/wav/… URL or path. */
function isAudioRef(v: string): boolean {
    return /\.(mp3|wav|ogg|flac|m4a|aac|opus)(\?.*)?$/i.test(v.trim());
}

/** ioBroker language code → an English language name for the translation prompt. */
function languageLabel(lang?: string): string {
    const map: Record<string, string> = {
        en: 'English',
        de: 'German',
        ru: 'Russian',
        pt: 'Portuguese',
        nl: 'Dutch',
        fr: 'French',
        it: 'Italian',
        es: 'Spanish',
        pl: 'Polish',
        uk: 'Ukrainian',
        'zh-cn': 'Chinese',
    };
    return map[lang || 'en'] || 'English';
}

/** One row of the admin device/ACL editor. */
interface DeviceListEntry {
    key: string;
    /** Resolved display name (smartName in requested lang → parent name → detector name). */
    name: string;
    /** Raw `common.smartName`: string, per-language map, or null (for the multi-language editor). */
    smartName: string | Record<string, string> | null;
    /** Language-independent fallback name (parent/detector), shown when no smartName exists. */
    autoName: string;
    type: string;
    room: string;
    stateIds: string[];
    writableStateIds: string[];
}

class Assistant extends Adapter {
    declare config: AdapterConfig;
    private agent: LlmAgent | null = null;
    private mcp: InProcessMcp | null = null;
    /** Short-TTL cache for the expensive device/room/function listings; invalidated on enum changes. */
    private listCache: ListCache | null = null;
    /** Tier-1a local LLM (node-llama-cpp), lazily loaded when enabled + installed; null otherwise. */
    private localLlm: LocalLlm | null = null;
    /** Guards against concurrent local-LLM loads. */
    private localLlmLoading: Promise<void> | null = null;
    /** UDP voice server for satellites (only when voiceEnabled); null otherwise. */
    private voice: VoiceServer | null = null;
    /** Satellite ids whose state objects have already been created (avoid re-creating on every update). */
    private readonly satStatesEnsured = new Set<string>();
    /** Sanitised satellite state-id → real device name (for the per-satellite `tts` announce state). */
    private readonly satDeviceById = new Map<string, string>();

    public constructor(options: Partial<AdapterOptions> = {}) {
        super({ ...options, name: 'assistant' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
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
            this.listCache = new ListCache();
            const { tools, denied } = await buildMcpTools(this.mcp, cfg, this.listCache, (id, fb) =>
                this.resolveDeviceName(id, fb),
            );
            this.log.info(`ioBroker tools enabled (${tools.length}): ${tools.map(t => t.name).join(', ')}`);
            if (denied.length) {
                this.log.debug(`Tools denied by access settings: ${denied.join(', ')}`);
            }
            // Bust the device/room cache when room/function memberships change (new device shows within TTL anyway).
            this.subscribeForeignObjects('enum.rooms.*');
            this.subscribeForeignObjects('enum.functions.*');

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

        if (cfg.useLocalLlm) {
            void this.ensureLocalLlm(); // background: model load/download must not block onReady
        }

        if (cfg.voiceEnabled) {
            await this.startVoiceServer(apiKey);
            // Announcements: broadcast to all satellites; per-satellite states are subscribed on first sight.
            this.subscribeStates('tts.text');
        }
    }

    /** Build the engine context (creds + local-model settings + data dir) for the STT/TTS factory. */
    private voiceContext(cfg: AdapterConfig, creds: VoiceCredentials): EngineContext {
        return {
            creds,
            voices: {
                openai: cfg.ttsVoice || 'alloy',
                azure: (cfg.azureVoice || '').trim(),
                aws: (cfg.awsVoice || '').trim(),
                piper: (cfg.piperVoice || '').trim(),
            },
            dataDir: this.instanceDataDir(),
            log: this.log,
            voskModel: (cfg.voskModel || '').trim(),
        };
    }

    /**
     * Start the UDP voice server. STT and TTS providers are selected independently (OpenAI / Azure /
     * AWS cloud, or Vosk / Piper locally); credentials come from the encrypted config fields or the
     * central credential store (voiceCredentialType).
     */
    private async startVoiceServer(mainApiKey: string): Promise<void> {
        const cfg = this.config;
        const creds = await resolveVoiceCredentials(this, cfg, mainApiKey);
        const ctx = this.voiceContext(cfg, creds);
        // Raw language (e.g. 'de' or 'zh-cn') — each engine normalises it (ISO for cloud, model per lang for local).
        const language = cfg.voiceLanguage || this.language || '';

        let stt: SttEngine;
        let tts: TtsEngine;
        try {
            stt = createSttEngine(cfg.sttProvider || 'openai', ctx);
            tts = createTtsEngine(cfg.ttsProvider || 'openai', ctx);
        } catch (e) {
            this.log.warn(`Voice server not started — ${(e as Error).message}. Check the Voice tab settings.`);
            return;
        }

        try {
            this.voice = new VoiceServer({
                port: cfg.port || 7775,
                bindAddress: cfg.bind || '0.0.0.0',
                language,
                stt,
                tts,
                answer: (question, ctx) => this.answerVoice(question, ctx.device),
                log: this.log,
                onStatus: (device, room, state) => {
                    this.updateSatelliteState(device, room, state).catch(e =>
                        this.log.debug(`satellite state update failed: ${(e as Error).message}`),
                    );
                },
            });
            await this.voice.start();
            this.log.info(`Voice server: STT=${cfg.sttProvider || 'openai'}, TTS=${cfg.ttsProvider || 'openai'}.`);
        } catch (e) {
            this.log.error(`Could not start voice server: ${(e as Error).message}`);
            this.voice = null;
        }
    }

    /**
     * Answer a voice request and mirror it into the text states: the recognised text into
     * `text.request` and the reply into `text.response` (both ack:true, so writing the request does
     * not re-trigger onStateChange). The state writes must not block the spoken reply, so they are
     * fire-and-forget.
     */
    private async answerVoice(question: string, source: string): Promise<string> {
        this.setStateAsync('text.request', { val: question, ack: true }).catch(() => {});
        this.setQuerySource(source);
        const answer = await this.answer(question);
        this.setStateAsync('text.response', { val: answer, ack: true }).catch(() => {});
        return answer;
    }

    /** Record the origin of the current text.request/response ('' = state write, 'chat' = message, else satellite). */
    private setQuerySource(source: string): void {
        this.setStateAsync('text.querySource', { val: source, ack: true }).catch(() => {});
    }

    /**
     * List TTS voices for the settings voice dropdown. Uses the (unsaved) form values passed in the
     * message so it works before saving, falling back to the stored config; resolves credentials via
     * the same manual/manager path as the running server.
     */
    private async getVoices(msg: {
        ttsProvider?: SpeechProvider;
        language?: string;
        voiceCredentialType?: 'manual' | 'manager';
        voiceApiKey?: string;
        voiceCredentialId?: string;
        azureSpeechKey?: string;
        azureSpeechRegion?: string;
        azureCredentialId?: string;
        awsAccessKeyId?: string;
        awsSecretAccessKey?: string;
        awsRegion?: string;
        awsCredentialId?: string;
    }): Promise<string[]> {
        try {
            // Merge the form's config-shaped fields over the saved config (ttsProvider/language handled apart).
            const overrides = Object.fromEntries(
                Object.entries(msg).filter(([k, v]) => v !== undefined && k !== 'ttsProvider' && k !== 'language'),
            ) as Partial<AdapterConfig>;
            const cfg = { ...this.config, ...overrides };
            const provider = msg.ttsProvider || cfg.ttsProvider || 'openai';
            const language = msg.language || cfg.voiceLanguage || this.language || '';
            const mainKey = await resolveApiKey(this, this.config);
            const creds = await resolveVoiceCredentials(this, cfg, mainKey);
            return await listVoices(provider, this.voiceContext(cfg, creds), language);
        } catch (e) {
            this.log.warn(`getVoices failed: ${(e as Error).message}`);
            return [];
        }
    }

    /** This host's bindable IPv4 addresses (for the voice-server bind-address dropdown). */
    private getBindAddresses(): { label: string; value: string }[] {
        const out = [
            { label: '0.0.0.0 (all interfaces)', value: '0.0.0.0' },
            { label: '127.0.0.1 (this host only)', value: '127.0.0.1' },
        ];
        for (const list of Object.values(os.networkInterfaces())) {
            for (const iface of list || []) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    out.push({ label: `${iface.address} (${iface.address})`, value: iface.address });
                }
            }
        }
        return out;
    }

    /** Reflect a satellite's status into `satellites.<id>.*` states (created on first sight). */
    private async updateSatelliteState(device: string, room: string, state: SatelliteState | 'offline'): Promise<void> {
        const id = device.replace(/[^\w-]/g, '_') || 'unknown';
        const base = `satellites.${id}`;
        if (!this.satStatesEnsured.has(id)) {
            await this.setObjectNotExistsAsync('satellites', {
                type: 'channel',
                common: { name: 'Voice satellites' },
                native: {},
            });
            await this.setObjectNotExistsAsync(base, { type: 'device', common: { name: device }, native: {} });
            await this.setObjectNotExistsAsync(`${base}.status`, {
                type: 'state',
                common: { name: 'Status', type: 'string', role: 'text', read: true, write: false, def: 'idle' },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${base}.room`, {
                type: 'state',
                common: { name: 'Room', type: 'string', role: 'text', read: true, write: false, def: '' },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${base}.alive`, {
                type: 'state',
                common: {
                    name: 'Alive',
                    type: 'boolean',
                    role: 'indicator.reachable',
                    read: true,
                    write: false,
                    def: false,
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${base}.lastSeen`, {
                type: 'state',
                common: { name: 'Last seen', type: 'number', role: 'value.time', read: true, write: false },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${base}.tts`, {
                type: 'state',
                common: {
                    name: 'Speak on this satellite (plain text, or a URL/path to an mp3/wav)',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: true,
                    def: '',
                },
                native: {},
            });
            this.subscribeStates(`${base}.tts`);
            this.satStatesEnsured.add(id);
        }
        // Map the (sanitised) state id back to the real device name for the per-satellite tts state.
        this.satDeviceById.set(id, device);
        await this.setStateAsync(`${base}.status`, { val: state, ack: true });
        await this.setStateAsync(`${base}.alive`, { val: state !== 'offline', ack: true });
        await this.setStateAsync(`${base}.lastSeen`, { val: Date.now(), ack: true });
        if (room) {
            await this.setStateAsync(`${base}.room`, { val: room, ack: true });
        }
    }

    /**
     * Speak `value` on a satellite (`device`) or all (`device=null`). Plain text is synthesised with the
     * configured TTS engine; a URL or path to an audio file (mp3/wav/…) is decoded with ffmpeg.
     */
    private async announceToSatellites(value: string, device: string | null): Promise<void> {
        const v = value.trim();
        if (!v) {
            return;
        }
        if (!this.voice) {
            this.log.warn('Announcement ignored — the voice server is not running.');
            return;
        }
        const isAudio = isAudioRef(v);
        try {
            this.log.info(`Announce → ${device || 'all satellites'}: ${isAudio ? v : `"${v}"`}`);
            let pcm: Buffer;
            let sampleRate: number;
            if (isAudio) {
                ({ pcm, sampleRate } = await this.decodeAudioToPcm(v));
            } else {
                const engine = await this.buildTtsEngine();
                ({ pcm, sampleRate } = await engine.synthesize(v, this.config.voiceLanguage || this.language || ''));
            }
            await this.voice.announce(device, pcm, sampleRate);
        } catch (e) {
            this.log.error(`Announcement failed: ${(e as Error).message}`);
        }
    }

    /** Decode an audio file/URL (mp3/wav/…) to mono 16-bit PCM via ffmpeg. */
    private decodeAudioToPcm(src: string): Promise<{ pcm: Buffer; sampleRate: number }> {
        return new Promise((resolve, reject) => {
            const sampleRate = 24000;
            // prettier-ignore
            const args = ['-hide_banner', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', '-'];
            const proc = spawn('ffmpeg', args);
            const chunks: Buffer[] = [];
            proc.stdout.on('data', (d: Buffer) => chunks.push(d));
            proc.stderr.on('data', (d: Buffer) => this.log.debug(`ffmpeg: ${String(d).trim()}`));
            proc.on('error', e =>
                reject(new Error(`ffmpeg failed: ${e.message} — install ffmpeg to play audio files`)),
            );
            proc.on('close', code =>
                code === 0
                    ? resolve({ pcm: Buffer.concat(chunks), sampleRate })
                    : reject(new Error(`ffmpeg exited with code ${code}`)),
            );
        });
    }

    /** Invalidate the cached device/room/function listings when a room/function enum changes. */
    private onObjectChange(id: string, _obj: ioBroker.Object | null | undefined): void {
        if (this.listCache && (id.startsWith('enum.rooms.') || id.startsWith('enum.functions.'))) {
            this.listCache.clear();
            this.log.debug(`list cache cleared (object changed: ${id})`);
        }
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack) {
            return;
        } // ignore our own ack-writes

        // Announcements: `tts.text` → all satellites; `satellites.<id>.tts` → that satellite.
        if (id.endsWith('.tts.text')) {
            await this.announceToSatellites(String(state.val ?? ''), null);
            return;
        }
        const satTts = id.match(/\.satellites\.([^.]+)\.tts$/);
        if (satTts) {
            await this.announceToSatellites(String(state.val ?? ''), this.satDeviceById.get(satTts[1]) || satTts[1]);
            return;
        }

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
        this.setQuerySource(''); // origin: direct write to the text.request state
        try {
            const answer = await this.answer(question);
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
        if (!obj?.command) {
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
                    model?: string;
                    baseUrl?: string;
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

        // Settings button: install the on-demand local LLM engine (node-llama-cpp) + load the model.
        if (obj.command === 'installLocalLlm') {
            const dataDir = this.instanceDataDir();
            try {
                this.log.info('Installing local LLM engine (node-llama-cpp) — this may take a few minutes…');
                await installLocalLlm(dataDir, line => line && this.log.info(`local-llm install: ${line}`));
                void this.ensureLocalLlm(); // background: downloads + loads the model
                if (obj.callback) {
                    this.sendTo(
                        obj.from,
                        obj.command,
                        { result: 'Engine installed. The model is downloading in the background (see the log).' },
                        obj.callback,
                    );
                }
            } catch (e) {
                this.log.error(`Local LLM install failed: ${(e as Error).message}`);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: (e as Error).message }, obj.callback);
                }
            }
            return;
        }

        // Voice-tab TTS voice dropdown (autocompleteSendTo): list voices for the selected provider.
        if (obj.command === 'getVoices') {
            const voices = await this.getVoices(
                (obj.message || {}) as {
                    ttsProvider?: SpeechProvider;
                    language?: string;
                    voiceCredentialType?: 'manual' | 'manager';
                    voiceApiKey?: string;
                    voiceCredentialId?: string;
                    azureSpeechKey?: string;
                    azureSpeechRegion?: string;
                    azureCredentialId?: string;
                    awsAccessKeyId?: string;
                    awsSecretAccessKey?: string;
                    awsRegion?: string;
                    awsCredentialId?: string;
                },
            );
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, voices, obj.callback);
            }
            return;
        }

        // Voice-tab bind-address dropdown: list this host's IPv4 interfaces.
        if (obj.command === 'getBindAddresses') {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, this.getBindAddresses(), obj.callback);
            }
            return;
        }

        // Custom admin component: drop the cached device/room/function listings (Chat refresh button).
        if (obj.command === 'clearCache') {
            this.listCache?.clear();
            this.log.debug('list cache cleared (clearCache command)');
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
            }
            return;
        }

        // Custom admin component: set/clear the friendly device name (writes common.smartName).
        if (obj.command === 'setDeviceName') {
            const { stateId, name, language } = (obj.message || {}) as {
                stateId?: string;
                name?: string;
                language?: string;
            };
            const result = await this.setDeviceSmartName(stateId, name, language);
            this.listCache?.clear(); // so the new name shows on the next list_devices
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, result, obj.callback);
            }
            return;
        }

        // Settings device editor: translate a device name into a target language via the LLM.
        if (obj.command === 'translateName') {
            const { text, targetLang } = (obj.message || {}) as { text?: string; targetLang?: string };
            if (!this.agent) {
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: 'agent not ready' }, obj.callback);
                }
                return;
            }
            try {
                const translation = await this.agent.translate(String(text ?? ''), languageLabel(targetLang));
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { translation }, obj.callback);
                }
            } catch (e) {
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { error: (e as Error).message }, obj.callback);
                }
            }
            return;
        }

        // Chat: is backend TTS usable (a voice key is configured)? Drives the play button's visibility.
        if (obj.command === 'ttsAvailable') {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { available: await this.isTtsAvailable() }, obj.callback);
            }
            return;
        }

        // Chat: synthesize an answer to speech (WAV) via the configured TTS engine.
        if (obj.command === 'tts') {
            const { text, language } = (obj.message || {}) as { text?: string; language?: string };
            const result = await this.synthesizeToWav(String(text ?? ''), language);
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, result, obj.callback);
            }
            return;
        }

        // Custom admin component: device list for the per-device ACL editor.
        if (obj.command === 'getDevices') {
            // Resolve names/rooms in the admin UI language (may differ from the system language).
            const lang = (obj.message as { language?: ioBroker.Languages } | undefined)?.language;
            const devices = await this.getDeviceList(lang);
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
        const question = String(text ?? '');
        this.log.info(`Q (${obj.command}): ${question}`);
        this.setStateAsync('text.request', { val: question, ack: true }).catch(() => {});
        this.setQuerySource('chat');
        try {
            const answer = await this.answer(question);
            this.log.info(`A: ${answer}`);
            this.setStateAsync('text.response', { val: answer, ack: true }).catch(() => {});
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { answer }, obj.callback);
            }
        } catch (e) {
            this.log.error(`Assistant error: ${(e as Error).message}`);
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { error: (e as Error).message }, obj.callback);
            }
        }
    }

    /**
     * Answer a question. Tier 0: the built-in rule-based NLU handles simple device commands offline/free;
     * anything it can't resolve falls through to the LLM (Tier 2, and later the local model as Tier 1a).
     */
    private async answer(question: string): Promise<string> {
        // Tier 0: rule-based NLU (device commands) — fastest, offline, free.
        if (this.config.useLocalNlu) {
            try {
                const handled = await this.tryLocalNlu(question);
                if (handled !== null) {
                    this.log.debug(`NLU handled locally: "${question}"`);
                    return handled;
                }
            } catch (e) {
                this.log.debug(`NLU skipped: ${(e as Error).message}`);
            }
        }
        // Tier 1a: local LLM — answers general questions offline; emits HANDOFF for anything needing tools.
        if (this.config.useLocalLlm && this.localLlm) {
            try {
                const ans = await this.localLlm.ask(question);
                if (ans && !isHandoff(ans)) {
                    this.log.debug(`Local LLM answered: "${question}"`);
                    return ans;
                }
                this.log.debug('Local LLM handed off to the cloud LLM.');
            } catch (e) {
                this.log.debug(`Local LLM error: ${(e as Error).message}`);
            }
        }
        // Tier 2: cloud LLM with full tool access. Inject a compact device list into the system prompt so
        // the model can act without a first `list_devices` round-trip (kept cached via prompt caching).
        if (!this.agent) {
            throw new Error('agent not ready');
        }
        const ctx = await this.buildDeviceContext();
        const sys = ctx ? `${this.config.systemPrompt || ''}\n\n${ctx}` : undefined;
        return this.agent.ask(question, sys);
    }

    /**
     * Compact device listing for the LLM system prompt: "Name (Room, type): stateId, …" per device,
     * so the model can call set_state/get_states directly without a `list_devices` round-trip. Honors
     * the read ACL (hides read-disabled devices) and reuses the cached NLU device model.
     */
    private async buildDeviceContext(): Promise<string> {
        let devices: NluDevice[];
        try {
            ({ devices } = await this.getNluDevices());
        } catch {
            return '';
        }
        const acl = this.config.deviceAcl || {};
        const lines: string[] = [];
        for (const d of devices) {
            const ids = [...new Set(Object.values(d.controls))];
            if (!ids.length) {
                continue;
            }
            if (acl[deviceKey(ids)]?.read === false) {
                continue; // hidden from the LLM
            }
            const room = d.room ? `${d.room}, ` : '';
            lines.push(`- ${d.name} (${room}${d.type}): ${ids.join(', ')}`);
        }
        if (!lines.length) {
            return '';
        }
        const lang = String(this.config.voiceLanguage || this.language || 'en');
        const header =
            lang === 'ru'
                ? 'Известные устройства — «имя (комната, тип): stateId». Используй эти stateId напрямую с set_state/get_states; вызывай list_devices только если нужного устройства здесь нет.'
                : lang === 'de'
                  ? 'Bekannte Geräte — "Name (Raum, Typ): stateId". Nutze diese stateIds direkt mit set_state/get_states; rufe list_devices nur, wenn ein Gerät hier fehlt.'
                  : 'Known devices — "name (room, type): stateId". Use these stateIds directly with set_state/get_states; only call list_devices if a needed device is missing here.';
        return `${header}\n${lines.join('\n')}`;
    }

    /** Writable per-instance data dir (adapter-core method; typed loosely as the bundled types omit it). */
    private instanceDataDir(): string {
        return (this as unknown as { getAbsoluteInstanceDataDir(): string }).getAbsoluteInstanceDataDir();
    }

    /**
     * Lazily load the local LLM (Tier 1a) when enabled + installed. Runs in the background — the model
     * download can take a while — so callers should not await it on the hot path.
     */
    private async ensureLocalLlm(): Promise<void> {
        if (this.localLlm) {
            return;
        }
        if (this.localLlmLoading) {
            return this.localLlmLoading;
        }
        const dataDir = this.instanceDataDir();
        if (!isLocalLlmInstalled(dataDir)) {
            this.log.info(
                'Local LLM is enabled but not installed yet — click "Install local model" in the adapter settings.',
            );
            return;
        }
        const llm = new LocalLlm({
            dataDir,
            modelUrl: (this.config.localLlmModelUrl || '').trim() || DEFAULT_LOCAL_MODEL_URL,
            systemPrompt: this.config.systemPrompt || '',
            maxTokens: this.config.maxTokens || 512,
            log: this.log,
        });
        this.localLlmLoading = llm
            .load(line => this.log.debug(`local-llm: ${line}`))
            .then(() => {
                this.localLlm = llm;
            })
            .catch(e => {
                this.log.warn(`Local LLM load failed: ${(e as Error).message}`);
            })
            .finally(() => {
                this.localLlmLoading = null;
            });
        return this.localLlmLoading;
    }

    /** Run the rule-based NLU; returns a response string if it produced an executable intent, else null. */
    private async tryLocalNlu(question: string): Promise<string | null> {
        if (!this.mcp) {
            return null;
        }
        const { rooms, devices } = await this.getNluDevices();
        if (!devices.length) {
            return null;
        }
        const intent = new Nlu(rooms, devices).parse(question);
        if (!intent) {
            return null;
        }
        // Writes require the coarse toggle; if off, let the LLM explain instead of silently doing nothing.
        if (intent.action !== 'query' && !this.config.allowWriteStates) {
            return null;
        }
        return this.executeIntent(intent);
    }

    /** Device model for the NLU: friendly name, room, type and controls (controlType → state id). */
    private async getNluDevices(): Promise<{ rooms: string[]; devices: NluDevice[] }> {
        if (!this.mcp) {
            return { rooms: [], devices: [] };
        }
        // Match names in the assistant's interaction language (voice language, else system) so a
        // Russian command matches Russian smartNames.
        const nluLang = (this.config.voiceLanguage || this.language || 'en') as ioBroker.Languages;
        try {
            const res = await this.mcp.callTool('list_devices', { language: nluLang });
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
            const rooms = new Set<string>();
            const devices: NluDevice[] = [];
            for (const room of parsed.data?.rooms || []) {
                const roomName = room.roomName === 'No room' ? '' : String(room.roomName ?? '');
                if (roomName) {
                    rooms.add(roomName);
                }
                for (const dev of room.devicesInRoom || []) {
                    if (dev.deviceType === 'button') {
                        continue; // write-only trigger — not a device the NLU should match
                    }
                    const controls: Record<string, string> = {};
                    const writable: Record<string, boolean> = {};
                    const stateIds: string[] = [];
                    for (const [ct, c] of Object.entries(dev.controls || {})) {
                        if (c?.stateId) {
                            controls[ct] = c.stateId;
                            writable[ct] = !!c.writable;
                            stateIds.push(c.stateId);
                        }
                    }
                    if (!stateIds.length) {
                        continue;
                    }
                    const name = await this.resolveDeviceName(
                        deviceKey(stateIds),
                        String(dev.deviceName ?? ''),
                        nluLang,
                    );
                    devices.push({ name, room: roomName, type: String(dev.deviceType ?? ''), controls, writable });
                }
            }
            return { rooms: [...rooms], devices };
        } catch (e) {
            this.log.debug(`getNluDevices failed: ${(e as Error).message}`);
            return { rooms: [], devices: [] };
        }
    }

    /** Execute an NLU intent directly via the ioBroker API and return a short spoken-style response. */
    private async executeIntent(intent: NluIntent): Promise<string> {
        const mcp = this.mcp;
        if (!mcp) {
            throw new Error('mcp not ready');
        }
        // Respond in the assistant's interaction language (voice language, else system).
        const lang = String(this.config.voiceLanguage || this.language || 'en');
        const ru = lang === 'ru';
        const de = lang === 'de';
        const pick = (rus: string, ger: string, eng: string): string => (ru ? rus : de ? ger : eng);
        const room = intent.room || intent.device.room;
        // Appositive room qualifier "(<Raum>)" — grammatically safe in every language and reads fine aloud.
        const where = room ? ` (${room})` : '';
        const dev = intent.device.name;

        // Per-device ACL (key = primary state id, same as the ACL editor / read+write guards).
        const key = deviceKey(Object.values(intent.device.controls));

        if (intent.action === 'query') {
            if (this.config.deviceAcl?.[key]?.read === false) {
                return pick(
                    `${dev}${where} нельзя прочитать.`,
                    `${dev}${where} kann nicht gelesen werden.`,
                    `${dev}${where} cannot be read.`,
                );
            }
            const res = await mcp.callTool('get_states', { ids: [intent.stateId] });
            let value: unknown;
            try {
                const parsed = JSON.parse(res.text) as { data?: { states?: { value?: unknown }[] } };
                value = parsed.data?.states?.[0]?.value;
            } catch {
                value = undefined;
            }
            // Append the state's unit (e.g. °C) so the spoken answer is "minus 4,1 °C" instead of a raw number.
            let unit = '';
            try {
                const obj = await this.getForeignObjectAsync(intent.stateId);
                unit = (obj?.common as { unit?: string } | undefined)?.unit || '';
            } catch {
                /* no unit */
            }
            return `${dev}${where}: ${this.describeValue(value, lang, unit)}.`;
        }

        if (this.config.deviceAcl?.[key]?.write === false) {
            return pick(
                `${dev}${where} только для чтения.`,
                `${dev}${where} ist schreibgeschützt.`,
                `${dev}${where} is read-only.`,
            );
        }

        await mcp.callTool('set_state', { id: intent.stateId, value: intent.value });

        if (intent.action === 'on') {
            return pick(`${dev}${where} включено.`, `${dev}${where} wurde eingeschaltet.`, `${dev}${where} turned on.`);
        }
        if (intent.action === 'off') {
            return pick(
                `${dev}${where} выключено.`,
                `${dev}${where} wurde ausgeschaltet.`,
                `${dev}${where} turned off.`,
            );
        }
        if (intent.action === 'level') {
            return pick(
                `${dev}${where} установлено на ${intent.value}%.`,
                `${dev}${where} auf ${intent.value}% gesetzt.`,
                `${dev}${where} set to ${intent.value}%.`,
            );
        }
        return pick(
            `Цвет ${dev}${where} установлен.`,
            `Farbe von ${dev}${where} gesetzt.`,
            `Color of ${dev}${where} set.`,
        );
    }

    /** Human-readable rendering of a state value for NLU query responses (spoken aloud). */
    private describeValue(value: unknown, lang: string, unit = ''): string {
        const ru = lang === 'ru';
        const de = lang === 'de';
        const pick = (rus: string, ger: string, eng: string): string => (ru ? rus : de ? ger : eng);
        if (value === true) {
            return pick('включено', 'an', 'on');
        }
        if (value === false) {
            return pick('выключено', 'aus', 'off');
        }
        if (value === null || value === undefined) {
            return pick('неизвестно', 'unbekannt', 'unknown');
        }
        const withUnit = (s: string): string => (unit ? `${s} ${unit}` : s);
        if (typeof value === 'number') {
            // Round to 2 decimals (kills float noise) and use a decimal comma in German/Russian.
            const rounded = Math.round(value * 100) / 100;
            return withUnit(ru || de ? String(rounded).replace('.', ',') : String(rounded));
        }
        if (typeof value === 'string') {
            return withUnit(value);
        }
        return JSON.stringify(value);
    }

    /** Flattened device list (name, type, room, state ids) for the admin per-device ACL component. */
    private async getDeviceList(lang?: ioBroker.Languages): Promise<DeviceListEntry[]> {
        if (!this.mcp) {
            return [];
        }
        const language = lang || this.language;
        try {
            const res = await this.mcp.callTool('list_devices', { language });
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
            const out: DeviceListEntry[] = [];
            for (const room of parsed.data?.rooms || []) {
                for (const dev of room.devicesInRoom || []) {
                    const controls = Object.values(dev.controls || {});
                    const stateIds = controls.map(c => c.stateId).filter((x): x is string => !!x);
                    const key = deviceKey(stateIds);
                    // The multi-language editor needs the raw smartName map plus the language-independent
                    // "auto" (parent/detector) name it falls back to; `name` is the resolved display name.
                    const [name, smartName, autoName] = await Promise.all([
                        this.resolveDeviceName(key, String(dev.deviceName ?? ''), language),
                        this.rawSmartName(key),
                        this.resolveParentName(key, String(dev.deviceName ?? ''), language),
                    ]);
                    out.push({
                        key,
                        name,
                        smartName,
                        autoName,
                        type: String(dev.deviceType ?? ''),
                        room: String(room.roomName ?? ''),
                        stateIds,
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

    /** Extract a display name from `common.smartName` (string or `{lang}` map); '' if unset/disabled. */
    private smartNameOf(obj: ioBroker.Object | null | undefined, lang?: ioBroker.Languages): string {
        const sn = (obj?.common as { smartName?: unknown } | undefined)?.smartName;
        if (!sn || sn === 'ignore' || sn === false) {
            return '';
        }
        if (typeof sn === 'string') {
            return sn;
        }
        if (typeof sn === 'object') {
            const t = sn as Record<string, string>;
            const l = lang || this.language || 'en';
            return t[l] || t.en || t.de || '';
        }
        return '';
    }

    /** Resolve a `common.name` (string or translated map) to a display string for the given language. */
    private objectName(obj: ioBroker.Object | null | undefined, id: string, lang?: ioBroker.Languages): string {
        const n = obj?.common?.name;
        if (typeof n === 'string' && n) {
            return n;
        }
        if (n && typeof n === 'object') {
            const t = n as Record<string, string>;
            const l = lang || this.language || 'en';
            return t[l] || t.en || Object.values(t)[0] || id.split('.').pop() || id;
        }
        return id.split('.').pop() || id;
    }

    /**
     * Friendly device name, resolved the same way ioBroker.iot does (`Devices.tsx#resolveDeviceDisplay`):
     * the type-detector often names an alias control after its leaf state (e.g. "SET"), so walk one level
     * up to the enclosing channel/device/**folder** and use its name; if that parent is a channel/device/
     * folder, prefer an enclosing device's name. Falls back to the detector name on any miss.
     */
    private async resolveDeviceName(stateId: string, fallback: string, lang?: ioBroker.Languages): Promise<string> {
        // 1. User-edited smartName on the primary state wins over everything.
        try {
            const own = await this.getForeignObjectAsync(stateId);
            const sn = this.smartNameOf(own, lang);
            if (sn) {
                return sn;
            }
        } catch {
            /* fall through to parent walk-up */
        }
        // 2./3. iot-style parent walk-up.
        return this.resolveParentName(stateId, fallback, lang);
    }

    /** The "auto" name: walk up to the enclosing channel/device/folder (ignores smartName). */
    private async resolveParentName(stateId: string, fallback: string, lang?: ioBroker.Languages): Promise<string> {
        if (!stateId || !stateId.includes('.')) {
            return fallback;
        }
        const arr = stateId.split('.');
        arr.pop();
        const parentId = arr.join('.');
        if (!parentId) {
            return fallback;
        }
        let parent: ioBroker.Object | null | undefined;
        try {
            parent = await this.getForeignObjectAsync(parentId);
        } catch {
            return fallback;
        }
        if (!parent?.common?.name) {
            return fallback;
        }
        let name = this.objectName(parent, parentId, lang);
        if (parent.type === 'channel' || parent.type === 'device' || parent.type === 'folder') {
            arr.pop();
            const grandId = arr.join('.');
            if (grandId) {
                try {
                    const grand = await this.getForeignObjectAsync(grandId);
                    if (grand?.type === 'device' && grand.common?.name) {
                        name = this.objectName(grand, grandId, lang);
                    }
                } catch {
                    /* keep parent name */
                }
            }
        }
        return name || fallback;
    }

    /** Raw `common.smartName` of a state (string | translated map | null) for the multi-language editor. */
    private async rawSmartName(stateId: string): Promise<string | Record<string, string> | null> {
        try {
            const obj = await this.getForeignObjectAsync(stateId);
            const sn = (obj?.common as { smartName?: unknown } | undefined)?.smartName;
            if (typeof sn === 'string') {
                return sn;
            }
            if (sn && typeof sn === 'object') {
                // Drop non-language meta keys (smartType/byON) for the editor's language map.
                const out: Record<string, string> = {};
                for (const [k, v] of Object.entries(sn as Record<string, unknown>)) {
                    if (typeof v === 'string' && k !== 'smartType' && k !== 'byON') {
                        out[k] = v;
                    }
                }
                return out;
            }
        } catch {
            /* ignore */
        }
        return null;
    }

    /**
     * Set (or clear, when `name` is empty) the friendly device name by writing `common.smartName` on the
     * device's primary state. An existing object-form smartName keeps its extra fields (smartType, byON);
     * a string smartName is replaced. Clearing sets it to '' so the auto (parent) name takes over again.
     */
    private async setDeviceSmartName(
        stateId?: string,
        name?: string,
        language?: string,
    ): Promise<{ ok: boolean; error?: string }> {
        if (!stateId) {
            return { ok: false, error: 'no stateId' };
        }
        try {
            const obj = await this.getForeignObjectAsync(stateId);
            if (!obj) {
                return { ok: false, error: `object ${stateId} not found` };
            }
            const trimmed = (name || '').trim();
            const lang = language || this.language || 'en';
            const sn = (obj.common as { smartName?: unknown } | undefined)?.smartName;
            // Always store as a language map so multiple languages coexist; keep smartType/byON if present.
            const map: Record<string, unknown> = {};
            if (sn && typeof sn === 'object') {
                Object.assign(map, sn);
            } else if (typeof sn === 'string' && sn && lang !== 'en') {
                map.en = sn; // preserve a legacy string name under 'en'
            }
            if (trimmed) {
                map[lang] = trimmed;
            } else {
                delete map[lang];
            }
            const langKeys = Object.keys(map).filter(k => k !== 'smartType' && k !== 'byON');
            // If nothing meaningful remains, clear smartName so the auto (parent) name takes over.
            const smartName = langKeys.length ? (map as ioBroker.StateCommon['smartName']) : '';
            await this.extendForeignObjectAsync(stateId, { common: { smartName } as ioBroker.StateCommon });
            this.log.info(`Device name for ${stateId} [${lang}] set to "${trimmed}"`);
            return { ok: true };
        } catch (e) {
            return { ok: false, error: (e as Error).message };
        }
    }

    /** Build the configured TTS engine (throws when no voice key is available). */
    private async buildTtsEngine(): Promise<TtsEngine> {
        const cfg = this.config;
        const mainApiKey = (await resolveApiKey(this, cfg)) || '';
        const creds = await resolveVoiceCredentials(this, cfg, mainApiKey);
        return createTtsEngine(cfg.ttsProvider || 'openai', this.voiceContext(cfg, creds));
    }

    /** True if backend TTS can run (a voice key is configured) — drives the Chat play button. */
    private async isTtsAvailable(): Promise<boolean> {
        try {
            await this.buildTtsEngine();
            return true;
        } catch {
            return false;
        }
    }

    /** Synthesize `text` to a base64 WAV via the configured TTS engine (used by the Chat play button). */
    private async synthesizeToWav(
        text: string,
        language?: string,
    ): Promise<{ audio?: string; mime?: string; error?: string }> {
        if (!text.trim()) {
            return { error: 'empty text' };
        }
        try {
            const tts = await this.buildTtsEngine();
            const lang = language || this.config.voiceLanguage || this.language || '';
            const { pcm, sampleRate } = await tts.synthesize(text, lang);
            return { audio: this.pcmToWav(pcm, sampleRate).toString('base64'), mime: 'audio/wav' };
        } catch (e) {
            return { error: (e as Error).message };
        }
    }

    /** Wrap mono 16-bit signed-LE PCM in a minimal 44-byte WAV header for browser playback. */
    private pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
        const numChannels = 1;
        const bitsPerSample = 16;
        const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
        const blockAlign = (numChannels * bitsPerSample) / 8;
        const header = Buffer.alloc(44);
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + pcm.length, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20); // PCM
        header.writeUInt16LE(numChannels, 22);
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(byteRate, 28);
        header.writeUInt16LE(blockAlign, 32);
        header.writeUInt16LE(bitsPerSample, 34);
        header.write('data', 36);
        header.writeUInt32LE(pcm.length, 40);
        return Buffer.concat([header, pcm]);
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
        model?: string;
        baseUrl?: string;
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
            model: msg.model || cfg.model || (provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o-mini'),
            baseUrl: msg.baseUrl || cfg.baseUrl || '',
            maxTokens: 16,
            tools: [],
            log: this.log,
        });
        const res = await agent.testConnection();
        return res.ok ? { result: 'Connection OK' } : { error: res.error || 'unknown error' };
    }

    private async onUnload(callback: () => void): Promise<void> {
        try {
            await this.voice?.stop();
        } catch {
            // ignore
        }
        try {
            await this.localLlm?.dispose();
        } catch {
            // ignore
        }
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
