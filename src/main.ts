import * as os from 'node:os';
import * as fs from 'node:fs';
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
import {
    Nlu,
    parseDurationSeconds,
    parseClockTime,
    parseWeekdays,
    isStopCommand,
    type NluDevice,
    type NluIntent,
} from './lib/nlu';
import { TimerManager, formatDuration, type TimerInfo } from './lib/timers';
import { AlarmManager, formatClock, formatWeekdays, type AlarmInfo } from './lib/alarms';
import { MemoryStore, buildMemoryPrompt, type MemoryEntry } from './lib/memory';
import {
    WEATHER_ADAPTERS,
    buildWeatherReport,
    buildWeatherPrompt,
    trimReport,
    type WeatherReport,
    type StateValues,
} from './lib/weather';
import { LocalLlm, installLocalLlm, isLocalLlmInstalled, isHandoff, DEFAULT_LOCAL_MODEL_URL } from './lib/localLlm';
import { resolveApiKey, resolveVoiceCredentials } from './lib/credentials';
import { ConversationStore, type ConversationTurn } from './lib/context';
import { PendingQuestions, ANY_SOURCE, ASK_TIMEOUT_MS } from './lib/ask';
import { PresenceTracker, buildPresencePrompt, parsePresenceRows, type PresenceInfo } from './lib/presence';
import { describeTargets, findTarget, isBroadcast, parseTargetRows, type TargetGroup } from './lib/targets';
import { matchRoutine, parseRoutineRows, type Routine } from './lib/routines';
import {
    bypassesDnd,
    cleanupNotificationText,
    flattenNotification,
    parseSeverity,
    toneFor,
    type Severity,
} from './lib/notifications';
import {
    TriggerEngine,
    effectiveActions,
    parseTriggerRows,
    type TriggerAction,
    type TriggerDef,
    type TriggerResponseRule,
    type TriggerStatus,
} from './lib/triggers';
import { VoiceServer } from './lib/voice/voiceServer';
import { WyomingServer } from './lib/voice/wyoming';
import { EsphomeSatellites, type TimerEvent, type WakeWordConfig } from './lib/voice/esphome';
import {
    MEDIA_COMMANDS,
    type EsphomeEntity,
    type MediaPlayerValue,
    type UpdateInfo,
} from './lib/voice/esphomeEntities';
import { MediaServer } from './lib/voice/mediaServer';
import { confirmationTone } from './lib/voice/tone';
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

/**
 * How long a rendered weather context line stays valid. Weather adapters refresh every few minutes at best,
 * so re-reading their whole state tree on every single request would be pure overhead.
 */
const WEATHER_CTX_TTL = 5 * 60 * 1000;

/**
 * The replies the assistant speaks verbatim, whatever the question was. They are pre-synthesised into
 * the TTS cache at startup; everything else is cached on first use.
 */
/** How long to wait for a device to confirm a write, and how often to look. */
const ACK_TIMEOUT_MS = 2000;
const ACK_POLL_MS = 150;

/**
 * Did the device end up with the value we asked for? Compared loosely: a dimmer told `30` may report
 * `30.0`, a switch told `true` may report `1`, and a lamp told 100 % may settle at 99 % — insisting on
 * strict equality would report a failure for a command that plainly worked.
 */
function valuesMatch(actual: unknown, expected: unknown): boolean {
    if (actual === expected) {
        return true;
    }
    if (typeof expected === 'boolean' || typeof actual === 'boolean') {
        return Boolean(actual) === Boolean(expected);
    }
    const a = Number(actual);
    const b = Number(expected);
    if (Number.isFinite(a) && Number.isFinite(b)) {
        return Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.02);
    }
    return String(actual).trim().toLowerCase() === String(expected).trim().toLowerCase();
}

/**
 * ioBroker role for a measurement, derived from its unit — a `value.temperature` shows up with the right
 * icon and in the right place in vis, where a bare `value` is just a number.
 */
function sensorRole(entity: { unit?: string }): string {
    const unit = (entity.unit || '').trim().toLowerCase();
    if (unit === '°c' || unit === '°f' || unit === 'k') {
        return 'value.temperature';
    }
    if (unit === '%') {
        return 'value.humidity'; // the only percentage a voice box reports is its humidity
    }
    if (unit === 'lx' || unit === 'lux') {
        return 'value.brightness';
    }
    if (unit === 'hpa' || unit === 'mbar' || unit === 'pa') {
        return 'value.pressure';
    }
    if (unit === 'ppm' || unit === 'ppb') {
        return 'value.co2';
    }
    if (unit === 'db' || unit === 'dba') {
        return 'value.volume';
    }
    return 'value';
}

/** Heading for a category answer, so "18 °C, 21 °C" says what it is about. */
const CATEGORY_LABELS: Record<string, { de: string; en: string; ru: string }> = {
    temperature: { de: 'Temperatur', en: 'Temperature', ru: 'Температура' },
    humidity: { de: 'Luftfeuchtigkeit', en: 'Humidity', ru: 'Влажность' },
    illuminance: { de: 'Helligkeit', en: 'Brightness', ru: 'Освещённость' },
    pressure: { de: 'Luftdruck', en: 'Pressure', ru: 'Давление' },
    airQuality: { de: 'Luftqualität', en: 'Air quality', ru: 'Качество воздуха' },
};

/**
 * Put a word to an air-quality number, because the number alone means nothing when spoken. Only for
 * the IAQ scale (0–500, unitless or labelled IAQ) — a CO₂ value in ppm is a different scale and is
 * better left unlabelled than labelled wrongly. Thresholds from the BME680/BSEC IAQ classification,
 * as used by the Python original.
 */
function iaqLabel(value: unknown, unit: string, lang: string): string {
    const iaq = Number(value);
    const u = unit.trim().toLowerCase();
    if (!Number.isFinite(iaq) || (u !== '' && u !== 'iaq')) {
        return '';
    }
    const scale: [number, string, string, string][] = [
        [50, 'sehr gut', 'excellent', 'отлично'],
        [100, 'gut', 'good', 'хорошо'],
        [150, 'mäßig', 'moderate', 'умеренно'],
        [200, 'schlecht', 'poor', 'плохо'],
        [300, 'sehr schlecht', 'very poor', 'очень плохо'],
        [Number.POSITIVE_INFINITY, 'extrem schlecht', 'extremely poor', 'крайне плохо'],
    ];
    const row = scale.find(([limit]) => iaq <= limit);
    if (!row) {
        return '';
    }
    return lang === 'ru' ? row[3] : lang === 'de' ? row[1] : row[2];
}

/** NLU actions that only switch something; their success is what the confirmation tone replaces. */
const CONTROL_ACTIONS = new Set(['on', 'off', 'level', 'color']);

const FIXED_REPLIES: Record<'de' | 'en' | 'ru', string[]> = {
    de: ['Ok.', 'Erledigt.'],
    en: ['Okay.', 'Done.'],
    ru: ['Хорошо.', 'Готово.'],
};

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
    /** Cache of a `<base>.SET` level state id → its writable boolean sibling switch (`<base>.ON_SET`/`.ON`), or ''. */
    private readonly siblingSwitch = new Map<string, string>();
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
    /** ESPHome voice satellites we dial out to (only when esphomeEnabled); null otherwise. */
    private esphome: EsphomeSatellites | null = null;
    /** Serves spoken replies to ESPHome satellites over HTTP; null unless those are enabled. */
    private media: MediaServer | null = null;
    /** Short-term per-source conversation memory (in-memory, TTL) for follow-up questions. */
    private readonly context = new ConversationStore();
    /** Questions the assistant asked and is waiting for an answer to (`askUser`), keyed by source. */
    private readonly pending = new PendingQuestions();
    /** Satellite ids whose state objects have already been created (avoid re-creating on every update). */
    private readonly satStatesEnsured = new Set<string>();
    /** Sanitised satellite state-id → real device name (for the per-satellite `tts` announce state). */
    private readonly satDeviceById = new Map<string, string>();
    /** Satellite ids that already have the wake-word states — only ESPHome devices report any. */
    private readonly satWakeWordStatesEnsured = new Set<string>();
    /** Timers already mirrored onto the ESPHome satellites, so we can tell a cancel from an update. */
    private mirroredTimers = new Map<string, TimerInfo>();
    /** Per satellite: resolves once its control objects exist, so state writes can wait for them. */
    private readonly satControlsReady = new Map<string, Promise<void>>();
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
    /** Proactive triggers (roadmap A2); mirrored into `triggers.*` states. Null until onReady. */
    private triggers: TriggerEngine | null = null;
    /** Per-trigger `triggers.items.<id>` channels currently rendered. */
    private readonly triggerObjIds = new Set<string>();
    /** Foreign states the loaded triggers watch (exactly what we subscribed to). */
    private readonly triggerStateIds = new Set<string>();
    /** Master switch (`triggers.enabled`): false suppresses every trigger's effect. */
    private triggersEnabled = true;
    /** Long-term memory (roadmap #6); mirrored into `memory.*` states. Null until onReady / when disabled. */
    private memory: MemoryStore | null = null;
    /** Per-memory `memory.items.<id>` channels currently rendered. */
    private readonly memoryObjIds = new Set<string>();
    /** Phrase-triggered macros from the configuration ("Gute Nacht" → five actions). */
    private routines: Routine[] = [];
    /** Named announcement targets (roadmap B2): groups of rooms and people, from the configuration. */
    private announceTargets: TargetGroup[] = [];
    /** Who is at home (roadmap B1); mirrored into `presence.*`. Null until onReady. */
    private presence: PresenceTracker | null = null;
    /** Satellites currently set to Do-Not-Disturb, by state id (mirrors `satellites.<id>.dnd`). */
    private readonly dndById = new Map<string, boolean>();
    /** Global Do-Not-Disturb (`dnd`): suppresses every announcement except priority/alert ones. */
    private globalDnd = false;
    /** Cached weather context line (see `buildWeatherContext`); `key` = source + language. */
    private weatherCtx: { key: string; ts: number; text: string } | null = null;
    /** Active "ringing" sessions (a timer/alarm looping its sound until stopped or timed out). */
    private readonly rings: {
        target: string | null;
        stopped: boolean;
        timeout: ReturnType<typeof setTimeout> | null;
    }[] = [];

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
            if ((cfg.weatherInstance || '').trim()) {
                tools.push(this.buildWeatherTool());
            }
            if (cfg.voiceEnabled) {
                // Only useful with satellites: without voice there is nothing to speak on.
                tools.push(this.buildAnnounceTool());
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
        await this.ensureBuiltinSounds();
        this.subscribeStates('stopRinging');
        // Spoken system notifications + Do-Not-Disturb (per satellite: see ensureSatelliteObjects).
        this.subscribeStates('notify.text');
        this.subscribeStates('notify.alert');
        this.subscribeStates('dnd');
        this.globalDnd = (await this.getStateAsync('dnd'))?.val === true;
        if (this.globalDnd) {
            this.log.info('Do-Not-Disturb is on — only alerts will be announced.');
        }
        await this.setupTimers();
        await this.setupAlarms();
        if (cfg.useLongTermMemory !== false) {
            await this.setupMemory();
        }
        this.routines = parseRoutineRows(cfg.routines, { warn: message => this.log.warn(message) });
        if (this.routines.length) {
            this.log.info(`Routines: ${this.routines.map(r => r.name).join(', ')}.`);
        }
        this.announceTargets = parseTargetRows(cfg.announceTargets);
        if (this.announceTargets.length) {
            this.log.info(
                `Announcement targets: ${this.announceTargets.map(t => `${t.name} (${t.kind})`).join(', ')}.`,
            );
        }
        await this.setupPresence();
        await this.setupTriggers();
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

        if (cfg.esphomeEnabled) {
            await this.startEsphome(apiKey);
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
                getHints: () => this.buildSttHints(),
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

    /**
     * Connect to the configured ESPHome voice satellites (ThirdReality V&M Assistant, HA Voice PE,
     * linux-voice-assistant). The adapter is the client here — the devices listen on TCP 6053 — and the
     * spoken reply is handed over as a URL, so the little media server comes up together with them.
     */
    private async startEsphome(mainApiKey: string): Promise<void> {
        const cfg = this.config;
        const devices = (cfg.esphomeDevices || []).filter(d => d?.ip?.trim());
        if (!devices.length) {
            this.log.warn('ESPHome satellites are enabled, but no device is configured.');
            return;
        }

        const creds = await resolveVoiceCredentials(this, cfg, mainApiKey);
        const ctx = this.voiceContext(cfg, creds);
        const language = cfg.voiceLanguage || this.language || '';
        let stt: SttEngine;
        let tts: TtsEngine;
        try {
            stt = createSttEngine(cfg.sttProvider || 'openai', ctx);
            tts = createTtsEngine(cfg.ttsProvider || 'openai', ctx);
        } catch (e) {
            this.log.warn(`ESPHome satellites not started — ${(e as Error).message}. Check the Voice tab settings.`);
            return;
        }

        try {
            const media = new MediaServer({
                port: cfg.esphomeMediaPort || 8099,
                bindAddress: cfg.bind || '0.0.0.0',
                log: this.log,
            });
            await media.start();
            this.media = media;
        } catch (e) {
            this.log.error(`ESPHome satellites not started — media server failed: ${(e as Error).message}`);
            this.media = null;
            return;
        }

        this.esphome = new EsphomeSatellites({
            devices,
            language,
            stt,
            tts,
            answer: (question, origin) => this.answerVoice(question, origin.device),
            getHints: () => this.buildSttHints(),
            media: this.media,
            mediaHost: (cfg.esphomeMediaHost || '').trim(),
            silenceMs: cfg.esphomeSilenceMs || 0,
            log: this.log,
            onStatus: (device, room, state) => {
                this.updateSatelliteState(device, room, state).catch(e =>
                    this.log.debug(`satellite state update failed: ${(e as Error).message}`),
                );
            },
            onWakeWords: (device, room, config) => {
                this.updateSatelliteWakeWords(device, room, config).catch(e =>
                    this.log.debug(`satellite wake word update failed: ${(e as Error).message}`),
                );
            },
            onEntities: (device, room, entities) => {
                this.createSatelliteControls(device, room, entities).catch(e =>
                    this.log.debug(`satellite control objects failed: ${(e as Error).message}`),
                );
            },
            onEntityState: (device, room, entity) => {
                this.updateSatelliteControl(device, room, entity).catch(e =>
                    this.log.debug(`satellite control update failed: ${(e as Error).message}`),
                );
            },
            expectsFollowUp: answer => this.expectsFollowUp(answer),
        });
        await this.esphome.start();
        this.log.info(
            `ESPHome satellites: ${devices.length} device(s), STT=${cfg.sttProvider || 'openai'}, TTS=${cfg.ttsProvider || 'openai'}.`,
        );
        if (!this.voice && !this.wyoming) {
            this.warmupEngines(stt, tts, language); // nobody warmed the engines up yet
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
            sttFallback: cfg.sttFallback || '',
            ttsFallback: cfg.ttsFallback || '',
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
                getHints: () => this.buildSttHints(),
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
            tts.prepare(lang)
                .then(() => this.warmTtsCache(tts, lang))
                .catch(e => this.log.warn(`TTS warm-up failed: ${(e as Error).message}`));
        } else {
            void this.warmTtsCache(tts, lang);
        }
    }

    /**
     * Pre-synthesise the handful of replies the assistant says verbatim, so the first one of the day is
     * not a cloud round-trip. Everything else lands in the cache on first use anyway — this only covers
     * the fixed strings, which are the ones that repeat forever.
     */
    private async warmTtsCache(tts: TtsEngine, lang: string): Promise<void> {
        const phrases = FIXED_REPLIES[lang === 'ru' ? 'ru' : lang === 'de' ? 'de' : 'en'];
        await tts.warm?.(phrases, lang).catch(e => this.log.debug(`TTS cache warm-up: ${(e as Error).message}`));
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

    /**
     * True when the assistant's reply asks the user something, so a satellite should re-open its mic to
     * capture the answer without a wake word (→ the `listen` flag of the voice response). Detects a question
     * mark anywhere, not just at the end, because a clarifying reply often reads "Welches Gerät …? Sag mir …".
     */
    private expectsFollowUp(answer: string): boolean {
        return /[?？]/.test(answer || '');
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
    }): Promise<{
        text?: string;
        answer?: string;
        audio?: string;
        sampleRate?: number;
        listen?: boolean;
        error?: string;
    }> {
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
            const text = (await engines.stt.transcribe(pcm, rate, language, await this.buildSttHints())).trim();
            if (!text) {
                return { text: '', answer: '' };
            }
            const answer = await this.answerVoice(text, source);
            if (!answer) {
                return { text, answer: '' };
            }
            const reply = await engines.tts.synthesize(answer, language);
            // Follow-up: primarily the LLM's own signal ([[LISTEN]] → lastFollowUp); "?" heuristic as fallback.
            const llmSignalled = this.lastFollowUp;
            const listen = llmSignalled || this.expectsFollowUp(answer);
            if (listen) {
                this.log.info(
                    `→ mic-on to satellite '${source}' (${llmSignalled ? 'LLM signalled a follow-up' : 'reply is a question (fallback)'}).`,
                );
            }
            return { text, answer, audio: reply.pcm.toString('base64'), sampleRate: reply.sampleRate, listen };
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
        const id = await this.ensureSatelliteObjects(device, room);
        const base = `satellites.${id}`;
        await this.setStateAsync(`${base}.status`, { val: state, ack: true });
        await this.setStateAsync(`${base}.alive`, { val: state !== 'offline', ack: true });
        await this.setStateAsync(`${base}.lastSeen`, { val: Date.now(), ack: true });
        if (room) {
            await this.setStateAsync(`${base}.room`, { val: room, ack: true });
        }
    }

    /**
     * Create the object tree for one satellite and return its (sanitised) state id, without touching
     * any value. Callers that only need somewhere to hang a child object use this rather than
     * {@link updateSatelliteState} — going through that would write `status`, and a wake-word or
     * settings update arriving mid-announcement would knock the satellite back to `idle`.
     */
    private async ensureSatelliteObjects(device: string, room: string): Promise<string> {
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
            await this.setObjectNotExistsAsync(`${base}.host`, {
                type: 'state',
                common: {
                    name: 'Host the satellite runs on',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: false,
                    def: '',
                },
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
            await this.setObjectNotExistsAsync(`${base}.dnd`, {
                type: 'state',
                common: {
                    name: 'Do-Not-Disturb: suppress announcements on this satellite (alerts still play)',
                    type: 'boolean',
                    role: 'switch.mode.silent',
                    read: true,
                    write: true,
                    def: false,
                },
                native: {},
            });
            this.subscribeStates(`${base}.tts`);
            this.subscribeStates(`${base}.dnd`);
            // A satellite that was silenced before the restart stays silenced.
            const dnd = await this.getStateAsync(`${base}.dnd`);
            this.dndById.set(id, dnd?.val === true);
            this.satStatesEnsured.add(id);
        }
        // Map the (sanitised) state id back to the real device name for the per-satellite tts state.
        this.satDeviceById.set(id, device);
        return id;
    }

    /**
     * Publish a satellite's wake-word configuration and let it be changed from ioBroker.
     *
     * Only ESPHome satellites have this: the wake word runs on the device, and the ESPHome API lets the
     * controller pick which of the built-in models listen. `wakeWords` is writable and takes a
     * comma-separated list of ids; the device stores the choice itself, so it survives a restart of the
     * adapter and is read back from the device rather than mirrored optimistically.
     */
    private async updateSatelliteWakeWords(device: string, room: string, config: WakeWordConfig): Promise<void> {
        const id = await this.ensureSatelliteObjects(device, room);
        const base = `satellites.${id}`;

        if (!this.satWakeWordStatesEnsured.has(id)) {
            await this.setObjectNotExistsAsync(`${base}.wakeWords`, {
                type: 'state',
                common: {
                    name: 'Active wake words (comma-separated ids)',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: true,
                    def: '',
                },
                native: {},
            });
            await this.setObjectNotExistsAsync(`${base}.availableWakeWords`, {
                type: 'state',
                common: {
                    name: 'Wake words this device offers',
                    type: 'string',
                    role: 'json',
                    read: true,
                    write: false,
                    def: '[]',
                },
                native: {},
            });
            this.subscribeStates(`${base}.wakeWords`);
            this.satWakeWordStatesEnsured.add(id);
        }
        await this.setStateAsync(`${base}.wakeWords`, { val: config.active.join(','), ack: true });
        await this.setStateAsync(`${base}.availableWakeWords`, {
            val: JSON.stringify({ max: config.max, words: config.available }),
            ack: true,
        });
    }

    /**
     * Mirror everything an ESPHome satellite exposes besides the voice pipeline into
     * `satellites.<id>.controls.*` — microphone gain and volume, noise suppression, wake-word and
     * stop-word sensitivities, the mute and thinking-sound switches, its media player and its firmware
     * update entity. Which of these exist is up to the device, so the objects are built from what it
     * announced rather than from a hard-coded list.
     *
     * The compound entities get a small folder instead of a single state, because one value cannot
     * carry them: a media player has a state, a volume and a mute flag, and a firmware entity has two
     * versions plus progress.
     */
    private createSatelliteControls(device: string, room: string, entities: EsphomeEntity[]): Promise<void> {
        if (!entities.length) {
            return Promise.resolve();
        }
        // Publish the promise *before* awaiting anything: the device starts pushing entity states while
        // these objects are still being created, and those writes have to wait for it.
        const satId = this.satelliteStateId(device, room);
        const task = this.buildSatelliteControls(satId, device, room, entities);
        this.satControlsReady.set(satId, task);
        return task;
    }

    /** The actual object creation behind {@link createSatelliteControls}. */
    private async buildSatelliteControls(
        satId: string,
        device: string,
        room: string,
        entities: EsphomeEntity[],
    ): Promise<void> {
        await this.ensureSatelliteObjects(device, room); // make sure the parent objects exist
        const base = `satellites.${satId}.controls`;
        await this.setObjectNotExistsAsync(base, {
            type: 'channel',
            common: { name: 'Device settings' },
            native: {},
        });

        for (const entity of entities) {
            const id = `${base}.${entity.objectId}`;
            const name = entity.name || entity.objectId;
            if (entity.kind === 'mediaPlayer') {
                await this.setObjectNotExistsAsync(id, { type: 'channel', common: { name }, native: {} });
                await this.ensureState(`${id}.state`, 'Playback state', 'string', 'media.state', false);
                await this.ensureState(`${id}.volume`, 'Volume (0…1)', 'number', 'level.volume', true);
                await this.ensureState(
                    `${id}.command`,
                    `Command (${Object.keys(MEDIA_COMMANDS).join(', ')})`,
                    'string',
                    'text',
                    true,
                );
                await this.ensureState(`${id}.muted`, 'Muted', 'boolean', 'media.mute', false);
                this.subscribeStates(`${id}.volume`);
                this.subscribeStates(`${id}.command`);
            } else if (entity.kind === 'update') {
                await this.setObjectNotExistsAsync(id, { type: 'channel', common: { name }, native: {} });
                await this.ensureState(`${id}.currentVersion`, 'Installed version', 'string', 'text', false);
                await this.ensureState(`${id}.latestVersion`, 'Available version', 'string', 'text', false);
                await this.ensureState(`${id}.inProgress`, 'Update running', 'boolean', 'indicator', false);
                await this.ensureState(`${id}.progress`, 'Update progress', 'number', 'value', false);
                await this.ensureState(`${id}.install`, 'Install the update', 'boolean', 'button', true);
                this.subscribeStates(`${id}.install`);
            } else if (entity.kind === 'event') {
                await this.setObjectNotExistsAsync(id, {
                    type: 'state',
                    common: {
                        name: `${name} (last event)`,
                        type: 'string',
                        role: 'text',
                        read: true,
                        write: false,
                        def: '',
                        ...(entity.eventTypes?.length
                            ? { states: Object.fromEntries(entity.eventTypes.map(t => [t, t])) }
                            : {}),
                    },
                    native: {},
                });
            } else if (entity.kind === 'sensor' || entity.kind === 'binarySensor' || entity.kind === 'textSensor') {
                // What the box measures about its room (temperature, presence, a status text). Read-only,
                // so there is nothing to subscribe to — the device pushes the values.
                const common: ioBroker.StateCommon =
                    entity.kind === 'sensor'
                        ? {
                              name,
                              type: 'number',
                              role: sensorRole(entity),
                              read: true,
                              write: false,
                              unit: entity.unit || undefined,
                          }
                        : entity.kind === 'binarySensor'
                          ? { name, type: 'boolean', role: 'indicator', read: true, write: false, def: false }
                          : { name, type: 'string', role: 'text', read: true, write: false, def: '' };
                await this.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
            } else {
                const common: ioBroker.StateCommon =
                    entity.kind === 'switch'
                        ? { name, type: 'boolean', role: 'switch', read: true, write: true, def: false }
                        : entity.kind === 'select'
                          ? {
                                name,
                                type: 'string',
                                role: 'text',
                                read: true,
                                write: true,
                                def: '',
                                states: Object.fromEntries((entity.options || []).map(o => [o, o])),
                            }
                          : {
                                name,
                                type: 'number',
                                role: 'level',
                                read: true,
                                write: true,
                                min: entity.min,
                                max: entity.max,
                                step: entity.step,
                                unit: entity.unit || undefined,
                            };
                await this.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
                this.subscribeStates(id);
            }
        }
        this.satDeviceById.set(satId, device);
        // Now that the objects exist, publish the values the device already reported. Anything that
        // arrived while we were still creating objects was skipped, so this is what fills those in.
        for (const entity of entities) {
            if (entity.value !== undefined) {
                await this.writeSatelliteControl(satId, entity);
            }
        }
        this.log.debug(`Satellite ${device}: ${entities.length} control object(s) under ${base}`);
    }

    /** Small helper so the control objects above stay readable. */
    private async ensureState(
        id: string,
        name: string,
        type: ioBroker.CommonType,
        role: string,
        write: boolean,
    ): Promise<void> {
        await this.setObjectNotExistsAsync(id, {
            type: 'state',
            common: { name, type, role, read: true, write },
            native: {},
        });
    }

    /**
     * A device pushed a new value for one of its entities.
     *
     * The device starts reporting states while {@link buildSatelliteControls} is still creating the
     * objects, so this waits for that to finish. Before the entities have even been announced there is
     * nothing to wait on and nothing to write into — the value is kept in the registry and published by
     * the initial sync at the end of the build.
     */
    private async updateSatelliteControl(device: string, room: string, entity: EsphomeEntity): Promise<void> {
        const satId = this.satelliteStateId(device, room);
        const ready = this.satControlsReady.get(satId);
        if (!ready) {
            return;
        }
        await ready;
        await this.writeSatelliteControl(satId, entity);
    }

    /** Write one entity's current value into its state(s). Always acked — this is the device talking. */
    private async writeSatelliteControl(satId: string, entity: EsphomeEntity): Promise<void> {
        const base = `satellites.${satId}.controls.${entity.objectId}`;
        if (entity.kind === 'mediaPlayer') {
            const v = entity.value as MediaPlayerValue;
            await this.setStateAsync(`${base}.state`, { val: v.state, ack: true });
            await this.setStateAsync(`${base}.volume`, { val: v.volume, ack: true });
            await this.setStateAsync(`${base}.muted`, { val: v.muted, ack: true });
        } else if (entity.kind === 'update') {
            const v = entity.value as UpdateInfo;
            await this.setStateAsync(`${base}.currentVersion`, { val: v.currentVersion, ack: true });
            await this.setStateAsync(`${base}.latestVersion`, { val: v.latestVersion, ack: true });
            await this.setStateAsync(`${base}.inProgress`, { val: v.inProgress, ack: true });
            await this.setStateAsync(`${base}.progress`, { val: v.progress, ack: true });
        } else {
            await this.setStateAsync(base, { val: entity.value as ioBroker.StateValue, ack: true });
        }
    }

    /**
     * Apply a write to any `satellites.<id>.controls.*` state. Like the wake words, nothing is acked
     * here: the device reports the value it actually took and {@link updateSatelliteControl} writes
     * that, so a clamped or rejected write never leaves ioBroker showing a value the device ignored.
     */
    private setSatelliteControl(satId: string, path: string, value: ioBroker.StateValue): void {
        const device = this.satDeviceById.get(satId) || satId;
        if (!this.esphome) {
            this.log.warn(`Cannot write ${path} on ${device}: ESPHome satellites are not enabled.`);
            return;
        }
        // Compound entities address a leaf: `<objectId>.volume`, `<objectId>.install`, …
        const [objectId, leaf] = path.split('.');
        let payload: unknown = value;
        if (leaf === 'install') {
            if (!value) {
                return; // button released
            }
            payload = 'install';
        } else if (leaf === 'volume' || leaf === 'command') {
            payload = value;
        } else if (leaf) {
            return; // read-only leaf of a compound entity
        }
        if (!this.esphome.setEntity(device, objectId, payload)) {
            this.log.warn(`Writing ${objectId} on ${device} was rejected — see the warning above.`);
        }
    }

    /**
     * Apply a write to `satellites.<id>.wakeWords`. The state is *not* acked here: the device echoes its
     * new configuration back and {@link updateSatelliteWakeWords} writes the acked value, so what ioBroker
     * shows is always what the device actually does — including when it rejected or trimmed the list.
     */
    private async setSatelliteWakeWords(satId: string, value: string): Promise<void> {
        const device = this.satDeviceById.get(satId) || satId;
        const ids = value
            .split(/[,;]/)
            .map(s => s.trim())
            .filter(Boolean);
        if (!this.esphome) {
            this.log.warn(`Cannot set wake words on ${device}: ESPHome satellites are not enabled.`);
            return;
        }
        if (!this.esphome.setWakeWords(device, ids)) {
            this.log.warn(`Cannot set wake words: satellite ${device} is not connected.`);
            // Put the last known value back, so the state does not keep showing a change that never happened.
            const known = this.esphome.wakeWords(device);
            if (known) {
                await this.setStateAsync(`satellites.${satId}.wakeWords`, {
                    val: known.active.join(','),
                    ack: true,
                });
            }
        }
    }

    /**
     * Record which ioBroker host a satellite runs on, resolved from the sender instance object
     * (`system.adapter.<from>.common.host`). Only meaningful for ioBroker-native satellites; UDP/ESP ones
     * have no instance, so their host stays empty.
     */
    private async setSatelliteHost(satId: string, from: string): Promise<void> {
        try {
            const instId = from.startsWith('system.adapter.') ? from : `system.adapter.${from}`;
            const obj = await this.getForeignObjectAsync(instId);
            const host = (obj?.common as { host?: string } | undefined)?.host;
            if (host && this.satStatesEnsured.has(satId)) {
                await this.setStateAsync(`satellites.${satId}.host`, { val: host, ack: true });
            }
        } catch {
            /* sender isn't an adapter instance (UDP satellite) — leave host empty */
        }
    }

    /**
     * Speak `value` on one satellite (by state id) or all (`targetId=null`). Plain text is synthesised with
     * the configured TTS engine; a URL/path to an audio file (mp3/wav/…) is decoded with ffmpeg. Delivered
     * to **both** transports: ioBroker-native satellites via a `sendTo(from, 'announce', …)` message and UDP
     * satellites via the UDP server.
     *
     * With `opts.listen` the satellite re-opens its microphone afterwards, for the answer to a question
     * (`askUser`); `opts.priority` plays even on a satellite set to Do-Not-Disturb (an alert does, see
     * {@link notify}). Returns how many channels the announcement reached — 0 means nobody heard it.
     */
    private async announceToSatellites(
        value: string,
        target: string | null,
        opts: { listen?: boolean; priority?: boolean; onlyWhenHome?: boolean } = {},
    ): Promise<number> {
        const listen = opts.listen === true;
        let v = value.trim();
        if (!v) {
            return 0;
        }
        // A name may stand for one satellite, a room, or a configured group/person — resolve it before
        // spending a TTS call on a target that does not exist.
        const targets = this.resolveTargets(target);
        if (targets && !targets.length) {
            this.log.warn(`Announcement not delivered — '${String(target)}' is no known satellite, room or group.`);
            return 0;
        }
        // Checked before the text is synthesised, so talking to an empty house costs neither an LLM nor a
        // TTS call.
        if (opts.onlyWhenHome && this.emptyHouse()) {
            this.log.debug('Announcement held back — nobody is at home.');
            return 0;
        }
        // A leading "!" marks a priority announcement: strip it and let it bypass a satellite's
        // Do-Not-Disturb (e.g. "!Water leak detected" is played even in DND).
        let priority = opts.priority === true;
        if (v.startsWith('!')) {
            priority = true;
            v = v.slice(1).trim();
            if (!v) {
                return 0;
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
            return 0;
        }

        let delivered = 0;
        if (targets === null) {
            delivered = await this.deliverPcm(pcm, sampleRate, null, priority, listen);
        } else {
            // Synthesised once, handed to each member: a group of three speakers is one TTS call.
            for (const id of targets) {
                delivered += await this.deliverPcm(pcm, sampleRate, id, priority, listen);
            }
        }
        this.log.info(
            `Announce → ${targets ? targets.join(', ') : 'all satellites'} (${delivered} channel(s)${listen ? ', mic on' : ''}): ${isAudio ? v : `"${v}"`}`,
        );
        if (!delivered) {
            this.log.warn('Announcement not delivered — no satellites registered (native or UDP).');
        }
        return delivered;
    }

    /**
     * Deliver a ready 16-bit-mono-PCM buffer to one satellite (`targetId`) or all (`null`), over both
     * transports (ioBroker-native message bus + UDP). Returns how many channels it reached.
     *
     * `listen` asks the satellite to re-open its microphone when the clip has played, so the answer to a
     * question is captured without a wake word. Each transport has its own way: ESPHome carries it in the
     * announce request (`start_conversation`), UDP gets a `listen` control message, and a native satellite
     * receives the flag in the announce message.
     */
    private async deliverPcm(
        pcm: Buffer,
        sampleRate: number,
        targetId: string | null,
        priority: boolean,
        listen = false,
    ): Promise<number> {
        let delivered = 0;
        if (this.silenced(targetId, priority)) {
            this.log.debug(`Announcement suppressed — Do-Not-Disturb (${targetId || 'all satellites'}).`);
            return 0;
        }
        // ── ioBroker-native satellites: push over the message bus ───────────────
        const nativeTargets = targetId
            ? this.nativeSatFrom.has(targetId)
                ? [[targetId, this.nativeSatFrom.get(targetId)!] as const]
                : []
            : [...this.nativeSatFrom.entries()];
        for (const [satId, from] of nativeTargets) {
            if (this.silenced(satId, priority)) {
                continue;
            }
            this.sendTo(from, 'announce', {
                audio: pcm.toString('base64'),
                sampleRate,
                format: 'pcm',
                priority,
                listen,
            });
            delivered++;
        }
        // ── UDP satellites (if the UDP server runs and the target isn't a native one) ──
        if (this.voice && !(targetId && this.nativeSatFrom.has(targetId))) {
            const device = targetId ? this.satDeviceById.get(targetId) || targetId : null;
            // Addressed per device rather than broadcast, so one silenced satellite in the house does not
            // silence the others — and so the count reflects who actually got it (announce() itself only
            // warns when nobody is registered, and askUser needs to know whether the question was heard).
            const allowed = this.voice
                .devices()
                .filter(d => (!device || d === device) && !this.isDeviceSilenced(d, priority));
            if (allowed.length) {
                try {
                    await Promise.all(allowed.map(d => this.voice!.announce(d, pcm, sampleRate)));
                    delivered += allowed.length;
                    if (listen) {
                        allowed.forEach(d => this.voice!.listen(d));
                    }
                } catch (e) {
                    this.log.debug(`UDP announce failed: ${(e as Error).message}`);
                }
            }
        }
        // ── ESPHome satellites: they fetch the clip from the media server by URL ──
        if (this.esphome && !(targetId && this.nativeSatFrom.has(targetId))) {
            const device = targetId ? this.satDeviceById.get(targetId) || targetId : null;
            const allowed = this.esphome
                .devices()
                .filter(d => (!device || d === device) && !this.isDeviceSilenced(d, priority));
            try {
                const counts = await Promise.all(allowed.map(d => this.esphome!.announce(d, pcm, sampleRate, listen)));
                delivered += counts.reduce((sum, n) => sum + n, 0);
            } catch (e) {
                this.log.debug(`ESPHome announce failed: ${(e as Error).message}`);
            }
        }
        return delivered;
    }

    /**
     * Do-Not-Disturb check by satellite state id (`null` = the broadcast itself). A priority announcement
     * — an `alert` notification or a text starting with `!` — is never suppressed; that is the whole point
     * of the flag, and a water leak has to be heard at night.
     */
    private silenced(satId: string | null, priority: boolean): boolean {
        if (priority) {
            return false;
        }
        if (this.globalDnd) {
            return true;
        }
        return satId ? this.dndById.get(satId) === true : false;
    }

    /** Same check, for a transport that knows its satellites by device name rather than by state id. */
    private isDeviceSilenced(device: string, priority: boolean): boolean {
        if (priority) {
            return false;
        }
        for (const [satId, dev] of this.satDeviceById) {
            if (dev === device) {
                return this.silenced(satId, priority);
            }
        }
        return this.globalDnd;
    }

    /**
     * Install the bundled default jingles (`admin/sounds/{timer,alarm}.wav`) into this instance's file
     * storage the first time, so they appear in the settings sound dropdown and can be played out of the
     * box. Never overwrites an existing file (a user upload/replacement or a previous copy wins).
     */
    private async ensureBuiltinSounds(): Promise<void> {
        for (const name of ['timer.wav', 'alarm.wav']) {
            const target = `sounds/${name}`;
            try {
                await this.readFileAsync(this.namespace, target);
                continue; // already present — leave the user's version alone
            } catch {
                /* not present → install the bundled default */
            }
            try {
                const src = path.join(__dirname, '..', 'admin', 'sounds', name);
                await this.writeFileAsync(this.namespace, target, await fs.promises.readFile(src));
                this.log.debug(`installed default sound ${target}`);
            } catch (e) {
                this.log.debug(`could not install default sound ${name}: ${(e as Error).message}`);
            }
        }
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
                const res = (await this.readFileAsync(this.namespace, p)) as
                    { file?: Buffer | string } | Buffer | string;
                const f = Buffer.isBuffer(res) || typeof res === 'string' ? res : res.file;
                if (f != null) {
                    data = Buffer.isBuffer(f) ? f : Buffer.from(f, 'binary');
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
     * Effect for an expiring timer/alarm: if a sound is set and `ringSeconds > 0`, ring (loop the sound)
     * until stopped by voice ("stop"/"halt"/…) or the ring timeout; otherwise play once + announce.
     */
    private fireEffects(sound: string, announce: boolean, message: string, target: string | null): void {
        const ringMs = Math.max(0, this.config.ringSeconds ?? 60) * 1000;
        if (sound && ringMs > 0) {
            this.startRing(sound, message, announce, target, ringMs);
        } else {
            void this.playAndAnnounce(sound, announce, message, target).catch(e =>
                this.log.debug(`fire effects failed: ${(e as Error).message}`),
            );
        }
    }

    /**
     * Ring: loop `sound` on `target` until stopped or `maxMs` elapses, announcing `message` once after the
     * first ring. The user silences it by saying a stop word (handled in {@link produceAnswer}), writing
     * `stopRinging`, or it auto-stops after the timeout.
     */
    private startRing(sound: string, message: string, announce: boolean, target: string | null, maxMs: number): void {
        const session: { target: string | null; stopped: boolean; timeout: ReturnType<typeof setTimeout> | null } = {
            target,
            stopped: false,
            timeout: null,
        };
        this.rings.push(session);
        this.setStateAsync('ringing', { val: true, ack: true }).catch(() => {});
        const endAt = Date.now() + maxMs;
        let announced = false;
        const tick = async (): Promise<void> => {
            if (session.stopped) {
                return;
            }
            let dur = 1;
            try {
                dur = (await this.playStoredSound(sound, target)) || 1;
            } catch (e) {
                this.log.debug(`ring play failed: ${(e as Error).message}`);
                this.endRing(session);
                return;
            }
            if (session.stopped) {
                return;
            }
            if (!announced && announce && message) {
                announced = true;
                await this.delay(Math.min(dur * 1000 + 150, 6000)); // let the jingle finish, then speak once
                if (session.stopped) {
                    return;
                }
                // Priority like the jingle above: a timer the user set themselves is not an unsolicited
                // announcement, and hearing the gong followed by silence would be worse than either.
                await this.announceToSatellites(message, target, { priority: true }).catch(() => {});
            }
            if (session.stopped) {
                return;
            }
            if (Date.now() >= endAt) {
                this.endRing(session);
                return;
            }
            session.timeout = setTimeout(() => void tick(), Math.max(300, Math.round(dur * 1000) + 700));
        };
        void tick();
    }

    /** Remove a ring session and clear the "ringing" state when the last one ends. */
    private endRing(session: { stopped: boolean; timeout: ReturnType<typeof setTimeout> | null }): void {
        session.stopped = true;
        if (session.timeout) {
            clearTimeout(session.timeout);
            session.timeout = null;
        }
        const i = this.rings.indexOf(session as (typeof this.rings)[number]);
        if (i >= 0) {
            this.rings.splice(i, 1);
        }
        if (!this.rings.length) {
            this.setStateAsync('ringing', { val: false, ack: true }).catch(() => {});
        }
    }

    /** Stop all active ring sessions (voice "stop", the `stopRinging` state, or on unload). Returns count. */
    private stopRinging(): number {
        const n = this.rings.length;
        for (const s of [...this.rings]) {
            this.endRing(s);
        }
        return n;
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
            // Priority, for the same reason as in startRing: the jingle already bypasses Do-Not-Disturb.
            await this.announceToSatellites(text, targetId, { priority: true });
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
        if (!state) {
            return;
        }
        // Trigger-watched states are routed first and regardless of `ack`: a device confirms its value with
        // ack:true, which the filter below drops — and those are exactly the changes a trigger reacts to.
        if (this.triggerStateIds.has(id)) {
            await this.triggers?.onStateChange(id, state.val);
        }
        // Presence states come from devices too (a phone ping, the residents adapter), so they are
        // read here for the same reason — and one state may well be watched by both.
        this.presence?.update(id, state.val ?? null);
        if (state.ack) {
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

        // Pick which wake words listen on an ESPHome satellite (comma-separated ids).
        const satWake = id.match(/\.satellites\.([^.]+)\.wakeWords$/);
        if (satWake) {
            await this.setSatelliteWakeWords(satWake[1], String(state.val ?? ''));
            return;
        }

        // Device settings: mic gain/volume, noise suppression, sensitivities, media player, firmware.
        const satControl = id.match(/\.satellites\.([^.]+)\.controls\.(.+)$/);
        if (satControl) {
            this.setSatelliteControl(satControl[1], satControl[2], state.val ?? null);
            return;
        }

        // Silence a ringing timer/alarm from vis/JS.
        if (id.endsWith('.stopRinging')) {
            if (state.val) {
                const n = this.stopRinging();
                this.log.info(`Ring stopped via stopRinging state (${n} session(s)).`);
            }
            await this.setStateAsync('stopRinging', { val: false, ack: true });
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

        // System notifications: `notify.text` (severity notify) and `notify.alert` (urgent, ignores DND).
        if (id.endsWith('.notify.text') || id.endsWith('.notify.alert')) {
            const alert = id.endsWith('.notify.alert');
            const text = String(state.val ?? '');
            await this.setStateAsync(alert ? 'notify.alert' : 'notify.text', { val: '', ack: true });
            await this.notify(text, alert ? 'alert' : 'notify');
            return;
        }

        // Do-Not-Disturb: globally and per satellite.
        if (id.endsWith('.dnd') && !id.includes('.satellites.')) {
            this.globalDnd = !!state.val;
            this.log.info(`Do-Not-Disturb ${this.globalDnd ? 'on' : 'off'} (all satellites).`);
            await this.setStateAsync('dnd', { val: this.globalDnd, ack: true });
            return;
        }
        const satDnd = id.match(/\.satellites\.([^.]+)\.dnd$/);
        if (satDnd) {
            this.dndById.set(satDnd[1], !!state.val);
            this.log.info(`Do-Not-Disturb ${state.val ? 'on' : 'off'} for satellite '${satDnd[1]}'.`);
            await this.setStateAsync(`satellites.${satDnd[1]}.dnd`, { val: !!state.val, ack: true });
            return;
        }

        // Trigger controls: the master switch, the per-trigger enable switch and its test button.
        if (id.endsWith('.triggers.enabled')) {
            this.triggersEnabled = !!state.val;
            this.log.info(`Triggers ${this.triggersEnabled ? 'enabled' : 'disabled'} via triggers.enabled.`);
            await this.setStateAsync('triggers.enabled', { val: this.triggersEnabled, ack: true });
            return;
        }
        const triggerEnable = id.match(/\.triggers\.items\.([^.]+)\.enabled$/);
        if (triggerEnable) {
            if (this.triggers?.setEnabled(triggerEnable[1], !!state.val)) {
                this.log.info(`Trigger ${triggerEnable[1]} ${state.val ? 'enabled' : 'disabled'}.`);
            }
            return;
        }
        const triggerFire = id.match(/\.triggers\.items\.([^.]+)\.fire$/);
        if (triggerFire) {
            // Ack the button back to false right away, so it can be pressed again while the trigger runs
            // (a trigger that asks a question keeps us here for up to a minute).
            await this.setStateAsync(`triggers.items.${triggerFire[1]}.fire`, { val: false, ack: true });
            if (state.val && !(await this.triggers?.fireNow(triggerFire[1]))) {
                this.log.warn(`Trigger ${triggerFire[1]} not found.`);
            }
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
            if (m.state !== 'offline') {
                void this.setSatelliteHost(satId, String(obj.from));
            }
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
            const satId = this.satelliteStateId(m.source || 'satellite', m.room || '');
            this.nativeSatFrom.set(satId, from);
            const res = await this.handleVoiceQuery(m);
            void this.setSatelliteHost(satId, String(obj.from));
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
            const weekdays = Array.isArray(m.weekdays) ? m.weekdays : m.time ? parseWeekdays(m.time) : [];
            let result: { ok: boolean; id?: string; nextFireAt?: number; error?: string };
            if (!this.alarms || Number.isNaN(hour)) {
                result = {
                    ok: false,
                    error: this.alarms ? 'hour/minute or a parseable time is required' : 'alarms not ready',
                };
            } else {
                const info = this.alarms.add({
                    label: m.label || '',
                    room: m.room || '',
                    source: '',
                    hour,
                    minute,
                    weekdays,
                });
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
                    entry
                        ? { ok: true, id: entry.id }
                        : { ok: false, error: this.memory ? 'empty text' : 'memory disabled' },
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

        // Settings weather dropdown (selectSendTo): list installed weather-adapter instances/locations.
        if (obj.command === 'getWeatherInstances') {
            const list = await this.getWeatherInstances();
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, list, obj.callback);
            }
            return;
        }

        // Scripts: the normalized weather report from the configured source. message = { when? }.
        if (obj.command === 'getWeather') {
            const m = (obj.message || {}) as { when?: string };
            const value = (this.config.weatherInstance || '').trim();
            const res = value ? await this.readWeather(value) : { error: 'no weather source configured' };
            const payload =
                res.report !== undefined ? { ...res, report: trimReport(res.report, String(m.when || '')) } : res;
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, payload, obj.callback);
            }
            return;
        }

        // Scripts / settings: which wake words an ESPHome satellite offers and which are listening.
        // message = { device? } — omitted means every connected one.
        if (obj.command === 'getWakeWords') {
            const m = (obj.message || {}) as { device?: string };
            const devices = m.device ? [m.device] : this.esphome?.devices() || [];
            const payload = this.esphome
                ? { devices: devices.map(d => ({ device: d, ...(this.esphome?.wakeWords(d) || {}) })) }
                : { error: 'ESPHome satellites are not enabled' };
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, payload, obj.callback);
            }
            return;
        }

        // Scripts: choose the active wake words. message = { device, wakeWords: string[] | "a,b" }.
        if (obj.command === 'setWakeWords') {
            const m = (obj.message || {}) as { device?: string; wakeWords?: string[] | string };
            const ids = (Array.isArray(m.wakeWords) ? m.wakeWords : String(m.wakeWords ?? '').split(/[,;]/))
                .map(s => String(s).trim())
                .filter(Boolean);
            let payload: Record<string, unknown>;
            if (!this.esphome) {
                payload = { error: 'ESPHome satellites are not enabled' };
            } else if (!m.device) {
                payload = { error: 'device is required' };
            } else if (!this.esphome.setWakeWords(m.device, ids)) {
                payload = { error: `satellite ${m.device} is not connected` };
            } else {
                payload = { ok: true };
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, payload, obj.callback);
            }
            return;
        }

        // Scripts: everything an ESPHome satellite exposes besides the voice pipeline.
        // message = { device? }; without a device, every connected one is listed.
        if (obj.command === 'getControls') {
            const m = (obj.message || {}) as { device?: string };
            const devices = m.device ? [m.device] : this.esphome?.devices() || [];
            const payload = this.esphome
                ? { devices: devices.map(d => ({ device: d, entities: this.esphome?.entities(d) || [] })) }
                : { error: 'ESPHome satellites are not enabled' };
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, payload, obj.callback);
            }
            return;
        }

        // Scripts: write one of them. message = { device, control: 'mic_volume', value: 2000 }.
        if (obj.command === 'setControl') {
            const m = (obj.message || {}) as { device?: string; control?: string; value?: unknown };
            let payload: Record<string, unknown>;
            if (!this.esphome) {
                payload = { error: 'ESPHome satellites are not enabled' };
            } else if (!m.device || !m.control) {
                payload = { error: 'device and control are required' };
            } else if (!this.esphome.setEntity(m.device, m.control, m.value)) {
                payload = { error: `${m.control} on ${m.device} rejected the value (see the log)` };
            } else {
                payload = { ok: true };
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, payload, obj.callback);
            }
            return;
        }

        // Scripts: silence a ringing timer/alarm.
        if (obj.command === 'stopRinging') {
            const n = this.stopRinging();
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { ok: true, stopped: n }, obj.callback);
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
            this.siblingSwitch.clear();
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

        // A notification routed here by the ioBroker notification-manager.
        if (obj.command === 'sendNotification') {
            const result = await this.handleSystemNotification(obj.message);
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, result, obj.callback);
            }
            return;
        }

        // Speak a system notification: sendTo('assistant.0', 'notify', { text, severity, target }).
        if (obj.command === 'notify') {
            const msg = (obj.message || {}) as {
                text?: string;
                severity?: string;
                target?: string;
                room?: string;
                onlyWhenHome?: boolean;
            };
            const text = String(msg.text ?? '');
            let result: { spoken?: number; error?: string };
            if (!text.trim()) {
                result = { error: 'no text provided' };
            } else {
                const where = (msg.target || msg.room || '').trim();
                const ids = this.resolveTargets(where);
                const target = where || null;
                result =
                    ids && !ids.length
                        ? { error: `unknown satellite, room or group '${where}'` }
                        : {
                              spoken: await this.notify(
                                  text,
                                  parseSeverity(msg.severity),
                                  target,
                                  msg.onlyWhenHome === true,
                              ),
                          };
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, result, obj.callback);
            }
            return;
        }

        // Trigger management for scripts: list them, run one now, enable/disable one.
        if (obj.command === 'listTriggers') {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { triggers: this.triggers?.list() ?? [] }, obj.callback);
            }
            return;
        }
        if (obj.command === 'fireTrigger' || obj.command === 'setTriggerEnabled') {
            const msg = (obj.message || {}) as { id?: string; enabled?: boolean };
            const tid = String(msg.id ?? '').trim();
            let result: { ok: boolean; error?: string };
            if (!tid) {
                result = { ok: false, error: 'no trigger id provided' };
            } else if (obj.command === 'fireTrigger') {
                const ok = (await this.triggers?.fireNow(tid)) === true;
                result = ok ? { ok } : { ok, error: `unknown trigger '${tid}'` };
            } else {
                const ok = this.triggers?.setEnabled(tid, msg.enabled !== false) === true;
                result = ok ? { ok } : { ok, error: `unknown trigger '${tid}'` };
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, result, obj.callback);
            }
            return;
        }

        // The other direction: ask the user something and hand the answer back to the caller.
        // sendTo('assistant.0', 'askUser', { question, room|target|source, timeoutMs }, cb)
        if (obj.command === 'askUser') {
            const result = await this.askUser(
                (obj.message || {}) as {
                    question?: string;
                    text?: string;
                    target?: string;
                    room?: string;
                    source?: string | string[];
                    timeoutMs?: number;
                },
            );
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, result, obj.callback);
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
        const raw = await this.produceAnswer(question, history, source);
        // The LLM signals "I'm waiting for the user's reply" by appending the [[LISTEN]] control marker
        // (see followUpHint). Strip it here so it's neither stored, shown nor spoken, and expose it as the
        // follow-up flag. Single-user voice → a shared field is race-free enough (read right after await).
        this.lastFollowUp = /\[\[LISTEN\]\]/i.test(raw);
        const result = raw.replace(/\s*\[\[LISTEN\]\]\s*/gi, ' ').trim();
        if (useCtx && result) {
            this.context.add(source, question, result);
        }
        return result;
    }

    /** Whether the LAST {@link answer} asked the user something (LLM-signalled via [[LISTEN]]). */
    private lastFollowUp = false;

    /**
     * System-prompt instruction letting the LLM explicitly signal a follow-up: append [[LISTEN]] when it
     * asks the user something and waits for an answer. More reliable than a "?" heuristic and lets a
     * satellite re-open its mic on the model's decision. Localized (de/en/ru).
     */
    private followUpHint(): string {
        const lang = String(this.config.voiceLanguage || this.language || 'en');
        if (lang === 'ru') {
            return 'Если твой ответ — это встречный вопрос и ты ждёшь ответа пользователя, добавь в самом конце управляющий маркер [[LISTEN]] (он удаляется и не произносится). Если ответа не требуется — не добавляй.';
        }
        if (lang === 'de') {
            return 'Wenn deine Antwort eine Rückfrage an den Nutzer ist und du auf dessen Antwort wartest, hänge ganz am Ende den Steuer-Marker [[LISTEN]] an (er wird entfernt und nicht vorgelesen). Wenn keine Antwort nötig ist, hänge ihn nicht an.';
        }
        return 'If your reply asks the user something and you are waiting for their answer, append the control marker [[LISTEN]] at the very end (it is removed and not spoken). If no answer is expected, do not append it.';
    }

    /**
     * Current date/time line, prepended to the user turn so the LLM has a clock — it has none otherwise and
     * cannot answer "what time/day is it?" or reason about relative times. Uses the host's local timezone and
     * a localized label (de/en/ru). Deliberately kept OUT of the (prompt-cached) system prompt: a per-request
     * timestamp there would bust the cache — incl. the large device list — on every single call.
     */
    private buildTimeContext(): string {
        const lang = String(this.config.voiceLanguage || this.language || 'en');
        const locale = lang === 'de' ? 'de-DE' : lang === 'ru' ? 'ru-RU' : 'en-GB';
        let tz = '';
        try {
            tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
        } catch {
            /* no ICU/timezone data — omit the zone name */
        }
        const formatted = new Intl.DateTimeFormat(locale, {
            weekday: 'long',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        }).format(new Date());
        const label =
            lang === 'ru'
                ? 'Текущие дата и время'
                : lang === 'de'
                  ? 'Aktuelles Datum und Uhrzeit'
                  : 'Current date and time';
        return tz ? `${label}: ${formatted} (${tz}).` : `${label}: ${formatted}.`;
    }

    /**
     * Answer a time/date query from the rule-based NLU directly off the host clock — instant, offline, no
     * LLM. Localized (de/en/ru) spoken-style reply; uses the host's local timezone via {@link Intl}.
     */
    private executeTimeIntent(intent: NluIntent): string {
        const lang = String(this.config.voiceLanguage || this.language || 'en');
        const locale = lang === 'de' ? 'de-DE' : lang === 'ru' ? 'ru-RU' : 'en-GB';
        const now = new Date();
        if (intent.action === 'dateQuery') {
            const date = new Intl.DateTimeFormat(locale, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric',
            }).format(now);
            const s = lang === 'ru' ? `Сегодня ${date}.` : lang === 'de' ? `Heute ist ${date}.` : `Today is ${date}.`;
            // The ru locale already ends the date with "г." — collapse the resulting ".." to a single period.
            return s.replace(/\.+$/, '.');
        }
        const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(now);
        return lang === 'ru' ? `Сейчас ${time}.` : lang === 'de' ? `Es ist ${time} Uhr.` : `It's ${time}.`;
    }

    private async produceAnswer(question: string, history: ConversationTurn[], source = ''): Promise<string> {
        this.log.debug(`answer: source='${source}', context=${history.length} turn(s)`);
        // A ringing timer/alarm is silenced by a stop word ("stop"/"halt"/"aufhören"/…) — checked first so
        // it always wins over the normal pipeline while something is ringing.
        if (this.rings.length && isStopCommand(question)) {
            const n = this.stopRinging();
            this.log.info(`Ring stopped by voice (${n} session(s)).`);
            const lang = String(this.config.voiceLanguage || this.language || 'en');
            return lang === 'ru' ? 'Хорошо.' : lang === 'de' ? 'Ok.' : 'Okay.';
        }
        // An open question from `askUser` claims the next utterance of that source as its answer — before
        // any tier sees it, because the NLU would read a bare "yes"/"the kitchen" as a command of its own.
        // We stay silent (empty reply): whoever asked decides what to say about the answer.
        if (this.pending.has(source)) {
            const asked = this.pending.question(source);
            if (this.pending.deliver(source, question)) {
                this.log.info(`Answer to "${asked}" from source '${source || 'any'}': ${question}`);
                return '';
            }
        }
        // A routine is a macro the user wrote down, so it wins over everything that interprets: the NLU
        // would find "Licht" in "Gute Nacht, Licht aus" and do half of it, and the LLM would cost a
        // round-trip for a decision that has already been made.
        const routine = matchRoutine(question, this.routines);
        if (routine) {
            this.log.info(`Routine '${routine.name}' triggered (source='${source}').`);
            await this.runRoutine(routine, source);
            return routine.reply;
        }
        // Tier 0: rule-based NLU (device commands) — fastest, offline, free.
        if (this.config.useLocalNlu) {
            try {
                const handled = await this.tryLocalNlu(question, source);
                if (handled !== null) {
                    this.log.info(`Answered by rule-based NLU (source='${source}').`);
                    return handled;
                }
            } catch (e) {
                this.log.debug(`NLU skipped: ${(e as Error).message}`);
            }
        }
        // Current weather from the configured adapter — prepended to the user turn of BOTH LLM tiers so
        // "how's the weather?" is answered from real data (the local model has no tools and would otherwise
        // invent a forecast; the cloud model saves a get_weather round-trip). Cached, see buildWeatherContext.
        const weather = await this.buildWeatherContext();
        // Tier 1a: local LLM — answers general questions offline; emits HANDOFF for anything needing tools.
        // Skipped inside an ongoing conversation (history present): the tool-free local model gets no history,
        // so it would answer a follow-up like "yes" context-free and swallow it — let the cloud LLM (which has
        // the thread and the tools) handle follow-ups instead.
        if (this.config.useLocalLlm && this.localLlm && !history.length) {
            try {
                // The local model has no tools: without these lines it would invent the weather and guess
                // who is at home.
                const facts = [weather, this.buildPresenceContext()].filter(Boolean).join('\n\n');
                const ans = await this.localLlm.ask(facts ? `${facts}\n\n${question}` : question);
                if (ans && !isHandoff(ans)) {
                    this.log.info(`Answered by local LLM (source='${source}').`);
                    return ans;
                }
                this.log.debug('Local LLM handed off to the cloud LLM.');
            } catch (e) {
                this.log.debug(`Local LLM error: ${(e as Error).message}`);
            }
        } else if (this.config.useLocalLlm && this.localLlm) {
            this.log.debug('Local LLM skipped (follow-up in an ongoing conversation → cloud LLM).');
        }
        // Tier 2: cloud LLM with full tool access. Inject a compact device list into the system prompt so
        // the model can act without a first `list_devices` round-trip (kept cached via prompt caching).
        if (!this.agent) {
            throw new Error('agent not ready');
        }
        const ctx = await this.buildDeviceContext();
        const mem = this.buildMemoryContext();
        // Only ask the model to emit the follow-up marker when satellites can actually re-open the mic.
        const followUp = this.config.voiceEnabled ? this.followUpHint() : '';
        const parts = [this.config.systemPrompt || '', followUp, mem, ctx].filter(Boolean);
        const sys = parts.length ? parts.join('\n\n') : undefined;
        this.log.info(
            `Cloud LLM [${this.agent.model}] (source='${source}', context=${history.length} turn(s)${mem ? ', memory' : ''}${weather ? ', weather' : ''}${this.presence?.configured ? ', presence' : ''}) — running tool loop…`,
        );
        // Prepend the current date/time (and the weather line, if a source is configured) to the user turn —
        // cache-safe, see buildTimeContext. The stored history keeps the untouched question.
        const questionForLlm = [this.buildTimeContext(), weather, question].filter(Boolean).join('\n\n');
        return this.agent.ask(questionForLlm, sys, history);
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

    /**
     * Run the rule-based NLU; returns a response string if it produced executable intents, else null.
     * A combined command ("Schalte A an und setze B auf 30 %", "Schalte A und B an") yields several
     * intents: they are all checked up front and only then executed in order, so an utterance is never
     * half-executed here and then handed to the LLM, which would repeat the parts already done.
     */
    private async tryLocalNlu(question: string, source = ''): Promise<string | null> {
        if (!this.mcp) {
            return null;
        }
        // Timer intents match device-independently (parse() checks them first), so build the NLU even
        // when no devices are known and always try timers before bailing out.
        const { rooms, devices } = await this.getNluDevices();
        const intents = new Nlu(rooms, devices, this.getNluAliases()).parseAll(question);
        if (!intents.length || !intents.every(i => this.canExecuteNlu(i, devices.length))) {
            return null; // nothing matched, or one part cannot run here → let the LLM answer the whole thing
        }
        const answers: string[] = [];
        let failed = false;
        for (const intent of intents) {
            try {
                answers.push(await this.executeNluIntent(intent, source));
            } catch (e) {
                failed = true;
                // Nothing executed yet → hand the whole utterance to the LLM. Afterwards a state has already
                // been written and the LLM would repeat it, so report the failed part instead of bailing out.
                if (!answers.length) {
                    throw e;
                }
                this.log.warn(`NLU intent '${intent.action}' failed: ${(e as Error).message}`);
                answers.push(this.nluFailureText(intent));
            }
        }
        if (intents.length > 1) {
            this.log.debug(`NLU handled a combined command (${intents.length} parts).`);
        }
        const answer = answers.filter(Boolean).join(' ');
        // A switch command that worked needs no sentence: a beep says the same thing a second earlier.
        // Only for voice (a chat reads its answer), only for control intents (a query's answer IS the
        // information), and only when nothing failed (an error has to be spoken).
        if (
            this.config.confirmWithTone &&
            answer &&
            !failed &&
            intents.every(i => CONTROL_ACTIONS.has(i.action)) &&
            (await this.playConfirmationTone(source))
        ) {
            this.log.debug(`NLU confirmed with a tone instead of "${answer}".`);
            return '';
        }
        return answer;
    }

    /**
     * Can this intent run locally at all? Checked for **every** part of a combined command before anything
     * is executed: a missing manager, no known devices or disabled writes send the whole utterance to the
     * LLM (which can explain why) instead of silently doing nothing — or only half of it.
     */
    private canExecuteNlu(intent: NluIntent, deviceCount: number): boolean {
        switch (intent.action) {
            case 'timerSet':
            case 'timerQuery':
            case 'timerCancel':
                return !!this.timers;
            case 'alarmSet':
            case 'alarmQuery':
            case 'alarmCancel':
                return !!this.alarms;
            case 'timeQuery':
            case 'dateQuery':
                return true;
            default:
                // Device intents; writes additionally require the coarse "allow control" toggle.
                return (
                    deviceCount > 0 &&
                    (!['on', 'off', 'level', 'color'].includes(intent.action) || !!this.config.allowWriteStates)
                );
        }
    }

    /** Execute one intent that {@link canExecuteNlu} accepted, and return its spoken answer. */
    private async executeNluIntent(intent: NluIntent, source: string): Promise<string> {
        switch (intent.action) {
            case 'timerSet':
            case 'timerQuery':
            case 'timerCancel':
                return this.executeTimerIntent(intent, source);
            case 'alarmSet':
            case 'alarmQuery':
            case 'alarmCancel':
                return this.executeAlarmIntent(intent, source);
            case 'timeQuery':
            case 'dateQuery':
                return this.executeTimeIntent(intent);
            default:
                return this.executeIntent(intent);
        }
    }

    /** Localized "this part did not work" sentence for a failed part of a combined command. */
    private nluFailureText(intent: NluIntent): string {
        const lang = String(this.config.voiceLanguage || this.language || 'en');
        const what = intent.device?.name ? ` (${intent.device.name})` : '';
        return lang === 'ru'
            ? `Одну команду${what} выполнить не удалось.`
            : lang === 'de'
              ? `Ein Befehl${what} hat nicht funktioniert.`
              : `One command${what} did not work.`;
    }

    /**
     * The configured NLU synonym dictionary filtered to the current interaction language (entries with no
     * language apply to every language). Passed to {@link Nlu} so spoken/typed variants are rewritten to
     * the canonical device/room/action wording before matching.
     */
    private getNluAliases(): { from: string; to: string }[] {
        const iso = String(this.config.voiceLanguage || this.language || 'en')
            .split('-')[0]
            .toLowerCase();
        return (this.config.nluAliases || [])
            .filter(a => a?.from && a?.to && (!a.language || String(a.language).split('-')[0].toLowerCase() === iso))
            .map(a => ({ from: a.from, to: a.to }));
    }

    /**
     * Vocabulary hints for STT biasing: the room and device names (in the interaction language), so the
     * speech engine better recognizes those proper nouns — exactly the words the NLU then needs to match.
     * Reuses the cached NLU device model; engines that support soft biasing (Whisper/Azure) consume it.
     */
    private async buildSttHints(): Promise<string[]> {
        try {
            const { rooms, devices } = await this.getNluDevices();
            const set = new Set<string>();
            for (const r of rooms) {
                if (r) {
                    set.add(r);
                }
            }
            for (const d of devices) {
                if (d.name) {
                    set.add(d.name);
                }
            }
            return [...set];
        } catch (e) {
            this.log.debug(`STT hints unavailable: ${(e as Error).message}`);
            return [];
        }
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
                    const roles: Record<string, string> = {};
                    const stateIds: string[] = [];
                    for (const [ct, c] of Object.entries(dev.controls || {})) {
                        if (c?.stateId) {
                            controls[ct] = c.stateId;
                            writable[ct] = !!c.writable;
                            types[ct] = (c as { ioBrokerValueType?: string }).ioBrokerValueType || '';
                            roles[ct] = (c as { role?: string }).role || '';
                            stateIds.push(c.stateId);
                        }
                    }
                    if (!stateIds.length) {
                        continue;
                    }
                    // The type detector sometimes exposes only a numeric `<base>.SET` level and omits the
                    // sibling on/off switch. Enrich the model with the ioBroker alias/iot convention switch
                    // (`<base>.ON_SET` / `<base>.ON`) so on/off and "set to X%" can power the device on.
                    if (!Object.keys(controls).some(k => types[k] === 'boolean')) {
                        for (const [k, id] of Object.entries(controls)) {
                            if (types[k] === 'number' && /\.SET$/.test(id)) {
                                const onId = await this.probeSiblingSwitch(id);
                                if (onId) {
                                    controls.on = onId;
                                    types.on = 'boolean';
                                    writable.on = true;
                                    roles.on = 'switch';
                                    break;
                                }
                            }
                        }
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
                        roles,
                    });
                }
            }
            return { rooms: [...rooms], devices };
        } catch (e) {
            this.log.debug(`getNluDevices failed: ${(e as Error).message}`);
            return { rooms: [], devices: [] };
        }
    }

    /**
     * Find the writable boolean on/off sibling of a `<base>.SET` level state (ioBroker alias/iot convention:
     * `<base>.ON_SET`, or `<base>.ON`). Cached (incl. negative results) so it probes each state at most once.
     * Returns the sibling state id, or '' if there is none.
     */
    private async probeSiblingSwitch(setId: string): Promise<string> {
        if (!/\.SET$/.test(setId)) {
            return '';
        }
        const cached = this.siblingSwitch.get(setId);
        if (cached !== undefined) {
            return cached;
        }
        let result = '';
        for (const suffix of ['.ON_SET', '.ON']) {
            const onId = setId.replace(/\.SET$/, suffix);
            try {
                const obj = await this.getForeignObjectAsync(onId);
                const c = obj?.common as { type?: string; write?: boolean } | undefined;
                if (c && c.type === 'boolean' && c.write !== false) {
                    result = onId;
                    break;
                }
            } catch {
                /* sibling not present — try the next suffix */
            }
        }
        this.siblingSwitch.set(setId, result);
        return result;
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
        // Category query ("how is the air in here") — same idea, but reports measurements.
        if (intent.action === 'categoryQuery') {
            return this.executeCategoryQuery(intent);
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
        if (!(await this.writeConfirmed(intent.stateId, intent.value))) {
            return pick(
                `${dev}${where} не ответило.`,
                `${dev}${where} hat nicht reagiert.`,
                `${dev}${where} did not respond.`,
            );
        }
        // Secondary write: also flip the device's on/off switch when setting a level (e.g. dimmer that needs
        // an explicit power-on besides the level). Same device → covered by the write-ACL check above.
        if (intent.also) {
            this.log.debug(
                `NLU control ${device.name} (also): set_state ${intent.also.stateId} = ${intent.also.value}`,
            );
            await mcp.callTool('set_state', { id: intent.also.stateId, value: intent.also.value });
        }

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

    /**
     * Answer a question about a kind of measurement: read every device of that kind (optionally in one
     * room) and name the values. One device gives a short sentence, several give a list — "wie warm ist
     * es überall" is one question, not five.
     *
     * Air quality additionally gets a word for the number, because an IAQ of 85 means nothing to anyone
     * (the scale and the wording come from the Python original, `core/hannah/iobroker.py` `_iaq_label`).
     */
    private async executeCategoryQuery(intent: NluIntent): Promise<string> {
        const mcp = this.mcp;
        if (!mcp) {
            throw new Error('mcp not ready');
        }
        const lang = String(this.config.voiceLanguage || this.language || 'en');
        const ru = lang === 'ru';
        const de = lang === 'de';
        const pick = (rus: string, ger: string, eng: string): string => (ru ? rus : de ? ger : eng);

        const acl = this.config.deviceAcl || {};
        const list = (intent.devices || [])
            .map(d => {
                const ids = Object.values(d.controls);
                return { name: d.name, room: d.room, key: deviceKey(ids), stateId: ids[0] };
            })
            .filter(d => d.stateId && acl[d.key]?.read !== false);
        if (!list.length) {
            return pick('Нет подходящих датчиков.', 'Keine passenden Sensoren gefunden.', 'No matching sensors found.');
        }

        let states: { id?: string; value?: unknown }[] = [];
        try {
            const res = await mcp.callTool('get_states', { ids: list.map(d => d.stateId) });
            states =
                (JSON.parse(res.text) as { data?: { states?: { id?: string; value?: unknown }[] } }).data?.states || [];
        } catch {
            states = [];
        }
        const valueById = new Map(states.map(st => [st.id, st.value]));

        const parts: string[] = [];
        for (const device of list) {
            const value = valueById.get(device.stateId);
            if (value === undefined || value === null) {
                continue; // a sensor without a reading adds nothing to a spoken answer
            }
            let unit = '';
            try {
                const obj = await this.getForeignObjectAsync(device.stateId);
                unit = (obj?.common as { unit?: string } | undefined)?.unit || '';
            } catch {
                /* no unit */
            }
            let text = this.describeValue(value, lang, unit);
            if (intent.category === 'airQuality') {
                const label = iaqLabel(value, unit, lang);
                if (label) {
                    text = `${text} (${label})`;
                }
            }
            // In one room the room name is already given; across rooms it is the useful half.
            const where = intent.room ? device.name : device.room || device.name;
            parts.push(`${where}: ${text}`);
        }
        if (!parts.length) {
            return pick('Нет данных.', 'Dazu liegen keine Werte vor.', 'There are no readings for that.');
        }
        const where = intent.room ? ` (${intent.room})` : '';
        const heading = CATEGORY_LABELS[intent.category || '']?.[ru ? 'ru' : de ? 'de' : 'en'] || '';
        return `${heading}${where}: ${parts.join(', ')}.`;
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
            onFire: t => {
                this.mirrorTimer(t, 'finished');
                this.onTimerFired(t);
            },
            onChange: list => {
                this.mirrorTimerList(list);
                void this.renderTimers(list).catch(e => this.log.debug(`renderTimers: ${e}`));
            },
        });
        // Cancel controls: the global "cancel all" and each per-timer `.cancel` button.
        this.subscribeStates('timers.cancelAll');
        this.subscribeStates('timers.items.*');
        // Drop any per-timer objects left over from before the restart; restore then recreates the live ones.
        await this.delObjectAsync('timers.items', { recursive: true }).catch(() => {});
        this.timerObjIds.clear();
        await this.restoreTimers();
    }

    /**
     * Push the active timer list to the ESPHome satellites, which show a running timer on their own LED
     * ring and ring it themselves (feature flag TIMERS). The device keeps its own copy, so it only needs
     * the transitions: a timer it has not seen is `started`, one that vanished without firing was
     * `cancelled`, and {@link mirrorTimer} reports `finished` from the fire callback.
     *
     * A timer is mirrored to the satellite it was set from, or broadcast when it came from elsewhere
     * (chat, telegram, a script) — otherwise setting a timer by text would leave every speaker silent.
     */
    private mirrorTimerList(list: TimerInfo[]): void {
        if (!this.esphome) {
            return;
        }
        const live = new Map(list.map(t => [t.id, t]));
        for (const [id, previous] of this.mirroredTimers) {
            if (!live.has(id)) {
                this.mirrorTimer(previous, 'cancelled');
            }
        }
        for (const timer of list) {
            this.mirrorTimer(timer, this.mirroredTimers.has(timer.id) ? 'updated' : 'started');
        }
        this.mirroredTimers = live;
    }

    /** Send one timer transition to the satellite it belongs to (or all, when its origin is not one). */
    private mirrorTimer(timer: TimerInfo, type: TimerEvent['type']): void {
        if (!this.esphome) {
            return;
        }
        const known = this.esphome.devices();
        const target = known.includes(timer.source) ? timer.source : null;
        const event: TimerEvent = {
            type,
            id: timer.id,
            name: timer.label || '',
            totalSeconds: timer.duration,
            secondsLeft: Math.max(0, Math.round((timer.fireAt - Date.now()) / 1000)),
            active: type === 'started' || type === 'updated',
        };
        this.esphome.timerEvent(target, event);
        if (type === 'cancelled' || type === 'finished') {
            this.mirroredTimers.delete(timer.id);
        }
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
            await mk('duration', {
                name: 'Duration',
                type: 'number',
                role: 'value.interval',
                unit: 's',
                read: true,
                write: false,
            });
            await mk('fireAt', { name: 'Fires at', type: 'number', role: 'value.time', read: true, write: false });
            await mk('cancel', {
                name: 'Cancel this timer',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                def: false,
            });
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
        this.fireEffects(this.config.timerSound || '', announce, this.timerAnnounceMessage(t), target);
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

    /**
     * Resolve an announcement target to satellite state ids: `null` means every satellite (an empty name
     * or `all`), an empty array means the name is unknown — the caller decides whether that is an error
     * (`askUser`) or a warning (an announcement).
     *
     * A concrete satellite or room wins over a configured group of the same name, so naming a group after
     * a room can never make that room's speaker unreachable (the rule comes from the Python original,
     * `core/main.py:717`).
     */
    private resolveTargets(target: string | null | undefined): string[] | null {
        if (isBroadcast(target)) {
            return null;
        }
        const wanted = String(target).trim();
        const direct = this.resolveSatelliteId(wanted);
        if (direct) {
            return [direct];
        }
        const group = findTarget(wanted, this.announceTargets);
        if (!group) {
            return [];
        }
        const ids = [...new Set(group.members.map(m => this.resolveSatelliteId(m)).filter((id): id is string => !!id))];
        if (!ids.length) {
            this.log.warn(`Target '${group.name}' has no known satellite among: ${group.members.join(', ')}`);
        } else if (ids.length < group.members.length) {
            this.log.debug(`Target '${group.name}' → ${ids.join(', ')} (some members are not known satellites)`);
        }
        return ids;
    }

    /**
     * Resolve what a caller named — a satellite state id (`satellites.kitchen`, `kitchen`), a room name or
     * a device name — to a known satellite state id, or null if we have never seen it. Rooms resolve like
     * ids because a satellite's state id *is* its sanitised room name (see {@link satelliteStateId}).
     */
    private resolveSatelliteId(nameOrId: string): string | null {
        const raw = (nameOrId || '').trim();
        if (!raw) {
            return null;
        }
        const bare = raw.replace(`${this.namespace}.`, '').replace(/^satellites\./, '');
        const id = this.satelliteStateId(bare, '');
        if (this.satDeviceById.has(id) || this.nativeSatFrom.has(id)) {
            return id;
        }
        // Not an id — maybe the device name behind one.
        return this.announceTargetForSource(raw);
    }

    /**
     * Ask the user something and wait for the answer: speak the question on the target satellite(s), have
     * them re-open the microphone, and resolve with whatever is said next there — the utterance is routed
     * to the caller instead of to the NLU/LLM (see {@link PendingQuestions}).
     *
     * `target`/`room` pick a satellite (omit both → every satellite, first answer wins). `source` instead
     * arms a text channel (e.g. `'chat'`, `'telegram:Max'`) without speaking anything: there the caller
     * sends the question itself and we only claim the reply.
     *
     * This is what the proactive triggers (roadmap A2) will use, and it is available to scripts:
     * `sendTo('assistant.0', 'askUser', { question: 'Fenster schließen?', room: 'Küche' }, cb)`.
     */
    private async askUser(msg: {
        question?: string;
        text?: string;
        target?: string;
        room?: string;
        source?: string | string[];
        timeoutMs?: number;
    }): Promise<{ question?: string; answer?: string; timeout?: boolean; error?: string }> {
        const question = String(msg.question ?? msg.text ?? '').trim();
        if (!question) {
            return { error: 'no question provided' };
        }
        const timeoutMs = Math.max(1000, Number(msg.timeoutMs) || ASK_TIMEOUT_MS);

        // Text channel: arm the named sources only — the caller does its own output.
        const sources = (Array.isArray(msg.source) ? msg.source : msg.source ? [msg.source] : [])
            .map(s => String(s).trim())
            .filter(Boolean);
        if (sources.length) {
            this.log.info(`askUser (waiting on ${sources.join(', ')}, ${timeoutMs} ms): ${question}`);
            const answer = await this.pending.ask(sources, question, timeoutMs);
            return answer === null ? { question, timeout: true } : { question, answer };
        }

        // Voice: resolve the target before arming, so a typo doesn't leave a question hanging. A group
        // or a person resolves to several satellites — the question is asked on all of them and the
        // first answer counts, which is what asking a room full of speakers means.
        const target = (msg.target || msg.room || '').trim();
        const targetIds = this.resolveTargets(target);
        if (targetIds && !targetIds.length) {
            return { error: `unknown satellite, room or group '${target}'` };
        }
        const keys = targetIds ? targetIds.map(id => this.satDeviceById.get(id) || id) : [ANY_SOURCE];
        this.log.info(
            `askUser → ${targetIds ? targetIds.join(', ') : 'all satellites'} (${timeoutMs} ms): ${question}`,
        );
        if (!(await this.announceToSatellites(question, target || null, { listen: true }))) {
            return { error: 'question not asked — no satellite reachable' };
        }
        // Armed only now, on purpose: the answer cannot arrive before the device has played the question,
        // so arming earlier would just risk claiming an utterance that was never meant as the answer.
        const answer = await this.pending.ask(keys, question, timeoutMs);
        if (answer === null) {
            this.log.info(`askUser: no answer within ${timeoutMs} ms.`);
            return { question, timeout: true };
        }
        return { question, answer };
    }

    /**
     * Wait for the device to confirm a write, if the user asked for that (`verifyWrites`). ioBroker's
     * convention is that a command is written with `ack:false` and the device echoes the value back with
     * `ack:true` once it really happened — so without this check the assistant reports success for a
     * lamp that never answered.
     *
     * Polled rather than subscribed: a one-off poll of one state is cheap, while a temporary
     * subscription would have to be registered, routed through `onStateChange` and torn down again for
     * every single command. Returns true when it is confirmed — and also when verification is switched
     * off or impossible, because a check that cannot run must not turn into a false alarm.
     */
    private async writeConfirmed(stateId: string | undefined, expected: unknown): Promise<boolean> {
        if (!this.config.verifyWrites || !stateId) {
            return true;
        }
        const deadline = Date.now() + ACK_TIMEOUT_MS;
        let last: ioBroker.State | null | undefined;
        while (Date.now() < deadline) {
            await this.delay(ACK_POLL_MS);
            last = await this.getForeignStateAsync(stateId).catch(() => null);
            if (last?.ack && valuesMatch(last.val, expected)) {
                this.log.debug(`write to ${stateId} confirmed by the device.`);
                return true;
            }
        }
        this.log.warn(
            `No confirmation for ${stateId} within ${ACK_TIMEOUT_MS} ms ` +
                `(last: ${JSON.stringify(last?.val)}, ack=${String(last?.ack)}). ` +
                'If this device never acknowledges, switch "Verify device feedback" off.',
        );
        return false;
    }

    /**
     * Play the confirmation beep on the satellite a command came from. Returns false when there is nowhere
     * to play it (a text channel, or no satellite reachable) — the caller then speaks the reply instead,
     * because a confirmation nobody hears is worse than one that costs a TTS call.
     */
    private async playConfirmationTone(source: string): Promise<boolean> {
        const target = this.announceTargetForSource(source);
        if (!target) {
            return false; // chat/telegram/unknown origin: there is no speaker to beep on
        }
        const { pcm, sampleRate } = confirmationTone();
        // Priority: this is the answer to something the user just asked for, not an unsolicited noise.
        const delivered = await this.deliverPcm(pcm, sampleRate, target, true);
        return delivered > 0;
    }

    /** Execute a timer intent (set/query/cancel) from the NLU and return a spoken-style reply. */
    private executeTimerIntent(intent: NluIntent, source: string): string {
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
            return pick(
                `Таймер на ${dur} установлен${tail}.`,
                `Timer auf ${dur} gestellt${tail}.`,
                `Timer set for ${dur}${tail}.`,
            );
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
            return pick(
                `Отменено таймеров: ${victims.length}.`,
                `${victims.length} Timer abgebrochen.`,
                `Cancelled ${victims.length} timers.`,
            );
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
                        label: String((args.label as string) || ''),
                        room: String((args.room as string) || ''),
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
                    properties: {
                        id: { type: 'string', description: 'Timer id from list_timers; omit to cancel all' },
                    },
                    additionalProperties: false,
                },
                run: (args): Promise<string> => {
                    if (!this.timers) {
                        return Promise.resolve(JSON.stringify({ ok: false, error: 'timers unavailable' }));
                    }
                    if (args.id && typeof args.id === 'string') {
                        const ok = this.timers.cancel(args.id);
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
            await mk('weekdays', {
                name: 'Weekdays (0=Sun..6=Sat, empty=once)',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            });
            await mk('nextFireAt', { name: 'Next fire', type: 'number', role: 'value.time', read: true, write: false });
            await mk('enabled', {
                name: 'Enabled',
                type: 'boolean',
                role: 'switch.enable',
                read: true,
                write: true,
                def: true,
            });
            await mk('delete', {
                name: 'Delete this alarm',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                def: false,
            });
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
        this.setStateAsync('alarms.lastFired', { val: a.label || formatClock(a.hour, a.minute), ack: true }).catch(
            () => {},
        );
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
        this.fireEffects(this.config.alarmSound || '', announce, msg, target);
    }

    /** Execute an alarm intent (set/query/cancel) from the NLU and return a spoken-style reply. */
    private executeAlarmIntent(intent: NluIntent, source: string): string {
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
            return pick(
                `Удалено будильников: ${victims.length}.`,
                `${victims.length} Wecker gelöscht.`,
                `Deleted ${victims.length} alarms.`,
            );
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
                        label: String((args.label as string) || ''),
                        room: String((args.room as string) || ''),
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
                    properties: {
                        id: { type: 'string', description: 'Alarm id from list_alarms; omit to delete all' },
                    },
                    additionalProperties: false,
                },
                run: (args): Promise<string> => {
                    if (!this.alarms) {
                        return Promise.resolve(JSON.stringify({ ok: false, error: 'alarms unavailable' }));
                    }
                    if (args.id && typeof args.id === 'string') {
                        const ok = this.alarms.cancel(args.id);
                        return Promise.resolve(JSON.stringify({ ok, data: { deleted: ok ? 1 : 0 } }));
                    }
                    const n = this.alarms.cancelAll();
                    return Promise.resolve(JSON.stringify({ ok: true, data: { deleted: n } }));
                },
            },
        ];
    }

    // ── Announcements by name (roadmap B2) ──────────────────────────────────

    /**
     * Tool that lets the model speak somewhere instead of answering: "tell Denis dinner is ready", "let
     * everyone upstairs know". Without it a model can read and switch states but has no way to make a
     * speaker say something, so the configured groups and people would only be reachable from scripts.
     *
     * The configured names go into the description, because the model cannot discover them otherwise.
     */
    private buildAnnounceTool(): Tool {
        const named = describeTargets(this.announceTargets);
        return {
            name: 'announce',
            description:
                `Speak a message out loud on a voice satellite — use it when the user asks you to tell ` +
                `somebody something, or to announce something in a room. Not for answering the user: your ` +
                `normal reply is already spoken. "target" is a room, a satellite name${
                    named ? `, or one of the configured ${named}` : ''
                }; leave it out to announce everywhere.`,
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'What to say, as one spoken sentence' },
                    target: { type: 'string', description: 'Room, satellite, group or person (empty = all)' },
                },
                required: ['text'],
                additionalProperties: false,
            },
            run: async (args): Promise<string> => {
                // The arguments come from the model, so a non-string is simply not a text.
                const text = typeof args.text === 'string' ? args.text.trim() : '';
                if (!text) {
                    return JSON.stringify({ ok: false, error: 'no text given' });
                }
                const target = typeof args.target === 'string' ? args.target.trim() : '';
                const spoken = await this.announceToSatellites(text, target || null);
                return spoken
                    ? JSON.stringify({ ok: true, data: { spoken } })
                    : JSON.stringify({
                          ok: false,
                          error: target
                              ? `nothing was played — '${target}' is no known satellite, room or group, or it is offline`
                              : 'nothing was played — no satellite is reachable',
                      });
            },
        };
    }

    // ── Presence: who is at home (roadmap B1) ───────────────────────────────

    /**
     * Build the presence tracker from the configured states, subscribe to them and mirror the result into
     * `presence.*`. The values are read once up front, because a presence state only reports when it
     * changes — without that, the assistant would believe nobody is home until the first person moves.
     */
    private async setupPresence(): Promise<void> {
        const entries = parsePresenceRows(this.config.presence);
        this.presence = new PresenceTracker({
            entries,
            log: this.log,
            onChange: list => void this.renderPresence(list).catch(e => this.log.debug(`renderPresence: ${e}`)),
            onArrival: who => {
                this.setStateAsync('presence.lastArrival', { val: who.name, ack: true }).catch(() => {});
            },
            onDeparture: who => {
                this.setStateAsync('presence.lastDeparture', { val: who.name, ack: true }).catch(() => {});
            },
        });
        if (!entries.length) {
            return;
        }
        for (const id of this.presence.stateIds()) {
            await this.subscribeForeignStatesAsync(id).catch(e =>
                this.log.warn(`presence: cannot watch '${id}': ${(e as Error).message}`),
            );
            const st = await this.getForeignStateAsync(id).catch(() => null);
            this.presence.update(id, st?.val ?? null);
        }
        await this.renderPresence(this.presence.list());
        this.log.info(
            `Presence: ${entries.length} source(s) configured, ${this.presence.home().length} at home right now.`,
        );
    }

    /** Mirror who is at home into `presence.{anyoneHome,count,list}`. */
    private async renderPresence(list: PresenceInfo[]): Promise<void> {
        const home = list.filter(p => p.home === true && p.kind !== 'pet');
        await this.setStateAsync('presence.anyoneHome', { val: home.length > 0, ack: true });
        await this.setStateAsync('presence.count', { val: home.length, ack: true });
        await this.setStateAsync('presence.list', { val: JSON.stringify(list), ack: true });
    }

    /**
     * Who is at home, as one line for the user turn — never for the (prompt-cached) system prompt: it
     * changes with every arrival and would bust the cache, device list included. Empty when no presence
     * source is configured or nothing is known yet.
     */
    private buildPresenceContext(): string {
        if (!this.presence?.configured) {
            return '';
        }
        return buildPresencePrompt(this.presence.list(), String(this.config.voiceLanguage || this.language || 'en'));
    }

    /**
     * Should an announcement that asked to be spoken only to an occupied house be held back? With no
     * presence source configured the answer is no — "nobody configured" must not read as "nobody home",
     * or the feature would silence every announcement the moment someone ticks the box.
     */
    private emptyHouse(): boolean {
        return this.presence?.configured === true && !this.presence.anyoneHome();
    }

    // ── System notifications (roadmap A3) ───────────────────────────────────

    /**
     * Speak a system notification. The text is cleaned of ioBroker's origin prefixes and — unless the
     * severity is `direct` or rewording is switched off — reworded by the LLM into one spoken sentence
     * with a tone matching the severity, because the raw texts are written for a log viewer.
     *
     * An `alert` is delivered as a **priority** announcement, so it is heard even on a satellite set to
     * Do-Not-Disturb; everything else respects DND. Returns how many channels it reached.
     */
    private async notify(
        raw: string,
        severity: Severity,
        target: string | null = null,
        onlyWhenHome = false,
    ): Promise<number> {
        const clean = cleanupNotificationText(raw);
        if (!clean) {
            return 0;
        }
        let text = clean;
        if (severity !== 'direct' && this.config.notifyRephrase !== false && this.agent) {
            text = await this.agent.rewordNotification(
                clean,
                toneFor(severity),
                this.config.voiceLanguage || this.language || '',
                this.config.systemPrompt,
            );
        }
        this.log.info(`Notification (${severity}): ${text}`);
        this.setStateAsync('notify.last', { val: text, ack: true }).catch(() => {});
        return this.announceToSatellites(text, target, { priority: bypassesDnd(severity), onlyWhenHome });
    }

    /**
     * Handle a notification routed here by the ioBroker notification-manager (`sendNotification` message,
     * advertised through `common.supportedMessages.notifications`). Answers `{ sent }`, which tells the
     * manager whether it may mark the notification as handled — so we only claim it when it was actually
     * spoken somewhere.
     *
     * The payload shape belongs to the notification-manager and is parsed defensively
     * ({@link flattenNotification}): a changed field degrades the spoken sentence, it never throws.
     */
    private async handleSystemNotification(message: unknown): Promise<{ sent: boolean }> {
        const flat = flattenNotification(message, String(this.config.voiceLanguage || this.language || 'en'));
        if (!flat.text) {
            this.log.warn('Notification from the notification-manager had nothing to speak.');
            return { sent: false };
        }
        this.log.debug(`Notification (${flat.severity}) from category '${flat.category}': ${flat.text}`);
        const delivered = await this.notify(flat.text, flat.severity);
        return { sent: delivered > 0 };
    }

    // ── Proactive triggers (roadmap A2) ─────────────────────────────────────

    /**
     * Build the trigger engine from the configured definitions, mirror it into `triggers.*` and subscribe
     * to exactly the foreign states the conditions reference — nothing broader, because a wildcard
     * subscription on a busy system would wake this adapter for every state in the house.
     */
    private async setupTriggers(): Promise<void> {
        this.triggers = new TriggerEngine({
            now: () => Date.now(),
            log: this.log,
            getState: async id => {
                const st = await this.getForeignStateAsync(id).catch(() => null);
                return st?.val ?? undefined;
            },
            execute: def => this.executeTrigger(def),
            onChange: status => void this.renderTriggers(status).catch(e => this.log.debug(`renderTriggers: ${e}`)),
        });
        this.subscribeStates('triggers.enabled');
        this.subscribeStates('triggers.items.*');
        // Per-trigger objects are rebuilt from the configuration, so drop whatever a previous run left.
        await this.delObjectAsync('triggers.items', { recursive: true }).catch(() => {});
        this.triggerObjIds.clear();

        const master = await this.getStateAsync('triggers.enabled');
        this.triggersEnabled = master?.val !== false;
        const persisted = await this.readTriggerStatus();
        this.triggers.load(this.getTriggerDefs());
        if (persisted.length) {
            this.triggers.restore(persisted);
        }
        await this.syncTriggerSubscriptions();
        // Remember the current values before the first change arrives, so a device that re-reports an
        // unchanged value right after the start does not look like a transition.
        await this.triggers.prime();
        const n = this.triggers.list().length;
        if (n) {
            this.log.info(
                `Triggers: ${n} loaded, watching ${this.triggerStateIds.size} state(s)${this.triggersEnabled ? '' : ' — all suppressed by triggers.enabled'}.`,
            );
        }
    }

    /** The configured triggers, with the table's JSON columns parsed (see {@link parseTriggerRows}). */
    private getTriggerDefs(): TriggerDef[] {
        return parseTriggerRows(this.config.triggers, {
            rephraseDefault: this.config.triggerRephrase === true,
            warn: message => this.log.warn(message),
        });
    }

    /** Subscribe to the states the loaded triggers watch, and drop subscriptions nothing watches any more. */
    private async syncTriggerSubscriptions(): Promise<void> {
        const wanted = new Set(this.triggers?.stateIds() ?? []);
        // A presence source may be the same state a trigger watches — dropping the subscription here would
        // silently stop the presence updates too.
        const keep = new Set(this.presence?.stateIds() ?? []);
        for (const id of [...this.triggerStateIds]) {
            if (!wanted.has(id)) {
                if (!keep.has(id)) {
                    await this.unsubscribeForeignStatesAsync(id).catch(() => {});
                }
                this.triggerStateIds.delete(id);
            }
        }
        for (const id of wanted) {
            if (!this.triggerStateIds.has(id)) {
                await this.subscribeForeignStatesAsync(id).catch(e =>
                    this.log.warn(`trigger: cannot watch '${id}': ${(e as Error).message}`),
                );
                this.triggerStateIds.add(id);
            }
        }
    }

    /** Live status (enabled flag, last fire) persisted in `triggers.list`, so a restart keeps both. */
    private async readTriggerStatus(): Promise<TriggerStatus[]> {
        try {
            const st = await this.getStateAsync('triggers.list');
            if (typeof st?.val === 'string' && st.val) {
                const arr = JSON.parse(st.val);
                return Array.isArray(arr) ? (arr as TriggerStatus[]) : [];
            }
        } catch (e) {
            this.log.debug(`readTriggerStatus failed: ${(e as Error).message}`);
        }
        return [];
    }

    /** Mirror the trigger status into the summary states and the per-trigger `triggers.items.<id>` objects. */
    private async renderTriggers(status: TriggerStatus[]): Promise<void> {
        await this.setStateAsync('triggers.count', { val: status.length, ack: true });
        await this.setStateAsync('triggers.list', { val: JSON.stringify(status), ack: true });

        const wanted = new Set(status.map(t => t.id));
        for (const id of [...this.triggerObjIds]) {
            if (!wanted.has(id)) {
                await this.delObjectAsync(`triggers.items.${id}`, { recursive: true }).catch(() => {});
                this.triggerObjIds.delete(id);
            }
        }
        if (status.length) {
            await this.setObjectNotExistsAsync('triggers.items', {
                type: 'channel',
                common: { name: 'Triggers' },
                native: {},
            });
        }
        for (const t of status) {
            await this.ensureTriggerObject(t);
        }
    }

    /** Create (once) and update the `triggers.items.<id>.*` states for a single trigger. */
    private async ensureTriggerObject(t: TriggerStatus): Promise<void> {
        const base = `triggers.items.${t.id}`;
        if (!this.triggerObjIds.has(t.id)) {
            await this.setObjectNotExistsAsync(base, {
                type: 'channel',
                common: { name: t.name || t.id },
                native: {},
            });
            const mk = (sub: string, common: ioBroker.StateCommon): Promise<unknown> =>
                this.setObjectNotExistsAsync(`${base}.${sub}`, { type: 'state', common, native: {} });
            await mk('name', { name: 'Name', type: 'string', role: 'text', read: true, write: false });
            await mk('lastFired', { name: 'Last fired', type: 'number', role: 'value.time', read: true, write: false });
            await mk('nextFireAt', {
                name: 'Next scheduled fire (time triggers)',
                type: 'number',
                role: 'value.time',
                read: true,
                write: false,
            });
            await mk('pendingUntil', {
                name: 'Pending delay runs at (0 = nothing pending)',
                type: 'number',
                role: 'value.time',
                read: true,
                write: false,
            });
            await mk('enabled', {
                name: 'Enabled',
                type: 'boolean',
                role: 'switch.enable',
                read: true,
                write: true,
                def: true,
            });
            await mk('fire', {
                name: 'Run this trigger now (ignores cooldown and delay)',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                def: false,
            });
            this.triggerObjIds.add(t.id);
        }
        await this.setStateAsync(`${base}.name`, { val: t.name, ack: true });
        await this.setStateAsync(`${base}.lastFired`, { val: t.lastFired, ack: true });
        await this.setStateAsync(`${base}.nextFireAt`, { val: t.nextFireAt, ack: true });
        await this.setStateAsync(`${base}.pendingUntil`, { val: t.pendingUntil, ack: true });
        await this.setStateAsync(`${base}.enabled`, { val: t.enabled, ack: true });
    }

    /**
     * Run a trigger: either ask the user and act on the answer, or run its actions. The master switch
     * (`triggers.enabled`) is checked here rather than in the engine, so the schedule keeps running and
     * only the visible/audible effect is suppressed.
     */
    private async executeTrigger(def: TriggerDef): Promise<void> {
        if (!this.triggersEnabled) {
            this.log.debug(`trigger '${def.id}' suppressed — triggers.enabled is off`);
            return;
        }
        this.setStateAsync('triggers.lastFired', { val: def.name || def.id, ack: true }).catch(() => {});
        if (def.ask) {
            await this.askTrigger(def);
            return;
        }
        for (const action of effectiveActions(def)) {
            await this.runTriggerAction(def, action);
        }
    }

    /**
     * Where a trigger speaks or asks. Empty (or Hannah's `all`, which people copy from its examples) means
     * every satellite; a configured room we do not know is worth a warning, because announcing everywhere
     * instead of in one room is the kind of surprise that should not stay silent in the log.
     */
    private triggerTarget(def: TriggerDef, room: string | undefined): string | null {
        if (isBroadcast(room)) {
            return null;
        }
        const wanted = String(room).trim();
        const ids = this.resolveTargets(wanted);
        if (ids && !ids.length) {
            this.log.warn(`trigger '${def.id}': '${wanted}' is no known satellite, room or group — using all of them`);
            return null;
        }
        return wanted;
    }

    /** Ask the trigger's question, then let the first matching response rule decide what happens. */
    private async askTrigger(def: TriggerDef): Promise<void> {
        const question = await this.triggerText(def, def.ask || '');
        const target = this.triggerTarget(def, def.room);
        const result = await this.askUser({ question, target: target || undefined });
        if (result.error) {
            this.log.warn(`trigger '${def.id}': could not ask — ${result.error}`);
            return;
        }
        if (result.timeout || !result.answer) {
            this.log.info(`trigger '${def.id}': no answer — nothing done`);
            return;
        }
        const rules = def.onResponse || [];
        let fallback: TriggerResponseRule | undefined;
        for (const rule of rules) {
            const want = (rule.match || '').trim();
            if (!want) {
                fallback ??= rule; // a rule without a category is the "didn't understand" case
                continue;
            }
            if (!this.agent) {
                this.log.warn(`trigger '${def.id}': no LLM to match the answer against '${want}'`);
                break;
            }
            if (await this.agent.classify(result.answer, want)) {
                this.log.info(`trigger '${def.id}': answer matched '${want}'`);
                await this.runTriggerAction(def, rule);
                return;
            }
        }
        if (fallback) {
            await this.runTriggerAction(def, fallback);
        } else {
            this.log.info(`trigger '${def.id}': answer "${result.answer}" matched no rule`);
        }
    }

    /** Speak a trigger's `say` and/or write its `setState` — shared by the actions and the response rules. */
    private async runTriggerAction(
        def: TriggerDef,
        action: TriggerAction | TriggerResponseRule,
        fallbackTarget: string | null = null,
    ): Promise<void> {
        const say = (action.say || '').trim();
        if (say) {
            const room = 'room' in action ? action.room : def.room;
            // A routine speaks where it was asked for, unless the action names a room of its own.
            const target = this.triggerTarget(def, room) ?? fallbackTarget;
            await this.announceToSatellites(await this.triggerText(def, say), target);
        }
        const write = action.setState;
        if (write?.id) {
            // Deliberately gated: someone who switched device control off does not expect a trigger to
            // write states behind that setting.
            if (!this.config.allowWriteStates) {
                this.log.warn(
                    `trigger '${def.id}': not writing ${write.id} — device control is disabled in the settings`,
                );
                return;
            }
            try {
                await this.setForeignStateAsync(write.id, { val: write.value, ack: false });
                this.log.info(`trigger '${def.id}': ${write.id} = ${JSON.stringify(write.value)}`);
            } catch (e) {
                this.log.warn(`trigger '${def.id}': cannot write ${write.id}: ${(e as Error).message}`);
            }
        }
    }

    /**
     * Run a routine's actions. They are {@link TriggerAction}s, so this borrows the trigger executor — a
     * routine really is a trigger whose condition is a spoken phrase. A failing action is logged and the
     * rest still runs: most of a "good night" is better than none of it.
     */
    private async runRoutine(routine: Routine, source: string): Promise<void> {
        const origin = this.announceTargetForSource(source);
        for (const action of routine.actions) {
            try {
                await this.runTriggerAction({ id: `routine:${routine.name}`, when: [] }, action, origin);
            } catch (e) {
                this.log.warn(`Routine '${routine.name}': an action failed — ${(e as Error).message}`);
            }
        }
    }

    /** A trigger's text, optionally reworded by the LLM so a recurring announcement doesn't sound canned. */
    private async triggerText(def: TriggerDef, text: string): Promise<string> {
        if (!def.rephrase || !this.agent || !text) {
            return text;
        }
        return this.agent.rephrase(text, this.config.voiceLanguage || this.language || '', this.config.systemPrompt);
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
            await mk('delete', {
                name: 'Forget this fact',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                def: false,
            });
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
                    if (!this.memory || typeof args.text !== 'string') {
                        return Promise.resolve(JSON.stringify({ ok: false, error: 'memory is disabled' }));
                    }
                    const entry = this.memory.add({
                        text: args.text,
                        key: String((args.key as string) || ''),
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
                description:
                    'Forget a remembered fact by its id or its key. Use this when the user asks to forget something.',
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
                    const n = this.memory.forget(String((args.idOrKey as string) || ''));
                    return Promise.resolve(JSON.stringify({ ok: n > 0, data: { forgotten: n } }));
                },
            },
        ];
    }

    // ── Weather (read a user-selected weather adapter) ──────────────────────

    /**
     * Read the configured weather adapter's states and normalize them. `value` is the settings value
     * (`weatherInstance`): a state prefix that, for Open-Meteo, includes the location device
     * (`open-meteo-weather.0.Berlin`) and for others is just the instance (`weatherunderground.0`). Returns
     * a normalized report for known adapters, or a raw (filtered) state dump for unknown ones.
     */
    private async readWeather(
        value: string,
    ): Promise<{ report?: WeatherReport; raw?: StateValues; source?: string; error?: string }> {
        const root = value.trim();
        if (!root) {
            return { error: 'no weather source configured' };
        }
        const adapter = root.split('.')[0];
        const states: StateValues = {};
        try {
            const raw = await this.getForeignStatesAsync(`${root}.*`);
            for (const [id, st] of Object.entries(raw || {})) {
                states[id] = st?.val;
            }
        } catch (e) {
            return { error: `cannot read ${root}: ${(e as Error).message}` };
        }
        const report = buildWeatherReport(adapter, root, states);
        if (report) {
            return { report };
        }
        if (WEATHER_ADAPTERS[adapter]?.kind) {
            return { error: `weather adapter "${adapter}" selected but it has no data yet — start it once` };
        }
        // Unknown adapter: return a filtered raw dump so the LLM can still try.
        const weatherish =
            /(temp|wind|humid|rain|precip|cloud|pressure|forecast|current|state|condition|weather|snow|uv)/i;
        const dump: StateValues = {};
        let n = 0;
        for (const [id, v] of Object.entries(states)) {
            if (n >= 80) {
                break;
            }
            if ((typeof v === 'number' || typeof v === 'string') && weatherish.test(id)) {
                dump[id.slice(root.length + 1)] = v;
                n++;
            }
        }
        return Object.keys(dump).length ? { raw: dump, source: adapter } : { error: 'no weather data found' };
    }

    /**
     * Compact current-weather line for the LLM, prepended to the user turn (never to the prompt-cached
     * system prompt — the values change constantly and would bust the cache, incl. the large device list,
     * on every call). Cached for {@link WEATHER_CTX_TTL}; the cache key carries source + language so a
     * settings change takes effect at once. Returns '' when no source is configured, the adapter has no
     * data yet, or it has no mapper (unknown adapters stay tool-only — a raw state dump is no prompt line).
     */
    private async buildWeatherContext(): Promise<string> {
        const value = (this.config.weatherInstance || '').trim();
        if (!value) {
            return '';
        }
        const lang = String(this.config.voiceLanguage || this.language || 'en');
        const key = `${value}|${lang}`;
        const now = Date.now();
        if (this.weatherCtx && this.weatherCtx.key === key && now - this.weatherCtx.ts < WEATHER_CTX_TTL) {
            return this.weatherCtx.text;
        }
        let text = '';
        try {
            const res = await this.readWeather(value);
            if (res.report) {
                text = buildWeatherPrompt(res.report, lang);
            } else if (res.error) {
                this.log.debug(`Weather context skipped: ${res.error}`);
            }
        } catch (e) {
            this.log.debug(`Weather context failed: ${(e as Error).message}`);
        }
        // Cache the empty result too — a missing/unmapped source must not re-read the tree every request.
        this.weatherCtx = { key, ts: now, text };
        return text;
    }

    /** The LLM tool for weather questions (reads the configured weather adapter). */
    private buildWeatherTool(): Tool {
        return {
            name: 'get_weather',
            description:
                'Get the current weather and forecast from the configured weather station. Use this for any question about the weather, the temperature outside, rain, wind, or the forecast. Optional "when": current/today, tomorrow, or week.',
            parameters: {
                type: 'object',
                properties: {
                    when: {
                        type: 'string',
                        enum: ['current', 'today', 'tomorrow', 'week'],
                        description: 'Which period',
                    },
                },
                additionalProperties: false,
            },
            run: async (args): Promise<string> => {
                const value = (this.config.weatherInstance || '').trim();
                if (!value) {
                    return JSON.stringify({
                        ok: false,
                        error: 'No weather source configured in the assistant settings.',
                    });
                }
                const res = await this.readWeather(value);
                if (res.report) {
                    return JSON.stringify({ ok: true, data: trimReport(res.report, (args.when as string) || '') });
                }
                if (res.raw) {
                    return JSON.stringify({ ok: true, data: { source: res.source, states: res.raw } });
                }
                return JSON.stringify({ ok: false, error: res.error || 'no weather data' });
            },
        };
    }

    /**
     * List installed weather-adapter instances for the settings dropdown (selectSendTo). For Open-Meteo,
     * each configured location becomes its own option (the data is namespaced per location).
     */
    private async getWeatherInstances(): Promise<{ label: string; value: string }[]> {
        const options: { label: string; value: string }[] = [{ label: '—', value: '' }];
        const instances: Record<string, ioBroker.Object> = {};
        try {
            const view = await this.getObjectViewAsync('system', 'instance', {
                startkey: 'system.adapter.',
                endkey: 'system.adapter.香',
            });
            for (const row of view?.rows || []) {
                if (row.value) {
                    instances[row.id] = row.value;
                }
            }
        } catch (e) {
            this.log.warn(`getWeatherInstances failed: ${(e as Error).message}`);
            return options;
        }
        for (const obj of Object.values(instances)) {
            const adapter = String((obj.common as { name?: string })?.name || '');
            const meta = WEATHER_ADAPTERS[adapter];
            if (!meta) {
                continue;
            }
            const instanceId = String(obj._id).replace('system.adapter.', '');
            if (meta.perLocationProbe) {
                // Adapter namespaces data per location — list each configured location as its own option.
                const marker = `.${meta.perLocationProbe.split('.')[0]}.`;
                let found = false;
                try {
                    const rows = await this.getForeignStatesAsync(`${instanceId}.*.${meta.perLocationProbe}`);
                    for (const id of Object.keys(rows || {})) {
                        const loc = id.slice(instanceId.length + 1, id.indexOf(marker));
                        if (loc) {
                            options.push({
                                label: `${meta.label}: ${loc.replace(/_/g, ' ')}`,
                                value: `${instanceId}.${loc}`,
                            });
                            found = true;
                        }
                    }
                } catch {
                    /* fall through to the instance-level option */
                }
                if (!found) {
                    options.push({ label: `${meta.label} (${instanceId})`, value: instanceId });
                }
            } else {
                options.push({ label: `${meta.label} (${instanceId})`, value: instanceId });
            }
        }
        return options;
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
            this.stopRinging();
        } catch {
            // ignore
        }
        try {
            // Resolve open questions with null instead of leaving their callers waiting for a timeout.
            this.pending.cancelAll();
        } catch {
            // ignore
        }
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
            this.triggers?.dispose();
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
            await this.esphome?.stop();
        } catch {
            // ignore
        }
        try {
            await this.media?.stop();
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
