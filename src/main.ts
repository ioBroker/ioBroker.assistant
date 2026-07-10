import * as os from 'node:os';
import { spawn } from 'node:child_process';

import {
    Adapter,
    getAbsoluteInstanceDataDir,
    getAbsoluteDefaultDataDir,
    type AdapterOptions,
} from '@iobroker/adapter-core';
import * as path from 'node:path';
import { createInProcessMcp, type InProcessMcp } from '@iobroker/mcp-server';

import { LlmAgent, resolveProvider } from './lib/llm';
import { buildMcpTools, deviceKey, ListCache, type Tool } from './lib/tools';
import { Nlu, parseDurationSeconds, parseClockTime, parseWeekdays, type NluDevice, type NluIntent } from './lib/nlu';
import { TimerManager, formatDuration, type TimerInfo } from './lib/timers';
import { AlarmManager, formatClock, formatWeekdays, type AlarmInfo } from './lib/alarms';
import { MemoryStore, buildMemoryPrompt, type MemoryEntry } from './lib/memory';
import { LocalLlm, installLocalLlm, isLocalLlmInstalled, isHandoff, DEFAULT_LOCAL_MODEL_URL } from './lib/localLlm';
import { resolveApiKey, resolveVoiceCredentials } from './lib/credentials';
import { ConversationStore, type ConversationTurn } from './lib/context';
import { VoiceServer } from './lib/voice/voiceServer';
import { WyomingServer } from './lib/voice/wyoming';
import {
    createSttEngine,
    createTtsEngine,
    listVoices,
    listSttModels,
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
    /** Last reported local-LLM download percent (to throttle state writes / avoid log spam). */
    private lastLlmPct = -1;
    /** UDP voice server for satellites (only when voiceEnabled); null otherwise. */
    private voice: VoiceServer | null = null;
    /** Wyoming TCP endpoint (only when wyomingEnabled); null otherwise. */
    private wyoming: WyomingServer | null = null;
    /** Short-term per-source conversation memory (in-memory, TTL) for follow-up questions. */
    private readonly context = new ConversationStore();
    /** Satellite ids whose state objects have already been created (avoid re-creating on every update). */
    private readonly satStatesEnsured = new Set<string>();
    /** Sanitised satellite state-id → real device name (for the per-satellite `tts` announce state). */
    private readonly satDeviceById = new Map<string, string>();
    /** Native (ioBroker) satellite state-id → sender instance id, so we can push announcements back to it. */
    private readonly nativeSatFrom = new Map<string, string>();
    /** Countdown timers / reminders (roadmap #2); mirrored into `timers.*` states. Null until onReady. */
    private timers: TimerManager | null = null;
    /** Per-timer `timers.items.<id>` channels currently rendered, so we can delete the ones that expire. */
    private readonly timerObjIds = new Set<string>();
    /** Alarms at a fixed clock time (roadmap #2); mirrored into `alarms.*` states. Null until onReady. */
    private alarms: AlarmManager | null = null;
    /** Per-alarm `alarms.items.<id>` channels currently rendered. */
    private readonly alarmObjIds = new Set<string>();
    /** Long-term memory (roadmap #6); mirrored into `memory.*` states. Null until onReady / when disabled. */
    private memory: MemoryStore | null = null;
    /** Per-memory `memory.items.<id>` channels currently rendered. */
    private readonly memoryObjIds = new Set<string>();

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
            // Let the cloud LLM handle timers/alarms too (for phrasings the rule-based NLU misses).
            tools.push(...this.buildTimerTools(), ...this.buildAlarmTools());
            if (cfg.useLongTermMemory !== false) {
                tools.push(...this.buildMemoryTools());
            }
            this.log.info(`ioBroker tools enabled (${tools.length}): ${tools.map(t => t.name).join(', ')}`);
            if (denied.length) {
                this.log.debug(`Tools denied by access settings: ${denied.join(', ')}`);
            }
            // Bust the device/room cache when room/function memberships change (new device shows within TTL anyway).
            this.subscribeForeignObjects('enum.rooms.*');
            this.subscribeForeignObjects('enum.functions.*');

            const prov = resolveProvider(cfg.provider, cfg.baseUrl);
            this.agent = new LlmAgent({
                provider: cfg.provider || 'openai',
                apiKey,
                model: cfg.model || prov.defaultModel,
                baseUrl: prov.baseUrl,
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
        // Meta object backing this instance's file storage (so the admin can upload sound assets and the
        // adapter can read them back for timer/alarm jingles).
        await this.setForeignObjectNotExistsAsync(this.namespace, {
            type: 'meta',
            common: { name: 'assistant data', type: 'meta.user' },
            native: {},
        });
        await this.setupTimers();
        await this.setupAlarms();
        if (cfg.useLongTermMemory !== false) {
            await this.setupMemory();
        }
        this.log.info(`Assistant ready (provider=${cfg.provider}, model=${this.agent.model}).`);

        if (cfg.useLocalLlm) {
            void this.ensureLocalLlm(); // background: model load/download must not block onReady
        }

        if (cfg.voiceEnabled) {
            // Announcements: `tts.text` (broadcast) + per-satellite `.tts` states (subscribed on first sight).
            // Subscribe regardless of the UDP server so writes are always handled (and logged if unroutable).
            this.subscribeStates('tts.text');
            if (cfg.udpServerEnabled) {
                await this.startVoiceServer(apiKey);
            }
        }

        if (cfg.wyomingEnabled) {
            await this.startWyoming(apiKey);
        }
    }

    /** Start the Wyoming TCP endpoint, bridging to the same STT/answer/TTS pipeline as the UDP server. */
    private async startWyoming(mainApiKey: string): Promise<void> {
        const cfg = this.config;
        const creds = await resolveVoiceCredentials(this, cfg, mainApiKey);
        const ctx = this.voiceContext(cfg, creds);
        const language = cfg.voiceLanguage || this.language || '';
        let stt: SttEngine;
        let tts: TtsEngine;
        try {
            stt = createSttEngine(cfg.sttProvider || 'openai', ctx);
            tts = createTtsEngine(cfg.ttsProvider || 'openai', ctx);
        } catch (e) {
            this.log.warn(`Wyoming not started — ${(e as Error).message}. Check the Voice tab settings.`);
            return;
        }
        try {
            this.wyoming = new WyomingServer({
                port: cfg.wyomingPort || 10700,
                bindAddress: cfg.bind || '0.0.0.0',
                language,
                stt,
                tts,
                answer: question => this.answer(question, 'wyoming'),
                log: this.log,
            });
            await this.wyoming.start();
            if (!this.voice) {
                this.warmupEngines(stt, tts, language); // only if the UDP server didn't already warm up
            }
        } catch (e) {
            this.log.error(`Could not start Wyoming server: ${(e as Error).message}`);
            this.wyoming = null;
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
            sttModel: (cfg.sttModel || '').trim(),
            ttsModel: (cfg.ttsModel || '').trim(),
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
            // Warm up local engines now (install/download) instead of on the first spoken command.
            this.warmupEngines(stt, tts, language);
        } catch (e) {
            this.log.error(`Could not start voice server: ${(e as Error).message}`);
            this.voice = null;
        }
    }

    /** Kick off engine install + model/voice download at startup (background) so the first command isn't slow. */
    private warmupEngines(stt: SttEngine, tts: TtsEngine, language: string): void {
        const lang = language || this.language || 'en';
        if (stt.prepare) {
            this.log.info('Preparing speech-to-text engine (download in background) …');
            stt.prepare(lang).catch(e => this.log.warn(`STT warm-up failed: ${(e as Error).message}`));
        }
        if (tts.prepare) {
            this.log.info('Preparing text-to-speech engine (download in background) …');
            tts.prepare(lang).catch(e => this.log.warn(`TTS warm-up failed: ${(e as Error).message}`));
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
        this.log.info(`Voice Q (${source}): ${question}`);
        const answer = await this.answer(question, source);
        this.log.info(`Voice A (${source}): ${answer}`);
        this.setStateAsync('text.response', { val: answer, ack: true }).catch(() => {});
        return answer;
    }

    /** Record the origin of the current text.request/response ('' = state write, 'chat' = message, else satellite). */
    private setQuerySource(source: string): void {
        this.setStateAsync('text.querySource', { val: source, ack: true }).catch(() => {});
    }

    /** Lazily built + cached STT/TTS engines, shared by the `voice` sendTo handler (ioBroker-native satellites). */
    private speechEngines: { stt: SttEngine; tts: TtsEngine; language: string } | null = null;

    private async getSpeechEngines(): Promise<{ stt: SttEngine; tts: TtsEngine; language: string } | null> {
        if (this.speechEngines) {
            return this.speechEngines;
        }
        const cfg = this.config;
        const mainKey = await resolveApiKey(this, cfg);
        const creds = await resolveVoiceCredentials(this, cfg, mainKey);
        const ctx = this.voiceContext(cfg, creds);
        const language = cfg.voiceLanguage || this.language || '';
        try {
            this.speechEngines = {
                stt: createSttEngine(cfg.sttProvider || 'openai', ctx),
                tts: createTtsEngine(cfg.ttsProvider || 'openai', ctx),
                language,
            };
            return this.speechEngines;
        } catch (e) {
            this.log.warn(`Speech engines unavailable — ${(e as Error).message}. Check the Voice tab settings.`);
            return null;
        }
    }

    /**
     * Handle a voice query from an ioBroker-native satellite over the message bus (no UDP): decode the
     * recorded utterance, run STT → answer → TTS centrally, and return the reply as audio + text. Audio is
     * base64 raw 16-bit mono PCM (`format: 'pcm'`, default) or a WAV blob (`format: 'wav'`).
     */
    private async handleVoiceQuery(msg: {
        audio?: string;
        format?: 'pcm' | 'wav';
        sampleRate?: number;
        source?: string;
        room?: string;
        language?: string;
    }): Promise<{ text?: string; answer?: string; audio?: string; sampleRate?: number; error?: string }> {
        const source = msg.source || 'satellite';
        const room = msg.room || '';
        // Make the native satellite visible under assistant.0.satellites (+ lastSeen/room), like UDP ones.
        this.updateSatelliteState(source, room, 'processing').catch(() => {});
        try {
            if (!this.config.voiceEnabled) {
                return { error: 'voice is disabled — enable it on the Voice tab' };
            }
            if (!msg?.audio) {
                return { error: 'no audio provided' };
            }
            const engines = await this.getSpeechEngines();
            if (!engines) {
                return { error: 'speech engines not configured' };
            }
            let pcm = Buffer.from(msg.audio, 'base64');
            let rate = msg.sampleRate || 16000;
            if (msg.format === 'wav' && pcm.length > 44) {
                rate = pcm.readUInt32LE(24); // sample rate from the WAV header
                pcm = pcm.subarray(44);
            }
            const language = msg.language || engines.language;
            const text = (await engines.stt.transcribe(pcm, rate, language)).trim();
            if (!text) {
                return { text: '', answer: '' };
            }
            const answer = await this.answerVoice(text, source);
            if (!answer) {
                return { text, answer: '' };
            }
            const reply = await engines.tts.synthesize(answer, language);
            return { text, answer, audio: reply.pcm.toString('base64'), sampleRate: reply.sampleRate };
        } catch (e) {
            this.log.warn(`Voice query failed: ${(e as Error).message}`);
            return { error: (e as Error).message };
        } finally {
            this.updateSatelliteState(source, room, 'idle').catch(() => {});
        }
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

    /** State id for a satellite: room name (enum prefix stripped) if known, else the device name. */
    private satelliteStateId(device: string, room: string): string {
        const roomName = (room || '').replace(/^(enum\.rooms\.|system\.rooms\.)/, '');
        return (roomName || device).replace(/[^\w-]/g, '_') || 'unknown';
    }

    /** Reflect a satellite's status into `satellites.<room>.*` states (created on first sight). */
    private async updateSatelliteState(device: string, room: string, state: SatelliteState | 'offline'): Promise<void> {
        const id = this.satelliteStateId(device, room);
        const roomName = (room || '').replace(/^(enum\.rooms\.|system\.rooms\.)/, '');
        const base = `satellites.${id}`;
        if (!this.satStatesEnsured.has(id)) {
            await this.setObjectNotExistsAsync('satellites', {
                type: 'channel',
                common: { name: 'Voice satellites' },
                native: {},
            });
            await this.setObjectNotExistsAsync(base, {
                type: 'device',
                common: { name: roomName || device },
                native: {},
            });
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
     * Speak `value` on one satellite (by state id) or all (`targetId=null`). Plain text is synthesised with
     * the configured TTS engine; a URL/path to an audio file (mp3/wav/…) is decoded with ffmpeg. Delivered
     * to **both** transports: ioBroker-native satellites via a `sendTo(from, 'announce', …)` message and UDP
     * satellites via the UDP server.
     */
    private async announceToSatellites(value: string, targetId: string | null): Promise<void> {
        let v = value.trim();
        if (!v) {
            return;
        }
        // A leading "!" marks a priority announcement: strip it and let it bypass a satellite's
        // Do-Not-Disturb (e.g. "!Water leak detected" is played even in DND).
        const priority = v.startsWith('!');
        if (priority) {
            v = v.slice(1).trim();
            if (!v) {
                return;
            }
        }
        const isAudio = isAudioRef(v);
        let pcm: Buffer;
        let sampleRate: number;
        try {
            if (isAudio) {
                ({ pcm, sampleRate } = await this.decodeAudioToPcm(v));
            } else {
                const engine = await this.buildTtsEngine();
                ({ pcm, sampleRate } = await engine.synthesize(v, this.config.voiceLanguage || this.language || ''));
            }
        } catch (e) {
            this.log.error(`Announcement failed: ${(e as Error).message}`);
            return;
        }

        const delivered = await this.deliverPcm(pcm, sampleRate, targetId, priority);
        this.log.info(`Announce → ${targetId || 'all satellites'} (${delivered} channel(s)): ${isAudio ? v : `"${v}"`}`);
        if (!delivered) {
            this.log.warn('Announcement not delivered — no satellites registered (native or UDP).');
        }
    }

    /**
     * Deliver a ready 16-bit-mono-PCM buffer to one satellite (`targetId`) or all (`null`), over both
     * transports (ioBroker-native message bus + UDP). Returns how many channels it reached.
     */
    private async deliverPcm(
        pcm: Buffer,
        sampleRate: number,
        targetId: string | null,
        priority: boolean,
    ): Promise<number> {
        let delivered = 0;
        // ── ioBroker-native satellites: push over the message bus ───────────────
        const nativeTargets = targetId
            ? this.nativeSatFrom.has(targetId)
                ? [[targetId, this.nativeSatFrom.get(targetId)!] as const]
                : []
            : [...this.nativeSatFrom.entries()];
        for (const [, from] of nativeTargets) {
            this.sendTo(from, 'announce', { audio: pcm.toString('base64'), sampleRate, format: 'pcm', priority });
            delivered++;
        }
        // ── UDP satellites (if the UDP server runs and the target isn't a native one) ──
        if (this.voice && !(targetId && this.nativeSatFrom.has(targetId))) {
            const device = targetId ? this.satDeviceById.get(targetId) || targetId : null;
            try {
                await this.voice.announce(device, pcm, sampleRate);
                delivered++;
            } catch (e) {
                this.log.debug(`UDP announce failed: ${(e as Error).message}`);
            }
        }
        return delivered;
    }

    /**
     * Play an uploaded sound asset (a `sounds/*.mp3|wav|…` file in this instance's file storage) on the
     * satellites. Jingles bypass Do-Not-Disturb (a timer/alarm the user set should be heard). Returns the
     * jingle's duration in seconds so the caller can wait before speaking a following announcement.
     */
    private async playStoredSound(name: string, targetId: string | null): Promise<number> {
        const clean = (name || '').trim();
        if (!clean) {
            return 0;
        }
        // The fileSelector may return the name with or without its `sounds/` folder — try both.
        const candidates = clean.includes('/') ? [clean] : [clean, `sounds/${clean}`];
        let data: Buffer | null = null;
        for (const p of candidates) {
            try {
                const res = (await this.readFileAsync(this.namespace, p)) as { file?: Buffer | string } | Buffer | string;
                const f = Buffer.isBuffer(res) || typeof res === 'string' ? res : res.file;
                if (f != null) {
                    data = Buffer.isBuffer(f) ? f : Buffer.from(f as string, 'binary');
                    break;
                }
            } catch {
                /* try the next candidate */
            }
        }
        if (!data || !data.length) {
            throw new Error(`sound "${clean}" not found in ${this.namespace} file storage`);
        }
        const { pcm, sampleRate } = await this.decodeAudioBufferToPcm(data);
        const delivered = await this.deliverPcm(pcm, sampleRate, targetId, true);
        this.log.info(`Sound → ${targetId || 'all satellites'} (${delivered} channel(s)): ${clean}`);
        return pcm.length / 2 / sampleRate; // 16-bit mono → bytes/2 samples ÷ rate = seconds
    }

    /**
     * Play the configured jingle (if any) and then speak the announcement (if enabled), leaving a short gap
     * so they don't overlap on the satellite. Used by the timer/alarm fire handlers.
     */
    private async playAndAnnounce(
        sound: string,
        announce: boolean,
        text: string,
        targetId: string | null,
    ): Promise<void> {
        try {
            const dur = sound ? await this.playStoredSound(sound, targetId) : 0;
            if (dur > 0 && announce) {
                await this.delay(Math.min(dur * 1000 + 150, 10000)); // let the jingle finish first
            }
        } catch (e) {
            this.log.debug(`sound play failed: ${(e as Error).message}`);
        }
        if (announce) {
            await this.announceToSatellites(text, targetId);
        }
    }

    /** Decode an audio file/URL (mp3/wav/…) to mono 16-bit PCM via ffmpeg. */
    private decodeAudioToPcm(src: string): Promise<{ pcm: Buffer; sampleRate: number }> {
        return this.runFfmpegDecode(src);
    }

    /** Decode an in-memory audio buffer (uploaded mp3/wav) to mono 16-bit PCM via ffmpeg (stdin pipe). */
    private decodeAudioBufferToPcm(buf: Buffer): Promise<{ pcm: Buffer; sampleRate: number }> {
        return this.runFfmpegDecode('pipe:0', buf);
    }

    /** Run ffmpeg to decode `input` (a path/URL, or `pipe:0` with `stdinData`) to mono 16-bit PCM. */
    private runFfmpegDecode(input: string, stdinData?: Buffer): Promise<{ pcm: Buffer; sampleRate: number }> {
        return new Promise((resolve, reject) => {
            const sampleRate = 24000;
            // prettier-ignore
            const args = ['-hide_banner', '-loglevel', 'error', '-i', input, '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', '-'];
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
            if (stdinData) {
                proc.stdin.on('error', () => {}); // ignore EPIPE if ffmpeg exits early
                proc.stdin.end(stdinData);
            }
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
            await this.announceToSatellites(String(state.val ?? ''), satTts[1]); // satTts[1] = satellite state id
            return;
        }

        // Timer cancel controls: `timers.cancelAll` and each per-timer `timers.items.<id>.cancel`.
        if (id.endsWith('.timers.cancelAll')) {
            if (state.val) {
                const n = this.timers?.cancelAll() ?? 0;
                this.log.info(`Cancelled ${n} timer(s) via timers.cancelAll.`);
            }
            await this.setStateAsync('timers.cancelAll', { val: false, ack: true });
            return;
        }
        const timerCancel = id.match(/\.timers\.items\.([^.]+)\.cancel$/);
        if (timerCancel) {
            if (state.val && this.timers?.cancel(timerCancel[1])) {
                this.log.info(`Timer ${timerCancel[1]} cancelled via its cancel button.`);
            }
            return;
        }

        // Alarm controls: cancel-all, per-alarm delete button, and the enable/disable switch.
        if (id.endsWith('.alarms.cancelAll')) {
            if (state.val) {
                const n = this.alarms?.cancelAll() ?? 0;
                this.log.info(`Deleted ${n} alarm(s) via alarms.cancelAll.`);
            }
            await this.setStateAsync('alarms.cancelAll', { val: false, ack: true });
            return;
        }
        const alarmDelete = id.match(/\.alarms\.items\.([^.]+)\.delete$/);
        if (alarmDelete) {
            if (state.val && this.alarms?.cancel(alarmDelete[1])) {
                this.log.info(`Alarm ${alarmDelete[1]} deleted via its delete button.`);
            }
            return;
        }
        const alarmEnable = id.match(/\.alarms\.items\.([^.]+)\.enabled$/);
        if (alarmEnable) {
            this.alarms?.setEnabled(alarmEnable[1], !!state.val);
            return;
        }

        // Long-term memory controls: add a fact, forget by id/key, clear all, edit/delete a single fact.
        if (id.endsWith('.memory.add')) {
            const text = String(state.val ?? '').trim();
            if (text && this.memory?.add({ text, source: 'state' })) {
                this.log.info('Fact remembered via memory.add.');
            }
            await this.setStateAsync('memory.add', { val: '', ack: true });
            return;
        }
        if (id.endsWith('.memory.forget')) {
            const needle = String(state.val ?? '').trim();
            if (needle) {
                const n = this.memory?.forget(needle) ?? 0;
                this.log.info(`Forgot ${n} fact(s) via memory.forget.`);
            }
            await this.setStateAsync('memory.forget', { val: '', ack: true });
            return;
        }
        if (id.endsWith('.memory.clearAll')) {
            if (state.val) {
                const n = this.memory?.clear() ?? 0;
                this.log.info(`Forgot all ${n} fact(s) via memory.clearAll.`);
            }
            await this.setStateAsync('memory.clearAll', { val: false, ack: true });
            return;
        }
        const memDelete = id.match(/\.memory\.items\.([^.]+)\.delete$/);
        if (memDelete) {
            if (state.val && this.memory?.forgetById(memDelete[1])) {
                this.log.info(`Forgot fact ${memDelete[1]} via its button.`);
            }
            return;
        }
        const memEdit = id.match(/\.memory\.items\.([^.]+)\.text$/);
        if (memEdit) {
            this.memory?.update(memEdit[1], String(state.val ?? ''));
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
                    provider?: AdapterConfig['provider'];
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
                    provider?: AdapterConfig['provider'];
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
                await this.ensureLocalLlmStates();
                this.setLlmStatus('installing', 0);
                this.log.info('Installing local LLM engine (node-llama-cpp) — this may take a few minutes…');
                await installLocalLlm(dataDir, line => line && this.log.debug(`local-llm install: ${line}`));
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
                this.setLlmStatus('error');
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

        // STT model dropdown (Vosk): suggest model names for the selected language.
        if (obj.command === 'getSttModels') {
            const msg = (obj.message || {}) as { sttProvider?: SpeechProvider; language?: string };
            const cfg = this.config;
            const provider = msg.sttProvider || cfg.sttProvider || 'openai';
            const language = msg.language || cfg.voiceLanguage || this.language || '';
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, listSttModels(provider, language), obj.callback);
            }
            return;
        }

        // ioBroker-native satellite registration / heartbeat: makes it visible + enables announce push.
        if (obj.command === 'registerSatellite') {
            const m = (obj.message || {}) as { device?: string; room?: string; state?: SatelliteState | 'offline' };
            const device = m.device || 'satellite';
            const room = m.room || '';
            const satId = this.satelliteStateId(device, room);
            // Strip the `system.adapter.` prefix so we can push a fresh sendTo to the instance later.
            const from = String(obj.from).replace(/^system\.adapter\./, '');
            if (m.state === 'offline') {
                this.nativeSatFrom.delete(satId);
            } else {
                this.nativeSatFrom.set(satId, from);
            }
            await this.updateSatelliteState(device, room, m.state || 'idle');
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { ok: true, id: satId }, obj.callback);
            }
            return;
        }

        // ioBroker-native satellite: a recorded utterance over the message bus (no UDP) → reply audio + text.
        if (obj.command === 'voice') {
            const m = (obj.message || {}) as {
                audio?: string;
                format?: 'pcm' | 'wav';
                sampleRate?: number;
                source?: string;
                room?: string;
                language?: string;
            };
            // Remember the sender so announcements can be pushed back to this native satellite.
            const from = String(obj.from).replace(/^system\.adapter\./, '');
            this.nativeSatFrom.set(this.satelliteStateId(m.source || 'satellite', m.room || ''), from);
            const res = await this.handleVoiceQuery(m);
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, res, obj.callback);
            }
            return;
        }

        // Scripts: start a countdown timer. message = { duration: seconds | "5 min", label?, room? }.
        if (obj.command === 'setTimer') {
            const m = (obj.message || {}) as { duration?: number | string; label?: string; room?: string };
            const duration =
                typeof m.duration === 'string'
                    ? parseDurationSeconds(m.duration, true) || 0
                    : Math.round(Number(m.duration) || 0);
            let result: { ok: boolean; id?: string; fireAt?: number; error?: string };
            if (!this.timers || duration <= 0) {
                result = { ok: false, error: this.timers ? 'duration must be > 0 seconds' : 'timers not ready' };
            } else {
                const info = this.timers.add({ label: m.label || '', room: m.room || '', source: '', duration });
                result = { ok: true, id: info.id, fireAt: info.fireAt };
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, result, obj.callback);
            }
            return;
        }

        // Scripts: cancel a timer by id, or all when no id is given. message = { id? }.
        if (obj.command === 'cancelTimer') {
            const m = (obj.message || {}) as { id?: string };
            const cancelled = m.id ? (this.timers?.cancel(m.id) ? 1 : 0) : (this.timers?.cancelAll() ?? 0);
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { ok: true, cancelled }, obj.callback);
            }
            return;
        }

        // Scripts: list the running timers.
        if (obj.command === 'listTimers') {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { timers: this.timers?.list() || [] }, obj.callback);
            }
            return;
        }

        // Scripts: set an alarm. message = { hour, minute } | { time: "7:30" | "weck mich um 7" }, weekdays?, label?, room?.
        if (obj.command === 'setAlarm') {
            const m = (obj.message || {}) as {
                hour?: number;
                minute?: number;
                time?: string;
                weekdays?: number[];
                label?: string;
                room?: string;
            };
            let hour = typeof m.hour === 'number' ? m.hour : NaN;
            let minute = typeof m.minute === 'number' ? m.minute : 0;
            if (Number.isNaN(hour) && m.time) {
                const clock = parseClockTime(m.time);
                if (clock) {
                    hour = clock.hour;
                    minute = clock.minute;
                }
            }
            const weekdays = Array.isArray(m.weekdays)
                ? m.weekdays
                : m.time
                  ? parseWeekdays(m.time)
                  : [];
            let result: { ok: boolean; id?: string; nextFireAt?: number; error?: string };
            if (!this.alarms || Number.isNaN(hour)) {
                result = { ok: false, error: this.alarms ? 'hour/minute or a parseable time is required' : 'alarms not ready' };
            } else {
                const info = this.alarms.add({ label: m.label || '', room: m.room || '', source: '', hour, minute, weekdays });
                result = { ok: true, id: info.id, nextFireAt: info.nextFireAt };
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, result, obj.callback);
            }
            return;
        }

        // Scripts: delete an alarm by id, or all when no id is given. message = { id? }.
        if (obj.command === 'cancelAlarm') {
            const m = (obj.message || {}) as { id?: string };
            const deleted = m.id ? (this.alarms?.cancel(m.id) ? 1 : 0) : (this.alarms?.cancelAll() ?? 0);
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { ok: true, deleted }, obj.callback);
            }
            return;
        }

        // Scripts: list the configured alarms.
        if (obj.command === 'listAlarms') {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { alarms: this.alarms?.list() || [] }, obj.callback);
            }
            return;
        }

        // Scripts: remember a durable fact. message = { text, key? }.
        if (obj.command === 'saveMemory') {
            const m = (obj.message || {}) as { text?: string; key?: string };
            const entry = this.memory?.add({ text: String(m.text || ''), key: String(m.key || ''), source: 'script' });
            if (obj.callback) {
                this.sendTo(
                    obj.from,
                    obj.command,
                    entry ? { ok: true, id: entry.id } : { ok: false, error: this.memory ? 'empty text' : 'memory disabled' },
                    obj.callback,
                );
            }
            return;
        }

        // Scripts: forget a fact by id/key, or all when nothing is given. message = { idOrKey? }.
        if (obj.command === 'forgetMemory') {
            const m = (obj.message || {}) as { idOrKey?: string };
            const forgotten = m.idOrKey ? (this.memory?.forget(m.idOrKey) ?? 0) : (this.memory?.clear() ?? 0);
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { ok: true, forgotten }, obj.callback);
            }
            return;
        }

        // Scripts: list remembered facts.
        if (obj.command === 'listMemories') {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { memories: this.memory?.list() || [] }, obj.callback);
            }
            return;
        }

        // Settings "Play" button / scripts: play an uploaded sound on the satellites. message = { name, target? }.
        if (obj.command === 'playSound') {
            const m = (obj.message || {}) as { name?: string; target?: string };
            const target = m.target ? this.announceTargetForSource(m.target) || m.target : null;
            let result: { ok: boolean; duration?: number; error?: string };
            try {
                const duration = await this.playStoredSound(String(m.name || ''), target);
                result = duration ? { ok: true, duration } : { ok: false, error: 'no sound selected' };
            } catch (e) {
                result = { ok: false, error: (e as Error).message };
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, result, obj.callback);
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
        const message = obj.message as { text?: string; source?: string } | string;
        const text = typeof message === 'string' ? message : message?.text;
        // Origin for text.querySource: caller-provided (e.g. 'telegram:Max') or 'chat' for the admin chat.
        const source = (typeof message === 'string' ? '' : message?.source?.trim()) || 'chat';

        if (!this.agent) {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { error: 'agent not ready' }, obj.callback);
            }
            return;
        }
        const question = String(text ?? '');
        this.log.info(`Q (${obj.command}): ${question}`);
        this.setStateAsync('text.request', { val: question, ack: true }).catch(() => {});
        this.setQuerySource(source);
        try {
            const answer = await this.answer(question, source);
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
    /**
     * Answer a request, keyed by `source` for short-term conversation context (follow-ups). The context
     * is applied to the cloud LLM tier; every completed exchange (whichever tier answered) is recorded so
     * later turns have the full thread.
     */
    private async answer(question: string, source = ''): Promise<string> {
        const useCtx = this.config.useConversationContext !== false;
        const history = useCtx ? this.context.get(source) : [];
        const result = await this.produceAnswer(question, history, source);
        if (useCtx && result) {
            this.context.add(source, question, result);
        }
        return result;
    }

    private async produceAnswer(question: string, history: ConversationTurn[], source = ''): Promise<string> {
        // Tier 0: rule-based NLU (device commands) — fastest, offline, free.
        if (this.config.useLocalNlu) {
            try {
                const handled = await this.tryLocalNlu(question, source);
                if (handled !== null) {
                    this.log.debug(`NLU handled locally: "${question}" → "${handled}"`);
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
        const mem = this.buildMemoryContext();
        const parts = [this.config.systemPrompt || '', mem, ctx].filter(Boolean);
        const sys = parts.length ? parts.join('\n\n') : undefined;
        return this.agent.ask(question, sys, history);
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

    /** Writable per-instance data dir via the adapter-core function (with a fallback for old runtimes). */
    private instanceDataDir(): string {
        try {
            return getAbsoluteInstanceDataDir(this);
        } catch {
            return path.join(getAbsoluteDefaultDataDir(), this.namespace);
        }
    }

    /** Create the `localLlm.status`/`localLlm.progress` states (once) for the GUI progress display. */
    private async ensureLocalLlmStates(): Promise<void> {
        await this.setObjectNotExistsAsync('localLlm', {
            type: 'channel',
            common: { name: 'Local LLM' },
            native: {},
        });
        await this.setObjectNotExistsAsync('localLlm.status', {
            type: 'state',
            common: {
                name: 'Local LLM status',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: 'idle',
            },
            native: {},
        });
        await this.setObjectNotExistsAsync('localLlm.progress', {
            type: 'state',
            common: {
                name: 'Local LLM download progress',
                type: 'number',
                role: 'value',
                unit: '%',
                min: 0,
                max: 100,
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });
    }

    /** Update the local-LLM status (and optionally the download percent) states. */
    private setLlmStatus(status: string, progress?: number): void {
        this.setStateAsync('localLlm.status', { val: status, ack: true }).catch(() => {});
        if (progress !== undefined) {
            this.setStateAsync('localLlm.progress', { val: progress, ack: true }).catch(() => {});
        }
    }

    /** Parse a `download NN%` line into the progress state (throttled to whole-percent changes; no log spam). */
    private onLocalLlmProgress(line: string): void {
        const m = /download\s+(\d+)%/i.exec(line);
        if (m) {
            const pct = parseInt(m[1], 10);
            if (pct !== this.lastLlmPct) {
                this.lastLlmPct = pct;
                this.setLlmStatus('downloading', pct);
                if (pct % 25 === 0) {
                    this.log.debug(`local model download ${pct}%`);
                }
            }
            return;
        }
        this.log.debug(`local-llm: ${line}`);
    }

    /**
     * Lazily load the local LLM (Tier 1a) when enabled + installed. Runs in the background — the model
     * download can take a while — so callers should not await it on the hot path.
     */
    private async ensureLocalLlm(): Promise<void> {
        if (this.localLlm) {
            this.setLlmStatus('ready', 100); // already loaded (e.g. warmed up at start) — reflect that
            return;
        }
        if (this.localLlmLoading) {
            return this.localLlmLoading; // a load is in flight; it manages the status itself
        }
        const dataDir = this.instanceDataDir();
        await this.ensureLocalLlmStates();
        if (!isLocalLlmInstalled(dataDir)) {
            this.setLlmStatus('not installed');
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
        this.lastLlmPct = -1;
        this.setLlmStatus('loading');
        this.localLlmLoading = llm
            .load(line => this.onLocalLlmProgress(line))
            .then(() => {
                this.localLlm = llm;
                this.setLlmStatus('ready', 100);
                this.log.info('Local model ready.');
            })
            .catch(e => {
                this.setLlmStatus('error');
                this.log.warn(`Local LLM load failed: ${(e as Error).message}`);
            })
            .finally(() => {
                this.localLlmLoading = null;
            });
        return this.localLlmLoading;
    }

    /** Run the rule-based NLU; returns a response string if it produced an executable intent, else null. */
    private async tryLocalNlu(question: string, source = ''): Promise<string | null> {
        if (!this.mcp) {
            return null;
        }
        // Timer intents match device-independently (parse() checks them first), so build the NLU even
        // when no devices are known and always try timers before bailing out.
        const { rooms, devices } = await this.getNluDevices();
        const intent = new Nlu(rooms, devices).parse(question);
        if (!intent) {
            return null;
        }
        if (intent.action === 'timerSet' || intent.action === 'timerQuery' || intent.action === 'timerCancel') {
            return this.timers ? this.executeTimerIntent(intent, source) : null;
        }
        if (intent.action === 'alarmSet' || intent.action === 'alarmQuery' || intent.action === 'alarmCancel') {
            return this.alarms ? this.executeAlarmIntent(intent, source) : null;
        }
        if (!devices.length) {
            return null;
        }
        // Writes require the coarse toggle; if off, let the LLM explain instead of silently doing nothing.
        const isWrite = ['on', 'off', 'level', 'color'].includes(intent.action);
        if (isWrite && !this.config.allowWriteStates) {
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
                    const types: Record<string, string> = {};
                    const stateIds: string[] = [];
                    for (const [ct, c] of Object.entries(dev.controls || {})) {
                        if (c?.stateId) {
                            controls[ct] = c.stateId;
                            writable[ct] = !!c.writable;
                            types[ct] = (c as { ioBrokerValueType?: string }).ioBrokerValueType || '';
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
                    devices.push({
                        name,
                        room: roomName,
                        type: String(dev.deviceType ?? ''),
                        controls,
                        writable,
                        types,
                    });
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
        // Aggregate query ("which windows are open") — reads many devices, not a single one.
        if (intent.action === 'listByState') {
            return this.executeListByState(intent);
        }
        const device = intent.device;
        if (!device) {
            return '';
        }
        // Respond in the assistant's interaction language (voice language, else system).
        const lang = String(this.config.voiceLanguage || this.language || 'en');
        const ru = lang === 'ru';
        const de = lang === 'de';
        const pick = (rus: string, ger: string, eng: string): string => (ru ? rus : de ? ger : eng);
        const room = intent.room || device.room;
        // Appositive room qualifier "(<Raum>)" — grammatically safe in every language and reads fine aloud.
        const where = room ? ` (${room})` : '';
        const dev = device.name;

        // Per-device ACL (key = primary state id, same as the ACL editor / read+write guards).
        const key = deviceKey(Object.values(device.controls));

        if (intent.action === 'query') {
            if (this.config.deviceAcl?.[key]?.read === false) {
                return pick(
                    `${dev}${where} нельзя прочитать.`,
                    `${dev}${where} kann nicht gelesen werden.`,
                    `${dev}${where} cannot be read.`,
                );
            }
            this.log.debug(`NLU query ${device.name}: get_states ${intent.stateId}`);
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
                const obj = await this.getForeignObjectAsync(intent.stateId || '');
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

        this.log.debug(
            `NLU control ${device.name} (${intent.action}): set_state ${intent.stateId} = ${JSON.stringify(intent.value)}`,
        );
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

    /**
     * Aggregate query "which windows are open": read every window's state and name the open ones
     * (respecting the per-device read ACL). Answers in the interaction language (de/en/ru).
     */
    private async executeListByState(intent: NluIntent): Promise<string> {
        const mcp = this.mcp;
        if (!mcp) {
            throw new Error('mcp not ready');
        }
        const lang = String(this.config.voiceLanguage || this.language || 'en');
        const ru = lang === 'ru';
        const de = lang === 'de';
        const pick = (rus: string, ger: string, eng: string): string => (ru ? rus : de ? ger : eng);

        // Each window's readable state (skip read-disabled devices), deduped.
        const acl = this.config.deviceAcl || {};
        const list = (intent.devices || [])
            .map(d => {
                const ids = Object.values(d.controls);
                return { name: d.name, room: d.room, key: deviceKey(ids), stateId: ids[0] };
            })
            .filter(w => w.stateId && acl[w.key]?.read !== false);
        if (!list.length) {
            return pick('Окна не найдены.', 'Keine Fenster gefunden.', 'No windows found.');
        }

        let states: { id?: string; value?: unknown }[] = [];
        try {
            const res = await mcp.callTool('get_states', { ids: list.map(w => w.stateId) });
            states =
                (JSON.parse(res.text) as { data?: { states?: { id?: string; value?: unknown }[] } }).data?.states || [];
        } catch {
            states = [];
        }
        const valueById = new Map(states.map(s => [s.id, s.value]));
        // A window/contact sensor reports open as a truthy value.
        const isOpen = (v: unknown): boolean => v === true || v === 'true' || v === 1 || v === 'open';
        const open = list.filter(w => isOpen(valueById.get(w.stateId)));

        if (!open.length) {
            return pick('Все окна закрыты.', 'Alle Fenster sind geschlossen.', 'All windows are closed.');
        }
        const names = open.map(w => (w.room ? `${w.name} (${w.room})` : w.name)).join(', ');
        return pick(`Открыты: ${names}.`, `Offen: ${names}.`, `Open: ${names}.`);
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

    // ── Timers / reminders (roadmap #2) ─────────────────────────────────────

    /**
     * Create the timer manager and wire it to the ioBroker state tree: `onChange` mirrors the active
     * timers into `timers.*` (+ per-timer `timers.items.<id>.*`) and `onFire` announces the expiry. States
     * carry the absolute `fireAt` timestamp only — no per-second countdown writes — so nothing updates
     * periodically; a vis/script derives the live "remaining" from `fireAt`. Stale per-timer objects from a
     * previous run are dropped before restoring the persisted list.
     */
    private async setupTimers(): Promise<void> {
        this.timers = new TimerManager({
            now: () => Date.now(),
            log: this.log,
            onFire: t => this.onTimerFired(t),
            onChange: list => void this.renderTimers(list).catch(e => this.log.debug(`renderTimers: ${e}`)),
        });
        // Cancel controls: the global "cancel all" and each per-timer `.cancel` button.
        this.subscribeStates('timers.cancelAll');
        this.subscribeStates('timers.items.*');
        // Drop any per-timer objects left over from before the restart; restore then recreates the live ones.
        await this.delObjectAsync('timers.items', { recursive: true }).catch(() => {});
        this.timerObjIds.clear();
        await this.restoreTimers();
    }

    /** Restore timers persisted in `timers.list` across a restart (future ones rescheduled, expired dropped). */
    private async restoreTimers(): Promise<void> {
        if (!this.timers) {
            return;
        }
        let arr: TimerInfo[] = [];
        try {
            const st = await this.getStateAsync('timers.list');
            if (typeof st?.val === 'string' && st.val) {
                arr = JSON.parse(st.val) as TimerInfo[];
            }
        } catch (e) {
            this.log.debug(`restoreTimers parse failed: ${(e as Error).message}`);
        }
        if (!Array.isArray(arr) || !arr.length) {
            await this.renderTimers([]); // reset the summary states to "no timers"
            return;
        }
        const { restored, dropped } = this.timers.restore(arr);
        if (restored) {
            this.log.info(`Restored ${restored} timer(s) after restart.`);
        }
        if (dropped) {
            this.log.info(`Dropped ${dropped} timer(s) that expired while the adapter was down.`);
        }
    }

    /** Mirror the active-timer list into the summary states and the per-timer `timers.items.<id>` objects. */
    private async renderTimers(list: TimerInfo[]): Promise<void> {
        const next = list[0]; // sorted soonest-first by the manager
        await this.setStateAsync('timers.count', { val: list.length, ack: true });
        await this.setStateAsync('timers.list', { val: JSON.stringify(list), ack: true });
        await this.setStateAsync('timers.nextExpiry', { val: next ? next.fireAt : 0, ack: true });
        await this.setStateAsync('timers.nextLabel', { val: next?.label || '', ack: true });

        const wanted = new Set(list.map(t => t.id));
        for (const id of [...this.timerObjIds]) {
            if (!wanted.has(id)) {
                await this.delObjectAsync(`timers.items.${id}`, { recursive: true }).catch(() => {});
                this.timerObjIds.delete(id);
            }
        }
        if (list.length) {
            await this.setObjectNotExistsAsync('timers.items', {
                type: 'channel',
                common: { name: 'Active timers' },
                native: {},
            });
        }
        for (const t of list) {
            await this.ensureTimerObject(t);
        }
    }

    /**
     * Create (once) and update the `timers.items.<id>.*` states for a single timer. Only absolute values
     * (`fireAt`, `duration`) are written — the live countdown is derived from `fireAt` by the consumer, so
     * these states are written once per timer, not on a periodic tick.
     */
    private async ensureTimerObject(t: TimerInfo): Promise<void> {
        const base = `timers.items.${t.id}`;
        if (!this.timerObjIds.has(t.id)) {
            await this.setObjectNotExistsAsync(base, {
                type: 'channel',
                common: { name: t.label || 'Timer' },
                native: {},
            });
            const mk = (sub: string, common: ioBroker.StateCommon): Promise<unknown> =>
                this.setObjectNotExistsAsync(`${base}.${sub}`, { type: 'state', common, native: {} });
            await mk('label', { name: 'Label', type: 'string', role: 'text', read: true, write: false });
            await mk('room', { name: 'Room', type: 'string', role: 'text', read: true, write: false });
            await mk('duration', { name: 'Duration', type: 'number', role: 'value.interval', unit: 's', read: true, write: false });
            await mk('fireAt', { name: 'Fires at', type: 'number', role: 'value.time', read: true, write: false });
            await mk('cancel', { name: 'Cancel this timer', type: 'boolean', role: 'button', read: false, write: true, def: false });
            this.timerObjIds.add(t.id);
        }
        await this.setStateAsync(`${base}.label`, { val: t.label, ack: true });
        await this.setStateAsync(`${base}.room`, { val: t.room, ack: true });
        await this.setStateAsync(`${base}.duration`, { val: t.duration, ack: true });
        await this.setStateAsync(`${base}.fireAt`, { val: t.fireAt, ack: true });
    }

    /** A timer expired: record it, play the jingle (if any) and speak the announcement on the origin satellite. */
    private onTimerFired(t: TimerInfo): void {
        this.log.info(`Timer fired: "${t.label || '(no label)'}"${t.room ? ` (${t.room})` : ''}`);
        this.setStateAsync('timers.lastFired', { val: t.label || t.id, ack: true }).catch(() => {});
        const announce = this.config.timerAnnounce !== false;
        const target = this.announceTargetForSource(t.source);
        void this.playAndAnnounce(this.config.timerSound || '', announce, this.timerAnnounceMessage(t), target).catch(
            e => this.log.debug(`timer effects failed: ${(e as Error).message}`),
        );
    }

    /** Build the spoken expiry message ("Timer abgelaufen: die Nudeln.") in the interaction language. */
    private timerAnnounceMessage(t: TimerInfo): string {
        const lang = String(this.config.voiceLanguage || this.language || 'en');
        const ru = lang === 'ru';
        const de = lang === 'de';
        const pick = (rus: string, ger: string, eng: string): string => (ru ? rus : de ? ger : eng);
        if (t.label) {
            return pick(`Таймер сработал: ${t.label}.`, `Timer abgelaufen: ${t.label}.`, `Timer finished: ${t.label}.`);
        }
        const dur = formatDuration(t.duration, lang);
        return pick(`Таймер на ${dur} сработал.`, `Timer über ${dur} ist abgelaufen.`, `Your ${dur} timer is done.`);
    }

    /**
     * Resolve a request source (satellite device name / 'chat' / '') to an announcement target id, so a
     * timer rings on the satellite it was set from. Returns null (→ broadcast to all) when the source is
     * the chat/text interface or the originating satellite is no longer known.
     */
    private announceTargetForSource(source: string): string | null {
        if (!source || source === 'chat' || source === 'wyoming') {
            return null;
        }
        for (const [id, device] of this.satDeviceById) {
            if (device === source) {
                return id;
            }
        }
        if (this.satDeviceById.has(source) || this.nativeSatFrom.has(source)) {
            return source;
        }
        return null;
    }

    /** Execute a timer intent (set/query/cancel) from the NLU and return a spoken-style reply. */
    private async executeTimerIntent(intent: NluIntent, source: string): Promise<string> {
        const mgr = this.timers;
        if (!mgr) {
            return '';
        }
        const lang = String(this.config.voiceLanguage || this.language || 'en');
        const ru = lang === 'ru';
        const de = lang === 'de';
        const pick = (rus: string, ger: string, eng: string): string => (ru ? rus : de ? ger : eng);

        if (intent.action === 'timerSet') {
            const info = mgr.add({
                label: intent.label || '',
                room: intent.room || '',
                source,
                duration: intent.durationSec || 0,
            });
            const dur = formatDuration(info.duration, lang);
            const tail = info.label ? ` (${info.label})` : '';
            return pick(`Таймер на ${dur} установлен${tail}.`, `Timer auf ${dur} gestellt${tail}.`, `Timer set for ${dur}${tail}.`);
        }

        if (intent.action === 'timerCancel') {
            let victims = mgr.list();
            if (intent.room) {
                victims = victims.filter(t => t.room === intent.room);
            }
            if (intent.label) {
                const l = intent.label.toLowerCase();
                const byLabel = victims.filter(t => t.label && t.label.toLowerCase().includes(l));
                if (byLabel.length) {
                    victims = byLabel;
                }
            }
            if (!victims.length) {
                return pick('Активных таймеров нет.', 'Es laufen keine Timer.', 'There are no timers running.');
            }
            for (const t of victims) {
                mgr.cancel(t.id);
            }
            if (victims.length === 1) {
                return pick('Таймер отменён.', 'Timer abgebrochen.', 'Timer cancelled.');
            }
            return pick(`Отменено таймеров: ${victims.length}.`, `${victims.length} Timer abgebrochen.`, `Cancelled ${victims.length} timers.`);
        }

        // timerQuery
        let list = mgr.list();
        if (intent.room) {
            list = list.filter(t => t.room === intent.room);
        }
        if (!list.length) {
            return pick('Активных таймеров нет.', 'Es laufen keine Timer.', 'There are no timers running.');
        }
        const now = Date.now();
        const parts = list.map(t => {
            const rem = formatDuration(Math.max(0, Math.round((t.fireAt - now) / 1000)), lang);
            return t.label
                ? pick(`${t.label}: ещё ${rem}`, `${t.label}: noch ${rem}`, `${t.label}: ${rem} left`)
                : pick(`ещё ${rem}`, `noch ${rem}`, `${rem} left`);
        });
        return `${parts.join(', ')}.`;
    }

    /** LLM tools for timers (set/list/cancel), appended to the MCP tool set so the cloud model can use them. */
    private buildTimerTools(): Tool[] {
        const summarize = (t: TimerInfo): Record<string, unknown> => ({
            id: t.id,
            label: t.label,
            room: t.room,
            durationSec: t.duration,
            fireAt: t.fireAt,
            remainingSec: Math.max(0, Math.round((t.fireAt - Date.now()) / 1000)),
        });
        return [
            {
                name: 'set_timer',
                description:
                    'Start a countdown timer / reminder that announces on the satellite when it expires. duration is in whole seconds; label and room are optional.',
                parameters: {
                    type: 'object',
                    properties: {
                        duration: { type: 'number', description: 'Duration in seconds (> 0)' },
                        label: { type: 'string', description: 'Optional label, e.g. "pasta"' },
                        room: { type: 'string', description: 'Optional room' },
                    },
                    required: ['duration'],
                    additionalProperties: false,
                },
                run: (args): Promise<string> => {
                    if (!this.timers) {
                        return Promise.resolve(JSON.stringify({ ok: false, error: 'timers unavailable' }));
                    }
                    const duration = Math.round(Number(args.duration) || 0);
                    if (duration <= 0) {
                        return Promise.resolve(JSON.stringify({ ok: false, error: 'duration must be > 0 seconds' }));
                    }
                    const info = this.timers.add({
                        label: String(args.label || ''),
                        room: String(args.room || ''),
                        source: '',
                        duration,
                    });
                    return Promise.resolve(JSON.stringify({ ok: true, data: summarize(info) }));
                },
            },
            {
                name: 'list_timers',
                description: 'List the currently running countdown timers with their remaining time.',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
                run: (): Promise<string> =>
                    Promise.resolve(JSON.stringify({ ok: true, data: (this.timers?.list() || []).map(summarize) })),
            },
            {
                name: 'cancel_timer',
                description: 'Cancel a running timer by its id, or all timers when no id is given.',
                parameters: {
                    type: 'object',
                    properties: { id: { type: 'string', description: 'Timer id from list_timers; omit to cancel all' } },
                    additionalProperties: false,
                },
                run: (args): Promise<string> => {
                    if (!this.timers) {
                        return Promise.resolve(JSON.stringify({ ok: false, error: 'timers unavailable' }));
                    }
                    if (args.id) {
                        const ok = this.timers.cancel(String(args.id));
                        return Promise.resolve(JSON.stringify({ ok, data: { cancelled: ok ? 1 : 0 } }));
                    }
                    const n = this.timers.cancelAll();
                    return Promise.resolve(JSON.stringify({ ok: true, data: { cancelled: n } }));
                },
            },
        ];
    }

    // ── Alarms / wake-ups at a fixed clock time (roadmap #2) ────────────────

    /**
     * Create the alarm manager and mirror it into `alarms.*` (+ per-alarm `alarms.items.<id>.*`). Like the
     * timers, states carry only the absolute `nextFireAt` — nothing is written periodically. Stale per-alarm
     * objects from a previous run are dropped before restoring the persisted list.
     */
    private async setupAlarms(): Promise<void> {
        this.alarms = new AlarmManager({
            now: () => Date.now(),
            log: this.log,
            onFire: a => this.onAlarmFired(a),
            onChange: list => void this.renderAlarms(list).catch(e => this.log.debug(`renderAlarms: ${e}`)),
        });
        this.subscribeStates('alarms.cancelAll');
        this.subscribeStates('alarms.items.*');
        await this.delObjectAsync('alarms.items', { recursive: true }).catch(() => {});
        this.alarmObjIds.clear();
        await this.restoreAlarms();
    }

    /** Restore alarms persisted in `alarms.list` across a restart (recompute next fire; drop missed one-shots). */
    private async restoreAlarms(): Promise<void> {
        if (!this.alarms) {
            return;
        }
        let arr: AlarmInfo[] = [];
        try {
            const st = await this.getStateAsync('alarms.list');
            if (typeof st?.val === 'string' && st.val) {
                arr = JSON.parse(st.val) as AlarmInfo[];
            }
        } catch (e) {
            this.log.debug(`restoreAlarms parse failed: ${(e as Error).message}`);
        }
        if (!Array.isArray(arr) || !arr.length) {
            await this.renderAlarms([]);
            return;
        }
        const { restored, dropped } = this.alarms.restore(arr);
        if (restored) {
            this.log.info(`Restored ${restored} alarm(s) after restart.`);
        }
        if (dropped) {
            this.log.info(`Dropped ${dropped} one-shot alarm(s) that were due while the adapter was down.`);
        }
    }

    /** Mirror the alarm list into the summary states and the per-alarm `alarms.items.<id>` objects. */
    private async renderAlarms(list: AlarmInfo[]): Promise<void> {
        const upcoming = list.filter(a => a.enabled && a.nextFireAt);
        const next = upcoming[0];
        await this.setStateAsync('alarms.count', { val: list.length, ack: true });
        await this.setStateAsync('alarms.list', { val: JSON.stringify(list), ack: true });
        await this.setStateAsync('alarms.nextAlarm', { val: next ? next.nextFireAt : 0, ack: true });
        await this.setStateAsync('alarms.nextLabel', {
            val: next ? next.label || formatClock(next.hour, next.minute) : '',
            ack: true,
        });

        const wanted = new Set(list.map(a => a.id));
        for (const id of [...this.alarmObjIds]) {
            if (!wanted.has(id)) {
                await this.delObjectAsync(`alarms.items.${id}`, { recursive: true }).catch(() => {});
                this.alarmObjIds.delete(id);
            }
        }
        if (list.length) {
            await this.setObjectNotExistsAsync('alarms.items', {
                type: 'channel',
                common: { name: 'Alarms' },
                native: {},
            });
        }
        for (const a of list) {
            await this.ensureAlarmObject(a);
        }
    }

    /** Create (once) and update the `alarms.items.<id>.*` states for a single alarm. */
    private async ensureAlarmObject(a: AlarmInfo): Promise<void> {
        const base = `alarms.items.${a.id}`;
        if (!this.alarmObjIds.has(a.id)) {
            await this.setObjectNotExistsAsync(base, {
                type: 'channel',
                common: { name: a.label || `Alarm ${formatClock(a.hour, a.minute)}` },
                native: {},
            });
            const mk = (sub: string, common: ioBroker.StateCommon): Promise<unknown> =>
                this.setObjectNotExistsAsync(`${base}.${sub}`, { type: 'state', common, native: {} });
            await mk('label', { name: 'Label', type: 'string', role: 'text', read: true, write: false });
            await mk('room', { name: 'Room', type: 'string', role: 'text', read: true, write: false });
            await mk('time', { name: 'Time (HH:MM)', type: 'string', role: 'text', read: true, write: false });
            await mk('weekdays', { name: 'Weekdays (0=Sun..6=Sat, empty=once)', type: 'string', role: 'text', read: true, write: false });
            await mk('nextFireAt', { name: 'Next fire', type: 'number', role: 'value.time', read: true, write: false });
            await mk('enabled', { name: 'Enabled', type: 'boolean', role: 'switch.enable', read: true, write: true, def: true });
            await mk('delete', { name: 'Delete this alarm', type: 'boolean', role: 'button', read: false, write: true, def: false });
            this.alarmObjIds.add(a.id);
        }
        await this.setStateAsync(`${base}.label`, { val: a.label, ack: true });
        await this.setStateAsync(`${base}.room`, { val: a.room, ack: true });
        await this.setStateAsync(`${base}.time`, { val: formatClock(a.hour, a.minute), ack: true });
        await this.setStateAsync(`${base}.weekdays`, { val: a.weekdays.join(','), ack: true });
        await this.setStateAsync(`${base}.nextFireAt`, { val: a.nextFireAt, ack: true });
        await this.setStateAsync(`${base}.enabled`, { val: a.enabled, ack: true });
    }

    /** An alarm fired: record it, play the jingle (if any) and speak the announcement on the origin satellite. */
    private onAlarmFired(a: AlarmInfo): void {
        this.log.info(`Alarm fired: "${a.label || formatClock(a.hour, a.minute)}"${a.room ? ` (${a.room})` : ''}`);
        this.setStateAsync('alarms.lastFired', { val: a.label || formatClock(a.hour, a.minute), ack: true }).catch(() => {});
        const announce = this.config.alarmAnnounce !== false;
        const lang = String(this.config.voiceLanguage || this.language || 'en');
        const ru = lang === 'ru';
        const de = lang === 'de';
        const pick = (rus: string, ger: string, eng: string): string => (ru ? rus : de ? ger : eng);
        const clock = formatClock(a.hour, a.minute);
        const msg = a.label
            ? pick(`Будильник: ${a.label}.`, `Wecker: ${a.label}.`, `Alarm: ${a.label}.`)
            : pick(`Будильник, ${clock}.`, `Wecker, es ist ${clock} Uhr.`, `Alarm, it is ${clock}.`);
        const target = this.announceTargetForSource(a.source);
        void this.playAndAnnounce(this.config.alarmSound || '', announce, msg, target).catch(e =>
            this.log.debug(`alarm effects failed: ${(e as Error).message}`),
        );
    }

    /** Execute an alarm intent (set/query/cancel) from the NLU and return a spoken-style reply. */
    private async executeAlarmIntent(intent: NluIntent, source: string): Promise<string> {
        const mgr = this.alarms;
        if (!mgr) {
            return '';
        }
        const lang = String(this.config.voiceLanguage || this.language || 'en');
        const ru = lang === 'ru';
        const de = lang === 'de';
        const pick = (rus: string, ger: string, eng: string): string => (ru ? rus : de ? ger : eng);

        if (intent.action === 'alarmSet') {
            const info = mgr.add({
                label: intent.label || '',
                room: intent.room || '',
                source,
                hour: intent.hour ?? 0,
                minute: intent.minute ?? 0,
                weekdays: intent.weekdays || [],
            });
            const clock = formatClock(info.hour, info.minute);
            const rec = formatWeekdays(info.weekdays, lang);
            const when = rec ? ` (${rec})` : '';
            return pick(
                `Будильник на ${clock}${when} установлен.`,
                `Wecker auf ${clock} Uhr${when} gestellt.`,
                `Alarm set for ${clock}${when}.`,
            );
        }

        if (intent.action === 'alarmCancel') {
            let victims = mgr.list();
            if (intent.room) {
                victims = victims.filter(a => a.room === intent.room);
            }
            if (intent.label) {
                const l = intent.label.toLowerCase();
                const byLabel = victims.filter(a => a.label && a.label.toLowerCase().includes(l));
                if (byLabel.length) {
                    victims = byLabel;
                }
            }
            if (!victims.length) {
                return pick('Будильников нет.', 'Es sind keine Wecker gestellt.', 'There are no alarms set.');
            }
            for (const a of victims) {
                mgr.cancel(a.id);
            }
            if (victims.length === 1) {
                return pick('Будильник удалён.', 'Wecker gelöscht.', 'Alarm deleted.');
            }
            return pick(`Удалено будильников: ${victims.length}.`, `${victims.length} Wecker gelöscht.`, `Deleted ${victims.length} alarms.`);
        }

        // alarmQuery
        let list = mgr.list();
        if (intent.room) {
            list = list.filter(a => a.room === intent.room);
        }
        if (!list.length) {
            return pick('Будильников нет.', 'Es sind keine Wecker gestellt.', 'There are no alarms set.');
        }
        const parts = list.map(a => {
            const clock = formatClock(a.hour, a.minute);
            const rec = formatWeekdays(a.weekdays, lang);
            const off = a.enabled ? '' : pick(' (выкл.)', ' (aus)', ' (off)');
            const base = a.label ? `${a.label}: ${clock}` : clock;
            return rec ? `${base} ${rec}${off}` : `${base}${off}`;
        });
        return `${parts.join(', ')}.`;
    }

    /** LLM tools for alarms (set/list/cancel), appended to the MCP tool set. */
    private buildAlarmTools(): Tool[] {
        const summarize = (a: AlarmInfo): Record<string, unknown> => ({
            id: a.id,
            label: a.label,
            room: a.room,
            time: formatClock(a.hour, a.minute),
            weekdays: a.weekdays,
            enabled: a.enabled,
            nextFireAt: a.nextFireAt,
        });
        return [
            {
                name: 'set_alarm',
                description:
                    'Set an alarm / wake-up at a fixed clock time that announces on the satellite. hour 0-23, minute 0-59; weekdays is an optional array (0=Sunday..6=Saturday) for a recurring alarm (empty = one-shot at the next occurrence); label and room are optional.',
                parameters: {
                    type: 'object',
                    properties: {
                        hour: { type: 'number', description: 'Hour 0-23' },
                        minute: { type: 'number', description: 'Minute 0-59' },
                        weekdays: {
                            type: 'array',
                            items: { type: 'number' },
                            description: '0=Sunday..6=Saturday; omit/empty for a one-shot alarm',
                        },
                        label: { type: 'string' },
                        room: { type: 'string' },
                    },
                    required: ['hour', 'minute'],
                    additionalProperties: false,
                },
                run: (args): Promise<string> => {
                    if (!this.alarms) {
                        return Promise.resolve(JSON.stringify({ ok: false, error: 'alarms unavailable' }));
                    }
                    const hour = Number(args.hour);
                    const minute = Number(args.minute);
                    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
                        return Promise.resolve(JSON.stringify({ ok: false, error: 'hour and minute are required' }));
                    }
                    const weekdays = Array.isArray(args.weekdays) ? (args.weekdays as unknown[]).map(Number) : [];
                    const info = this.alarms.add({
                        label: String(args.label || ''),
                        room: String(args.room || ''),
                        source: '',
                        hour,
                        minute,
                        weekdays,
                    });
                    return Promise.resolve(JSON.stringify({ ok: true, data: summarize(info) }));
                },
            },
            {
                name: 'list_alarms',
                description: 'List the configured alarms with their time, recurrence and next fire.',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
                run: (): Promise<string> =>
                    Promise.resolve(JSON.stringify({ ok: true, data: (this.alarms?.list() || []).map(summarize) })),
            },
            {
                name: 'cancel_alarm',
                description: 'Delete an alarm by its id, or all alarms when no id is given.',
                parameters: {
                    type: 'object',
                    properties: { id: { type: 'string', description: 'Alarm id from list_alarms; omit to delete all' } },
                    additionalProperties: false,
                },
                run: (args): Promise<string> => {
                    if (!this.alarms) {
                        return Promise.resolve(JSON.stringify({ ok: false, error: 'alarms unavailable' }));
                    }
                    if (args.id) {
                        const ok = this.alarms.cancel(String(args.id));
                        return Promise.resolve(JSON.stringify({ ok, data: { deleted: ok ? 1 : 0 } }));
                    }
                    const n = this.alarms.cancelAll();
                    return Promise.resolve(JSON.stringify({ ok: true, data: { deleted: n } }));
                },
            },
        ];
    }

    // ── Long-term memory (roadmap #6) ───────────────────────────────────────

    /** Create the memory store and mirror it into `memory.*` (+ per-entry `memory.items.<id>.*`). */
    private async setupMemory(): Promise<void> {
        this.memory = new MemoryStore({
            log: this.log,
            onChange: list => void this.renderMemory(list).catch(e => this.log.debug(`renderMemory: ${e}`)),
        });
        this.subscribeStates('memory.add');
        this.subscribeStates('memory.forget');
        this.subscribeStates('memory.clearAll');
        this.subscribeStates('memory.items.*');
        await this.delObjectAsync('memory.items', { recursive: true }).catch(() => {});
        this.memoryObjIds.clear();
        await this.restoreMemory();
    }

    /** Restore facts persisted in `memory.list` across a restart. */
    private async restoreMemory(): Promise<void> {
        if (!this.memory) {
            return;
        }
        let arr: MemoryEntry[] = [];
        try {
            const st = await this.getStateAsync('memory.list');
            if (typeof st?.val === 'string' && st.val) {
                arr = JSON.parse(st.val) as MemoryEntry[];
            }
        } catch (e) {
            this.log.debug(`restoreMemory parse failed: ${(e as Error).message}`);
        }
        const n = this.memory.restore(arr);
        if (n) {
            this.log.info(`Restored ${n} remembered fact(s).`);
        } else {
            await this.renderMemory([]);
        }
    }

    /** Mirror the fact list into the summary states and the per-entry `memory.items.<id>` objects. */
    private async renderMemory(list: MemoryEntry[]): Promise<void> {
        await this.setStateAsync('memory.count', { val: list.length, ack: true });
        await this.setStateAsync('memory.list', { val: JSON.stringify(list), ack: true });

        const wanted = new Set(list.map(e => e.id));
        for (const id of [...this.memoryObjIds]) {
            if (!wanted.has(id)) {
                await this.delObjectAsync(`memory.items.${id}`, { recursive: true }).catch(() => {});
                this.memoryObjIds.delete(id);
            }
        }
        if (list.length) {
            await this.setObjectNotExistsAsync('memory.items', {
                type: 'channel',
                common: { name: 'Remembered facts' },
                native: {},
            });
        }
        for (const e of list) {
            await this.ensureMemoryObject(e);
        }
    }

    /** Create (once) and update the `memory.items.<id>.*` states for a single fact (text is editable). */
    private async ensureMemoryObject(e: MemoryEntry): Promise<void> {
        const base = `memory.items.${e.id}`;
        if (!this.memoryObjIds.has(e.id)) {
            await this.setObjectNotExistsAsync(base, {
                type: 'channel',
                common: { name: e.key || e.text.slice(0, 40) || 'Fact' },
                native: {},
            });
            const mk = (sub: string, common: ioBroker.StateCommon): Promise<unknown> =>
                this.setObjectNotExistsAsync(`${base}.${sub}`, { type: 'state', common, native: {} });
            await mk('text', { name: 'Fact', type: 'string', role: 'text', read: true, write: true });
            await mk('key', { name: 'Key/topic', type: 'string', role: 'text', read: true, write: false });
            await mk('source', { name: 'Source', type: 'string', role: 'text', read: true, write: false });
            await mk('createdAt', { name: 'Created', type: 'number', role: 'value.time', read: true, write: false });
            await mk('delete', { name: 'Forget this fact', type: 'boolean', role: 'button', read: false, write: true, def: false });
            this.memoryObjIds.add(e.id);
        }
        await this.setStateAsync(`${base}.text`, { val: e.text, ack: true });
        await this.setStateAsync(`${base}.key`, { val: e.key, ack: true });
        await this.setStateAsync(`${base}.source`, { val: e.source, ack: true });
        await this.setStateAsync(`${base}.createdAt`, { val: e.createdAt, ack: true });
    }

    /** Compact system-prompt block of remembered facts, injected before each cloud-LLM call (retrieval = all). */
    private buildMemoryContext(): string {
        if (this.config.useLongTermMemory === false || !this.memory) {
            return '';
        }
        const lang = String(this.config.voiceLanguage || this.language || 'en');
        return buildMemoryPrompt(this.memory.list(), lang);
    }

    /** LLM tools for long-term memory (remember/list/forget), appended to the MCP tool set. */
    private buildMemoryTools(): Tool[] {
        const summarize = (e: MemoryEntry): Record<string, unknown> => ({
            id: e.id,
            text: e.text,
            key: e.key,
        });
        return [
            {
                name: 'remember',
                description:
                    'Store a durable fact about the user or household to recall in later conversations (e.g. names, preferences, where things are). Use a short "key" (e.g. "daughter", "wifi") to update an existing fact instead of duplicating it. Only store lasting facts, not transient state.',
                parameters: {
                    type: 'object',
                    properties: {
                        text: { type: 'string', description: 'The fact to remember' },
                        key: { type: 'string', description: 'Optional short topic key for dedup/update' },
                    },
                    required: ['text'],
                    additionalProperties: false,
                },
                run: (args): Promise<string> => {
                    if (!this.memory) {
                        return Promise.resolve(JSON.stringify({ ok: false, error: 'memory is disabled' }));
                    }
                    const entry = this.memory.add({
                        text: String(args.text || ''),
                        key: String(args.key || ''),
                        source: 'llm',
                    });
                    return Promise.resolve(
                        entry
                            ? JSON.stringify({ ok: true, data: summarize(entry) })
                            : JSON.stringify({ ok: false, error: 'empty text' }),
                    );
                },
            },
            {
                name: 'list_memories',
                description: 'List the durable facts currently remembered about the user/household.',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
                run: (): Promise<string> =>
                    Promise.resolve(JSON.stringify({ ok: true, data: (this.memory?.list() || []).map(summarize) })),
            },
            {
                name: 'forget',
                description: 'Forget a remembered fact by its id or its key. Use this when the user asks to forget something.',
                parameters: {
                    type: 'object',
                    properties: { idOrKey: { type: 'string', description: 'The fact id or key to forget' } },
                    required: ['idOrKey'],
                    additionalProperties: false,
                },
                run: (args): Promise<string> => {
                    if (!this.memory) {
                        return Promise.resolve(JSON.stringify({ ok: false, error: 'memory is disabled' }));
                    }
                    const n = this.memory.forget(String(args.idOrKey || ''));
                    return Promise.resolve(JSON.stringify({ ok: n > 0, data: { forgotten: n } }));
                },
            },
        ];
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
        provider?: AdapterConfig['provider'];
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
                baseUrl: resolveProvider(provider, msg.baseUrl ?? cfg.baseUrl).baseUrl,
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
        provider?: AdapterConfig['provider'];
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
        const prov = resolveProvider(provider, msg.baseUrl || cfg.baseUrl);
        const agent = new LlmAgent({
            provider,
            apiKey,
            model: msg.model || cfg.model || prov.defaultModel,
            baseUrl: prov.baseUrl,
            maxTokens: 16,
            tools: [],
            log: this.log,
        });
        const res = await agent.testConnection();
        return res.ok ? { result: 'Connection OK' } : { error: res.error || 'unknown error' };
    }

    private async onUnload(callback: () => void): Promise<void> {
        try {
            this.timers?.dispose();
        } catch {
            // ignore
        }
        try {
            this.alarms?.dispose();
        } catch {
            // ignore
        }
        try {
            await this.voice?.stop();
        } catch {
            // ignore
        }
        try {
            await this.wyoming?.stop();
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
