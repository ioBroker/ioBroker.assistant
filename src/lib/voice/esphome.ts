/**
 * ESPHome voice satellites — the fourth transport, next to the UDP server (`voiceServer.ts`) and the
 * Wyoming endpoint (`wyoming.ts`).
 *
 * Unlike those two, this one is a **client**: an ESPHome voice satellite is a *server* that waits on
 * TCP 6053 for the home-automation controller to connect and drive it. We therefore dial out to each
 * configured device and play the role Home Assistant normally plays. That covers the ThirdReality
 * Voice & Music Assistant (Dev Edition), the Home Assistant Voice PE and any box running
 * OHF-Voice/linux-voice-assistant.
 *
 * Flow for one utterance (verified against the firmware's `src/satellite/Satellite.cpp`):
 *
 *   device  →  VoiceAssistantRequest{start, wake_word_phrase}   wake word fired on the device
 *   we      →  VoiceAssistantResponse{port:0}                   0 = audio over the API, no UDP
 *   we      →  RUN_START, WAKE_WORD_END, STT_START, STT_VAD_START
 *   device  →  VoiceAssistantAudio …                            16 kHz mono s16le, *until told to stop*
 *   we      →  STT_VAD_END                                      ← the device has no VAD of its own
 *   we      →  STT_END{text}, INTENT_START, INTENT_END, TTS_START{text}, TTS_END{url}, RUN_END
 *   device  →  fetches the URL over HTTP, plays it, VoiceAssistantAnnounceFinished
 *
 * Two consequences shape this file: end-of-speech detection is ours (`vad.ts`), and the spoken reply
 * has to be reachable over HTTP (`mediaServer.ts`) rather than streamed down the socket.
 */
import * as net from 'node:net';
import {
    pb,
    encode,
    decode,
    type PbMessage,
    type AuthenticationResponse,
    type DeviceInfoResponse,
    type HelloResponse,
    type VoiceAssistantAnnounceFinished,
    type VoiceAssistantAudio,
    type VoiceAssistantConfigurationResponse,
    type VoiceAssistantEventData,
    type VoiceAssistantRequestMsg,
} from './esphomeProto';
import { EntityRegistry, isEntityStateMessage, isListEntityMessage, type EsphomeEntity } from './esphomeEntities';
import { SpeechDetector, type CaptureEnd, type Bytes, type VadReport } from './vad';
import { prepareForStt } from './speechAudio';
import { chooseReplyFormat, encodeReply, type ExternalEncoder, type ReplyFormat } from './replyFormat';
import { levelProfile, type DiscardedCapture, type DiscardReason } from './captures';
import type { SttEngine } from './stt';
import type { TtsEngine } from './tts';
import type { SatelliteState } from './protocol';

/** `VoiceAssistantEvent` (api.proto) — the subset we emit. */
const EVENT = {
    ERROR: 0,
    RUN_START: 1,
    RUN_END: 2,
    STT_START: 3,
    STT_END: 4,
    INTENT_START: 5,
    INTENT_END: 6,
    TTS_START: 7,
    TTS_END: 8,
    WAKE_WORD_END: 10,
    STT_VAD_START: 11,
    STT_VAD_END: 12,
} as const;

/** `SubscribeVoiceAssistantRequest.flags`: audio over the API socket instead of a UDP side channel. */
const SUBSCRIBE_API_AUDIO = 1;
/** ESPHome voice satellites always capture at 16 kHz mono 16-bit. */
const MIC_SAMPLE_RATE = 16000;
/**
 * Leading audio to keep out of the end-of-speech analysis. These devices acknowledge the wake word
 * with a chirp through their own speaker and hear it back on their own microphone, far louder than
 * the speech that follows. Without this the chirp alone satisfies the detector's speech test — so
 * `sawSpeech` stops meaning "somebody said something" and a false wake is billed to STT — and it
 * drags the noise floor up with it.
 *
 * Measured over four captures from a ThirdReality Voice & Music Assistant (RMS per 50 ms, remarkably
 * repeatable across all four):
 *
 *     ms    0    50   100   150   200   250   300   350   400   450   500   550   600
 *     rms  ~20 ~900 ~11k  ~19k  ~14k  ~1.3k ~990  ~780  ~610  ~370  ~330  ~165  ~180
 *
 * so the chirp is still above the gate at 500 ms and only clears it around 550–600. 600 ms is the
 * smallest value that rejects a chirp-only wake while still detecting the speech in every one of the
 * four captures, with no change to when the utterance closes. Only the analysis skips it: STT gets the audio
 * from 400 ms before the detected speech (`speechAudio.ts`), so a speaker who starts inside this window loses
 * nothing but a late gate open.
 */
const WAKE_CHIRP_MS = 600;
/** Default API port of an ESPHome device. */
const DEFAULT_PORT = 6053;
/** Keepalive interval; two missed replies count as a dead link. */
const PING_INTERVAL_MS = 20_000;
/** Wait between reconnect attempts. Devices reboot, and a Wi-Fi speaker drops off now and then. */
const RECONNECT_MS = 10_000;
/** Give up on a pipeline that produced no audio at all (device wedged mid-stream). */
const PIPELINE_TIMEOUT_MS = 30_000;
/** How long we wait for the device to report that it finished playing before forcing it back to idle. */
const PLAYBACK_TIMEOUT_MS = 60_000;
/**
 * Default lowest RMS that counts as speech (the noise floor can only raise the gate above it). Fits the
 * ThirdReality speaker; quieter microphones get their own value per device ({@link EsphomeDevice.speechLevel}).
 */
export const DEFAULT_SPEECH_LEVEL = 250;
/**
 * Close the microphone when nobody has started speaking this long after the wake word. Without it a false wake
 * kept the stream open for the full 12 s cap: on a ThirdReality speaker with a custom wake word that was ten
 * times in one night, each 12.6 s of an open mic (and of music ducked, if any played).
 */
const NO_SPEECH_MS = 5000;
/** The same after a follow-up question re-opened the mic: the user may need a moment to think. */
const NO_SPEECH_FOLLOW_UP_MS = 8000;
/** Silence that ends an utterance when the configuration leaves it empty. */
const DEFAULT_SILENCE_MS = 900;
/**
 * After this much speech a pause may be {@link LONG_PAUSE_FACTOR} times as long before the utterance ends: whoever
 * talks that long is dictating a request and pauses to think, while "Licht an" should still close quickly. Field
 * report 2026-11-03: "Я хочу, чтоб ты создал задачу, чтобы утром говорить мне…" was cut off right there.
 */
const LONG_REQUEST_MS = 2500;
const LONG_PAUSE_FACTOR = 1.5;
/**
 * Sound needed before a loud moment counts as speech. On vitanova (2026-11-03) a single 100 ms sound at RMS 197
 * after a false wake opened the gate (threshold 150), and Whisper made "и все просят." of the amplified silence
 * around it. The shortest real answer, "да", lasts about 250 ms.
 */
const MIN_SPEECH_MS = 200;
/**
 * Close the utterance when the device stops sending audio without ending the stream. Seen on a ThirdReality
 * speaker: the audio stopped after 2.7 s, and the satellite showed "listening" for the 30 s of
 * {@link PIPELINE_TIMEOUT_MS}. A device streams every few tens of ms while the mic is open.
 */
const STREAM_STALL_MS = 2000;
/** The same before the first audio arrives: a device needs a moment to open the microphone. */
const STREAM_START_MS = 5000;
/** How often a running capture checks for a stalled stream. */
const STALL_CHECK_MS = 250;
/** Silence threshold as a share of the speech threshold — keeps the default pair 250/150. */
const SILENCE_SHARE = 0.6;
/**
 * The firmware answers an ERROR event with a stop request of its own (`signal_stop_`). One arriving this soon after
 * our error belongs to it and needs no reply — the run is already over.
 */
const ERROR_ECHO_MS = 2000;
/**
 * What ends a run that produced no request. Home Assistant sends the same code when the speech recognition finds no
 * text, and the Voice PE firmware deliberately plays no error sound for it.
 */
const NO_TEXT_ERROR = { code: 'stt-no-text-recognized', message: 'No text recognized' };
/**
 * A dropped utterance whose loudest frame reached this share of the speech threshold was probably a voice
 * that was too quiet, not an empty room — worth telling the user where to lower the threshold.
 */
const QUIET_VOICE_SHARE = 0.4;
/**
 * Event entity of a satellite with a screen: the user answered the open question by touch, event type `yes` or `no`.
 * Pressing it is the same as saying "yes"/"no" into the open microphone — no speech recognition to get it wrong
 * (a German "Ja" came back as "Я" once).
 */
const CONFIRM_ENTITY = 'confirm_answer';
/** Select entity of a satellite with a screen: the language of the date and the hints it shows. */
const DISPLAY_LANGUAGE_ENTITY = 'display_language';
/**
 * After a reply that asks something: how long, beyond the reply's own length, the device may take to play it and
 * open the microphone. Until then a button press answers the question.
 */
const FOLLOW_UP_START_MS = 10_000;
/**
 * A button press still answers the question this long after the follow-up microphone closed: the firmware may stop
 * the microphone on the press before it reports which button it was.
 */
const CONFIRM_GRACE_MS = 3000;
/**
 * After a button answer: a follow-up microphone the device opens this soon was asked for by the question the button
 * already answered, and is closed at once (unless our reply asked something again).
 */
const IGNORE_FOLLOW_UP_MS = 15_000;

/** "Yes" and "no" as a button answer is passed on: the words of the satellite's language, which pi-agent also takes. */
const YES_NO: Record<string, [yes: string, no: string]> = {
    en: ['Yes', 'No'],
    de: ['Ja', 'Nein'],
    ru: ['Да', 'Нет'],
    pt: ['Sim', 'Não'],
    nl: ['Ja', 'Nee'],
    fr: ['Oui', 'Non'],
    it: ['Sì', 'No'],
    es: ['Sí', 'No'],
    pl: ['Tak', 'Nie'],
    uk: ['Так', 'Ні'],
    zh: ['是', '不'],
};

/** The word a yes/no button stands for in `language` (ISO 639-1, `zh-cn` too); English for an unknown one. */
export function yesNoWord(language: string, yes: boolean): string {
    const base = (language || 'en').trim().toLowerCase().split(/[-_]/)[0];
    return (YES_NO[base] ?? YES_NO.en)[yes ? 0 : 1];
}

/** The event type of a {@link CONFIRM_ENTITY} as yes (true) or no (false); null for anything else. */
export function confirmAnswerOf(eventType: unknown): boolean | null {
    const type = typeof eventType === 'string' ? eventType.trim().toLowerCase() : '';
    if (type === 'yes' || type === 'confirm') {
        return true;
    }
    if (type === 'no' || type === 'cancel') {
        return false;
    }
    return null;
}

/**
 * Names of the adapter's languages in that language, for a display-language select. `Intl.DisplayNames` covers the
 * rest, but a Node.js built with only English ICU data knows no "Deutsch" or "Русский".
 */
const NATIVE_LANGUAGE_NAMES: Record<string, string> = {
    en: 'english',
    de: 'deutsch',
    ru: 'русский',
    pt: 'português',
    nl: 'nederlands',
    fr: 'français',
    it: 'italiano',
    es: 'español',
    pl: 'polski',
    uk: 'українська',
    zh: '中文',
};

/**
 * The option of a display-language select that means `language`: its name in that language ("Deutsch"), in English
 * ("German") or its code ("de", "de-DE"), case ignored. Null when the device offers none of them.
 */
export function displayLanguageOption(options: string[], language: string): string | null {
    const code = (language || '').trim().toLowerCase();
    const base = code.split(/[-_]/)[0];
    if (!base) {
        return null;
    }
    const names = new Set<string>([code, base]);
    if (NATIVE_LANGUAGE_NAMES[base]) {
        names.add(NATIVE_LANGUAGE_NAMES[base]);
    }
    for (const locale of [base, 'en']) {
        try {
            const name = new Intl.DisplayNames([locale], { type: 'language' }).of(base);
            if (name) {
                names.add(name.toLocaleLowerCase(locale));
            }
        } catch {
            /* not a language code Intl knows */
        }
    }
    const norm = (option: string): string => option.trim().toLocaleLowerCase();
    return (
        options.find(o => names.has(norm(o))) ??
        options.find(o => norm(o).split(/[-_]/)[0] === base && /^[a-z]{2,3}([-_][a-z0-9]+)?$/.test(norm(o))) ??
        null
    );
}

/** The configured speech threshold of a device, or 0 for the default. Table cells may arrive as strings. */
export function speechLevelOf(device: EsphomeDevice): number {
    const level = Math.round(Number(device.speechLevel));
    return Number.isFinite(level) && level > 0 ? level : 0;
}

/** How a configured device is identified: `ip`, or `ip:port` when it does not use the default port. */
export function esphomeAddress(device: Pick<EsphomeDevice, 'ip' | 'port'>): string {
    const ip = (device.ip || '').trim().toLowerCase();
    const port = Number(device.port) || DEFAULT_PORT;
    return port === DEFAULT_PORT ? ip : `${ip}:${port}`;
}

export interface EsphomeDevice {
    /** Host name or IP of the satellite. */
    ip: string;
    /** API port; empty/0 → 6053. */
    port?: number | string;
    /** API password, if one is configured on the device. */
    password?: string;
    /** Room this satellite belongs to (drives `satellites.<room>.*` and the answer context). */
    room?: string;
    /**
     * Lowest RMS that counts as speech on this device (empty/0 → {@link DEFAULT_SPEECH_LEVEL}). Microphone
     * levels differ a lot: a ThirdReality speaker hears normal speech at RMS 350–470, a phone running a
     * satellite app at under 200, so one fixed floor cannot fit both.
     */
    speechLevel?: number | string | null;
}

export interface EsphomeSatellitesOptions {
    devices: EsphomeDevice[];
    /** ISO-639-1 language hint for STT/TTS ('' = auto/provider default). */
    language: string;
    stt: SttEngine;
    tts: TtsEngine;
    /**
     * Produce the assistant reply for a transcribed utterance. `audioMs` is the length of the recording,
     * `vad` what the voice activity detection made of it (both for the request journal). An answer given with the
     * device's yes/no button ({@link CONFIRM_ENTITY}) comes as the yes or no word, with `button` and no recording.
     */
    answer: (
        question: string,
        ctx: {
            device: string;
            room: string;
            /** Wake word of the recording; '' = the mic was re-opened for a follow-up; absent for a button. */
            wakeWord?: string;
            sttMs?: number;
            audioMs?: number;
            vad?: VadReport;
            button?: 'yes' | 'no';
        },
    ) => Promise<string>;
    /** The reply was synthesised: how long that took and how long it plays (for the request journal). */
    onSpoken?: (device: string, info: { ms: number; audioMs: number }) => void;
    /** Optional STT vocabulary hints (device/room names) to bias recognition; re-read per utterance. */
    getHints?: () => string[] | Promise<string[]>;
    /** Where spoken replies are published for the device to fetch. */
    media: MediaHost;
    /**
     * Host the device should call back on. Empty → the local address of our socket to that device,
     * which is automatically the right interface on a multi-homed host.
     */
    mediaHost?: string;
    /** Silence that ends an utterance, in ms ('' / 0 → the detector default). */
    silenceMs?: number;
    log: ioBroker.Logger;
    /**
     * Notified on every satellite state transition (idle/listening/processing/speaking/offline). `host` is the
     * configured address (`ip`, or `ip:port` for another port than 6053), so the adapter can tell which table row
     * a satellite belongs to.
     */
    onStatus?: (device: string, room: string, state: SatelliteState | 'offline', host: string) => void;
    /**
     * Writes replies as MP3 or Opus, for a media player that takes nothing else (ffmpeg in the adapter). Without it
     * such a device gets FLAC or WAV if it lists one of them, and a warning otherwise.
     */
    encodeAudio?: ExternalEncoder;
    /** Notified with the device's wake-word configuration, on connect and after every change. */
    onWakeWords?: (device: string, room: string, config: WakeWordConfig) => void;
    /** Notified once per connect with everything the device exposes besides the voice pipeline. */
    onEntities?: (device: string, room: string, entities: EsphomeEntity[]) => void;
    /** Notified whenever one of those entities changes (and once per entity right after connecting). */
    onEntityState?: (device: string, room: string, entity: EsphomeEntity) => void;
    /** True when the reply asks something back, so the device should re-open its mic without a wake word. */
    expectsFollowUp?: (answer: string, device: string) => boolean;
    /**
     * A recording that never became a request: dropped as silence, or returned empty by the speech recognition.
     * For diagnosis (the adapter stores it when asked to); absent → nothing is kept.
     */
    onDiscarded?: (capture: DiscardedCapture) => void;
    /**
     * Custom wake words to offer the devices, re-read for every configuration request. The device lists
     * them next to its own and downloads one (from the media server) only when it is selected.
     */
    externalWakeWords?: () => ExternalWakeWordOffer[];
}

/** A custom wake word as offered to the devices; the files are on the media server under `path`. */
export interface ExternalWakeWordOffer {
    id: string;
    phrase: string;
    languages: string[];
    /** Size of the `.tflite` in bytes. */
    size: number;
    /** SHA-256 of the `.tflite`, lower-case hex. */
    sha256: string;
    /** URL path of the JSON config, e.g. `/wakeword/hey_hannah_1a2b3c4d.json`; the model sits next to it. */
    path: string;
}

/** What a device reports about its wake words: what the firmware ships plus the custom ones we offered. */
export interface WakeWordConfig {
    /** Ids currently listening, e.g. `['okay_nabu']`. */
    active: string[];
    /** Every wake word the device can use, with the spoken phrase and the languages it was trained on. */
    available: { id: string; phrase: string; languages: string[] }[];
    /** How many may listen at once — 2 on the ThirdReality speaker, which has a sensitivity per slot. */
    max: number;
}

/** `VoiceAssistantTimerEvent` in api.proto. */
export const TIMER_EVENT = { started: 0, updated: 1, cancelled: 2, finished: 3 } as const;

/** One assistant timer, as the device wants to hear about it. */
export interface TimerEvent {
    type: keyof typeof TIMER_EVENT;
    id: string;
    name: string;
    totalSeconds: number;
    secondsLeft: number;
    /** False once it has finished or been cancelled — the device clears its ring on that. */
    active: boolean;
}

/** The slice of `MediaServer` this module needs (kept narrow so tests can pass a stub). */
export interface MediaHost {
    port: number;
    publish(body: Buffer, contentType?: string, ttlMs?: number): string;
}

/**
 * All configured ESPHome satellites. Owns one connection per device and offers the same surface the
 * adapter already uses for the UDP server: `devices()` and `announce()`.
 */
export class EsphomeSatellites {
    private readonly connections: EsphomeConnection[] = [];

    constructor(private readonly opts: EsphomeSatellitesOptions) {}

    async start(): Promise<void> {
        for (const device of this.opts.devices) {
            if (!device.ip?.trim()) {
                continue;
            }
            const connection = new EsphomeConnection(device, this.opts);
            this.connections.push(connection);
            connection.start();
        }
        if (!this.connections.length) {
            this.opts.log.warn('ESPHome satellites enabled, but no device addresses are configured.');
        }
        return Promise.resolve();
    }

    async stop(): Promise<void> {
        await Promise.all(this.connections.map(c => c.stop()));
        this.connections.length = 0;
    }

    /** Device names of the satellites currently connected. */
    devices(): string[] {
        return this.connections.filter(c => c.online).map(c => c.deviceName);
    }

    /** Wake-word configuration of one connected satellite, or null if it is unknown/offline. */
    wakeWords(device: string): WakeWordConfig | null {
        return this.connections.find(c => c.online && c.deviceName === device)?.wakeWordConfig ?? null;
    }

    /**
     * Choose which wake words listen on one satellite. Ids come from {@link WakeWordConfig.available};
     * the device stores the selection itself, so it survives a restart of the adapter.
     */
    setWakeWords(device: string, ids: string[]): boolean {
        const target = this.connections.find(c => c.online && c.deviceName === device);
        if (!target) {
            return false;
        }
        target.setWakeWords(ids);
        return true;
    }

    /**
     * Offer the current custom wake words to every connected satellite again — after one was uploaded
     * or deleted. Each device answers with its new configuration (→ `onWakeWords`).
     */
    refreshWakeWords(): number {
        const online = this.connections.filter(c => c.online);
        online.forEach(c => c.requestWakeWordConfig());
        return online.length;
    }

    /** Everything one satellite exposes besides the voice pipeline (gain, noise suppression, …). */
    entities(device: string): EsphomeEntity[] {
        return this.connections.find(c => c.online && c.deviceName === device)?.entities.list() ?? [];
    }

    /**
     * Write one of those entities. Returns false when the satellite is offline, the entity is unknown
     * or read-only, or the value is not one the device accepts.
     */
    setEntity(device: string, objectId: string, value: unknown): boolean {
        const target = this.connections.find(c => c.online && c.deviceName === device);
        return target ? target.setEntity(objectId, value) : false;
    }

    /**
     * Mirror an assistant timer onto the satellites so they can show it on their own LED ring and ring
     * it themselves. `device` null broadcasts. Returns how many devices were told.
     */
    timerEvent(device: string | null, event: TimerEvent): number {
        const targets = this.connections.filter(c => c.online && (!device || c.deviceName === device));
        targets.forEach(c => c.sendTimerEvent(event));
        return targets.length;
    }

    /**
     * Play a ready PCM buffer on one satellite (by device name) or all of them. Returns how many
     * devices it was handed to.
     *
     * With `startConversation` the device opens its microphone as soon as the clip has played, without
     * a wake word — that is how a question gets its answer (see `PendingQuestions`).
     */
    async announce(device: string | null, pcm: Buffer, sampleRate: number, startConversation = false): Promise<number> {
        const targets = this.connections.filter(c => c.online && (!device || c.deviceName === device));
        if (!targets.length) {
            return 0;
        }
        await Promise.all(
            targets.map(c =>
                c
                    .announce(pcm, sampleRate, startConversation)
                    .catch(e => this.opts.log.warn(`announce to ${c.deviceName} failed: ${(e as Error).message}`)),
            ),
        );
        return targets.length;
    }
}

/** State of the utterance currently being captured. */
interface Capture {
    chunks: Buffer[];
    detector: SpeechDetector;
    conversationId: string;
    /** Wake word that opened this capture; '' when the mic was re-opened for a follow-up/question. */
    wakeWord: string;
    /** The mic was re-opened for a reply that asked something: a yes/no button press answers it too. */
    answersQuestion: boolean;
    timer: NodeJS.Timeout;
    /** Watches for a device that stops sending audio without ending the stream. */
    stallCheck: NodeJS.Timeout;
    startedAt: number;
    /** When the last audio arrived; 0 = none yet. */
    lastAudioAt: number;
    closed: boolean;
}

/** One satellite: socket lifecycle, handshake, and the voice pipeline. */
class EsphomeConnection {
    /** Device name as reported by the device; falls back to its address until the handshake answers. */
    deviceName: string;
    online = false;
    /** Last wake-word configuration the device reported; null until the handshake answers. */
    wakeWordConfig: WakeWordConfig | null = null;
    /**
     * One entry per configuration request in flight, in send order (the device answers each one, in
     * order): the ids a preceding `SetConfiguration` asked for, or null. The read-back is the only
     * failure signal the device gives.
     */
    private configChecks: (string[] | null)[] = [];
    /** Everything else the device exposes — rebuilt from scratch on every reconnect. */
    readonly entities = new EntityRegistry();

    private readonly host: string;
    private readonly port: number;
    private readonly room: string;

    private socket: net.Socket | null = null;
    private rx: Bytes = Buffer.alloc(0);
    private pingTimer: NodeJS.Timeout | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private missedPings = 0;
    private stopping = false;
    private capture: Capture | null = null;
    private playbackTimer: NodeJS.Timeout | null = null;
    private readonly password: string;
    /** Configured speech threshold, 0 = {@link DEFAULT_SPEECH_LEVEL}. */
    private readonly speechLevel: number;
    /** `ip`, or `ip:port` for another port than the default — how the adapter recognises the table row. */
    private readonly address: string;
    /** The device's friendly name, for entities without a name of their own. */
    private friendlyName = '';
    /**
     * Number of the current pipeline run. A run whose number is no longer current was ended — the device asked to
     * stop, started over, or went away — and whatever STT, answer or TTS is still in flight for it stays silent.
     */
    private run = 0;
    /** From RUN_START until we sent RUN_END: the device waits for that RUN_END. */
    private runOpen = false;
    /** When we last sent an ERROR event (see {@link ERROR_ECHO_MS}). */
    private errorSentAt = 0;
    /** The reply format last reported in the log, to log it again only when it changes. */
    private loggedFormat = '';
    /**
     * The last reply asked something (`continue_conversation`, or an announcement with `start_conversation`): until
     * when a yes/no button press answers it while no follow-up recording is open. 0 = no open question.
     */
    private questionUntil = 0;
    /** After a button answer: until when a follow-up microphone is the stale one of the answered question. */
    private ignoreFollowUpUntil = 0;
    /** The display language was compared with ours since the last connect. */
    private displayLanguageChecked = false;

    constructor(
        device: EsphomeDevice,
        private readonly opts: EsphomeSatellitesOptions,
    ) {
        this.host = device.ip.trim();
        this.port = Number(device.port) || DEFAULT_PORT;
        this.room = (device.room || '').trim();
        this.password = device.password || '';
        this.speechLevel = speechLevelOf(device);
        this.address = esphomeAddress(device);
        this.deviceName = this.host;
    }

    // ── lifecycle ───────────────────────────────────────────────────────────────────────────────────

    start(): void {
        this.connect();
    }

    async stop(): Promise<void> {
        this.stopping = true;
        this.clearTimers();
        this.abortCapture();
        const socket = this.socket;
        this.socket = null;
        if (socket) {
            try {
                socket.write(encode(new pb.DisconnectRequest()));
            } catch {
                /* socket already gone — nothing to say goodbye on */
            }
            socket.destroy();
        }
        this.setOffline();
        return Promise.resolve();
    }

    private connect(): void {
        if (this.stopping) {
            return;
        }
        this.rx = Buffer.alloc(0);
        this.missedPings = 0;
        // The device re-announces everything after a reconnect, and the keys are not stable across
        // reboots, so starting from a clean slate is the only safe option.
        this.entities.clear();
        this.configChecks = [];
        this.displayLanguageChecked = false;

        const socket = net.createConnection({ host: this.host, port: this.port }, () => {
            this.opts.log.debug(`ESPHome ${this.host}:${this.port} connected`);
            this.handshake();
        });
        this.socket = socket;
        socket.setNoDelay(true);

        socket.on('data', data => this.onData(data));
        socket.on('error', e => {
            // A satellite that is switched off is normal, so this is not an error-level event.
            this.opts.log.debug(`ESPHome ${this.host}: ${e.message}`);
        });
        socket.on('close', () => {
            if (this.socket === socket) {
                this.socket = null;
                this.onDisconnected();
            }
        });
    }

    private onDisconnected(): void {
        this.clearTimers();
        this.abortCapture();
        // A reply still being worked out must not land on the next connection, in the middle of another run.
        this.run++;
        this.runOpen = false;
        this.questionUntil = 0;
        this.ignoreFollowUpUntil = 0;
        if (this.online) {
            this.opts.log.info(`ESPHome satellite offline: ${this.deviceName}`);
        }
        this.setOffline();
        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (this.stopping || this.reconnectTimer) {
            return;
        }
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, RECONNECT_MS);
        this.reconnectTimer.unref();
    }

    private clearTimers(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.playbackTimer) {
            clearTimeout(this.playbackTimer);
            this.playbackTimer = null;
        }
    }

    private setOffline(): void {
        if (this.online) {
            this.online = false;
            this.opts.onStatus?.(this.deviceName, this.room, 'offline', this.address);
        }
    }

    private status(state: SatelliteState): void {
        this.opts.onStatus?.(this.deviceName, this.room, state, this.address);
    }

    // ── protocol plumbing ───────────────────────────────────────────────────────────────────────────

    private send(message: PbMessage): void {
        const socket = this.socket;
        if (!socket || socket.destroyed) {
            return;
        }
        try {
            socket.write(encode(message));
        } catch (e) {
            this.opts.log.debug(`ESPHome ${this.deviceName}: send failed — ${(e as Error).message}`);
        }
    }

    private onData(data: Buffer): void {
        this.rx = this.rx.length ? Buffer.concat([this.rx, data]) : data;
        let frames;
        try {
            ({ frames, rest: this.rx } = decode(this.rx));
        } catch (e) {
            this.opts.log.error(`ESPHome ${this.deviceName}: ${(e as Error).message}`);
            this.socket?.destroy();
            return;
        }
        for (const frame of frames) {
            if (frame.error) {
                this.opts.log.debug(`ESPHome ${this.deviceName}: cannot parse ${frame.name}`);
                continue;
            }
            if (!frame.name || !frame.message) {
                continue; // unknown id — already skipped by its declared length
            }
            try {
                this.onMessage(frame.name, frame.message);
            } catch (e) {
                this.opts.log.warn(
                    `ESPHome ${this.deviceName}: ${frame.name} handler failed — ${(e as Error).message}`,
                );
            }
        }
    }

    private handshake(): void {
        const hello = new pb.HelloRequest();
        hello.setClientInfo('ioBroker.assistant');
        hello.setApiVersionMajor(1);
        hello.setApiVersionMinor(10);
        this.send(hello);

        const auth = new pb.AuthenticationRequest();
        auth.setPassword(this.password);
        this.send(auth);

        this.send(new pb.DeviceInfoRequest());
        // Ask for the entity announcements *before* subscribing to their states: a state message whose
        // entity we have not seen yet has nothing to attach to and is dropped.
        this.send(new pb.ListEntitiesRequest());
        this.send(new pb.SubscribeStatesRequest());

        const subscribe = new pb.SubscribeVoiceAssistantRequest();
        subscribe.setSubscribe(true);
        subscribe.setFlags(SUBSCRIBE_API_AUDIO);
        this.send(subscribe);

        this.requestWakeWordConfig();

        this.pingTimer = setInterval(() => {
            if (++this.missedPings > 2) {
                this.opts.log.info(`ESPHome ${this.deviceName}: no reply to keepalive — reconnecting`);
                this.socket?.destroy();
                return;
            }
            this.send(new pb.PingRequest());
        }, PING_INTERVAL_MS);
        this.pingTimer.unref();
    }

    private onMessage(name: string, message: unknown): void {
        switch (name) {
            case 'HelloResponse': {
                const hello = message as HelloResponse;
                this.opts.log.debug(
                    `ESPHome ${this.host}: ${hello.getServerInfo()} (API ${hello.getApiVersionMajor()}.${hello.getApiVersionMinor()})`,
                );
                return;
            }

            case 'AuthenticationResponse':
                if ((message as AuthenticationResponse).getInvalidPassword()) {
                    this.opts.log.error(
                        `ESPHome ${this.host}: API password rejected — check the device's password in the settings.`,
                    );
                    this.socket?.destroy();
                }
                return;

            case 'DeviceInfoResponse': {
                const info = message as DeviceInfoResponse;
                this.deviceName = info.getName() || this.host;
                this.friendlyName = info.getFriendlyName?.() || info.getName() || '';
                this.online = true;
                this.opts.log.info(
                    `ESPHome satellite online: ${this.deviceName} (${info.getModel()}) @ ${this.host}${this.room ? `, room ${this.room}` : ''}`,
                );
                this.status('idle');
                return;
            }

            case 'VoiceAssistantConfigurationResponse': {
                const config = message as VoiceAssistantConfigurationResponse;
                // A custom wake word the device already downloaded is listed twice: once from its own
                // model folder and once from our offer.
                const seen = new Set<string>();
                this.wakeWordConfig = {
                    active: config.getActiveWakeWordsList(),
                    available: config
                        .getAvailableWakeWordsList()
                        .map(w => ({
                            id: w.getId(),
                            phrase: w.getWakeWord(),
                            languages: w.getTrainedLanguagesList(),
                        }))
                        .filter(w => !seen.has(w.id) && !!seen.add(w.id)),
                    max: config.getMaxActiveWakeWords(),
                };
                const active = this.wakeWordConfig.active.join(', ') || '(none active)';
                const available = this.wakeWordConfig.available.map(w => w.id);
                this.opts.log.info(
                    `ESPHome ${this.deviceName}: wake words ${active}${available.length ? ` (available: ${available.join(', ')})` : ''}`,
                );
                const requested = this.configChecks.shift();
                const missing = requested?.filter(id => !this.wakeWordConfig?.active.includes(id)) ?? [];
                if (missing.length) {
                    // The device answers a model it cannot fetch or load with silence, not an error.
                    this.opts.log.warn(
                        `ESPHome ${this.deviceName}: could not activate wake word(s) ${missing.join(', ')}. ` +
                            `For an uploaded wake word the device must reach ${this.mediaUrl('/')} and the model ` +
                            `must be a microWakeWord .tflite.`,
                    );
                }
                this.opts.onWakeWords?.(this.deviceName, this.room, this.wakeWordConfig);
                return;
            }

            case 'VoiceAssistantRequest':
                this.onPipelineRequest(message as VoiceAssistantRequestMsg);
                return;

            case 'VoiceAssistantAudio':
                this.onAudio(message as VoiceAssistantAudio);
                return;

            case 'VoiceAssistantAnnounceFinished':
                if (this.playbackTimer) {
                    clearTimeout(this.playbackTimer);
                    this.playbackTimer = null;
                }
                this.opts.log.debug(
                    `ESPHome ${this.deviceName}: playback finished (success=${(message as VoiceAssistantAnnounceFinished).getSuccess()})`,
                );
                this.status('idle');
                return;

            case 'PingRequest':
                this.send(new pb.PingResponse());
                return;

            case 'PingResponse':
                this.missedPings = 0;
                return;

            case 'GetTimeRequest': {
                // The device has no RTC and syncs its clock from us — its timer ring depends on it.
                const time = new pb.GetTimeResponse();
                time.setEpochSeconds(Math.floor(Date.now() / 1000));
                this.send(time);
                return;
            }

            case 'DisconnectRequest':
                this.send(new pb.DisconnectResponse());
                this.socket?.destroy();
                return;

            case 'ListEntitiesDoneResponse': {
                const list = this.entities.list();
                if (list.length) {
                    this.opts.log.debug(
                        `ESPHome ${this.deviceName}: ${list.length} entities — ${list.map(e => e.objectId).join(', ')}`,
                    );
                }
                this.opts.onEntities?.(this.deviceName, this.room, list);
                return;
            }

            default:
                if (isListEntityMessage(name)) {
                    this.entities.addFromAnnouncement(name, message, this.friendlyName);
                } else if (isEntityStateMessage(name)) {
                    const entity = this.entities.applyState(name, message);
                    if (entity) {
                        this.opts.onEntityState?.(this.deviceName, this.room, entity);
                        this.onEntityChange(entity);
                    }
                }
                return;
        }
    }

    /** Entities of a satellite with a screen that take part in the conversation (see {@link CONFIRM_ENTITY}). */
    private onEntityChange(entity: EsphomeEntity): void {
        if (entity.objectId === CONFIRM_ENTITY && entity.kind === 'event') {
            this.onConfirmButton(entity.value);
        } else if (entity.objectId === DISPLAY_LANGUAGE_ENTITY && entity.kind === 'select') {
            // Once per connect, with the state the device reports on subscribing: a language the user picks on the
            // device afterwards stays until the next connect (a change of the voice language restarts the adapter).
            if (!this.displayLanguageChecked) {
                this.displayLanguageChecked = true;
                this.syncDisplayLanguage(entity);
            }
        }
    }

    /** Show the device's screen in the voice language, if it offers that language. */
    private syncDisplayLanguage(entity: EsphomeEntity): void {
        const language = this.opts.language;
        if (!language) {
            return;
        }
        const option = displayLanguageOption(entity.options ?? [], language);
        if (!option) {
            this.opts.log.debug(
                `ESPHome ${this.deviceName}: ${DISPLAY_LANGUAGE_ENTITY} has no option for "${language}" ` +
                    `(${(entity.options ?? []).join(', ')})`,
            );
            return;
        }
        if (entity.value === option) {
            return;
        }
        const shown = typeof entity.value === 'string' ? entity.value : '?';
        this.opts.log.info(`ESPHome ${this.deviceName}: display language ${shown} → ${option}`);
        this.setEntity(DISPLAY_LANGUAGE_ENTITY, option);
    }

    /** Whether a yes/no button press now answers a question the last reply asked. */
    private questionOpen(): boolean {
        return !!this.capture?.answersQuestion || Date.now() < this.questionUntil;
    }

    /**
     * The user pressed yes or no on the device's screen. While a reply waits for an answer that is the answer: the
     * microphone opened for it is closed, the yes or no word goes on as the user's reply (pi-agent decides its
     * confirmation on it like on a spoken one), and the reply to that is announced on this device.
     */
    private onConfirmButton(eventType: unknown): void {
        const yes = confirmAnswerOf(eventType);
        if (yes === null) {
            this.opts.log.debug(
                `ESPHome ${this.deviceName}: ${CONFIRM_ENTITY} "${String(eventType)}" — not yes/no, ignored`,
            );
            return;
        }
        if (!this.questionOpen()) {
            this.opts.log.debug(
                `ESPHome ${this.deviceName}: ${CONFIRM_ENTITY} "${yes ? 'yes' : 'no'}" without an open question — ignored`,
            );
            return;
        }
        this.questionUntil = 0;
        if (this.capture) {
            // A RUN_END while the microphone streams stops it and puts the device back to idle — without the error
            // display an empty recognition would end with.
            this.abortCapture();
            this.event(EVENT.RUN_END);
        }
        // Whatever is still in flight for the question stays silent; so does the follow-up microphone the device may
        // still open for it.
        const run = ++this.run;
        this.ignoreFollowUpUntil = Date.now() + IGNORE_FOLLOW_UP_MS;
        void this.answerButton(yes, run);
    }

    /** Pass a button answer on and announce the reply (see {@link onConfirmButton}). */
    private async answerButton(yes: boolean, run: number): Promise<void> {
        const text = yesNoWord(this.opts.language, yes);
        this.opts.log.info(`ESPHome ${this.deviceName}: answered "${text}" with the button`);
        this.status('processing');
        try {
            const answer = (
                await this.opts.answer(text, { device: this.deviceName, room: this.room, button: yes ? 'yes' : 'no' })
            ).trim();
            if (run !== this.run) {
                return;
            }
            if (!answer) {
                this.status('idle');
                return;
            }
            const followUp = this.opts.expectsFollowUp?.(answer, this.deviceName) === true;
            const ttsStart = Date.now();
            const { pcm, sampleRate } = await this.opts.tts.synthesize(answer, this.opts.language);
            if (run !== this.run) {
                return;
            }
            this.opts.onSpoken?.(this.deviceName, {
                ms: Date.now() - ttsStart,
                audioMs: (pcm.length / 2 / sampleRate) * 1000,
            });
            await this.announce(pcm, sampleRate, followUp, answer);
        } catch (e) {
            this.opts.log.warn(`ESPHome ${this.deviceName}: answer to the button failed — ${(e as Error).message}`);
            if (run === this.run) {
                this.status('idle');
            }
        }
    }

    /** Write one of the device's entities. See {@link EsphomeSatellites.setEntity}. */
    setEntity(objectId: string, value: unknown): boolean {
        const message = this.entities.command(objectId, value);
        if (!message) {
            const entity = this.entities.get(objectId);
            const known = this.entities
                .list()
                .map(e => e.objectId)
                .join(', ');
            const options = entity?.options ? ` (one of: ${entity.options.join(', ')})` : '';
            this.opts.log.warn(
                entity
                    ? `ESPHome ${this.deviceName}: ${JSON.stringify(value)} is not a value "${objectId}" accepts${options}`
                    : `ESPHome ${this.deviceName}: no entity "${objectId}" (have: ${known})`,
            );
            return false;
        }
        this.send(message);
        this.opts.log.debug(`ESPHome ${this.deviceName}: ${objectId} := ${JSON.stringify(value)}`);
        return true;
    }

    /** Push one assistant timer to the device so it can show and ring it itself. */
    sendTimerEvent(event: TimerEvent): void {
        const message = new pb.VoiceAssistantTimerEventResponse();
        message.setEventType(TIMER_EVENT[event.type]);
        message.setTimerId(event.id);
        message.setName(event.name);
        message.setTotalSeconds(Math.max(0, Math.round(event.totalSeconds)));
        message.setSecondsLeft(Math.max(0, Math.round(event.secondsLeft)));
        message.setIsActive(event.active);
        this.send(message);
    }

    // ── voice pipeline ──────────────────────────────────────────────────────────────────────────────

    private onPipelineRequest(request: VoiceAssistantRequestMsg): void {
        if (!request.getStart()) {
            this.onStopRequest();
            return;
        }
        if (this.capture) {
            this.opts.log.debug(`ESPHome ${this.deviceName}: pipeline already running — ignoring wake`);
            return;
        }
        const phrase = request.getWakeWordPhrase();
        if (!phrase && Date.now() < this.ignoreFollowUpUntil) {
            // The microphone for the question a button already answered: close it at once. In this state the device
            // takes a RUN_END as "stop the microphone" and goes back to idle.
            this.ignoreFollowUpUntil = 0;
            this.opts.log.debug(`ESPHome ${this.deviceName}: follow-up of a question answered by button — closing it`);
            this.event(EVENT.RUN_END);
            return;
        }
        if (this.runOpen) {
            // The device started over while the last request was still being answered: that answer is not
            // wanted any more, and its events would land in the middle of the new run.
            this.opts.log.debug(`ESPHome ${this.deviceName}: new wake while answering — dropping the old reply`);
        }
        this.run++;
        // Without a wake word the device re-opened the mic for the reply that asked something; with one, the user
        // started over and the question is gone.
        const answersQuestion = !phrase && Date.now() < this.questionUntil;
        if (phrase) {
            this.questionUntil = 0;
        }

        this.opts.log.debug(`ESPHome ${this.deviceName}: wake "${phrase || '(follow-up)'}"`);

        const response = new pb.VoiceAssistantResponse();
        response.setPort(0); // 0 = stream the audio over this socket
        response.setError(false);
        this.send(response);

        const timer = setTimeout(() => {
            this.opts.log.warn(`ESPHome ${this.deviceName}: no end of speech within ${PIPELINE_TIMEOUT_MS} ms`);
            void this.finishCapture('pipeline-timeout');
        }, PIPELINE_TIMEOUT_MS);
        timer.unref();
        const stallCheck = setInterval(() => this.checkStall(), STALL_CHECK_MS);
        stallCheck.unref();

        const silenceMs = this.opts.silenceMs || DEFAULT_SILENCE_MS;
        this.capture = {
            chunks: [],
            detector: new SpeechDetector({
                sampleRate: MIC_SAMPLE_RATE,
                silenceMs,
                longSilenceMs: Math.round(silenceMs * LONG_PAUSE_FACTOR),
                longAfterMs: LONG_REQUEST_MS,
                // Microphone gain differs wildly between these devices, so fixed RMS levels do not
                // travel: derive them from the room instead, once the wake chirp is out of the way.
                skipMs: WAKE_CHIRP_MS,
                adaptive: true,
                startTimeoutMs: phrase ? NO_SPEECH_MS : NO_SPEECH_FOLLOW_UP_MS,
                minStartLevel: this.speechLevel || DEFAULT_SPEECH_LEVEL,
                minEndLevel: Math.round((this.speechLevel || DEFAULT_SPEECH_LEVEL) * SILENCE_SHARE),
                minSpeechMs: MIN_SPEECH_MS,
            }),
            conversationId: request.getConversationId(),
            wakeWord: phrase || '',
            answersQuestion,
            timer,
            stallCheck,
            startedAt: Date.now(),
            lastAudioAt: 0,
            closed: false,
        };

        this.status('listening');
        this.event(EVENT.RUN_START);
        if (phrase) {
            this.event(EVENT.WAKE_WORD_END, { wake_word_phrase: phrase });
        }
        this.event(EVENT.STT_START);
        this.event(EVENT.STT_VAD_START);
    }

    /**
     * The device asks to end the conversation (`VoiceAssistantRequest{start:false}`): a button, or the wake word
     * said again while a request is running — that is how ESPHome's voice_assistant stops. While it waits for an
     * answer, the firmware leaves that state only on our RUN_END; without one it stays "in the conversation", and
     * every further wake word just sends another stop (field report 2026-11-03).
     */
    private onStopRequest(): void {
        const running = !!this.capture || this.runOpen;
        // A device with yes/no buttons may stop its microphone on the press before it reports which button it was.
        this.questionUntil = this.questionOpen() ? Date.now() + CONFIRM_GRACE_MS : 0;
        this.abortCapture();
        if (running) {
            this.run++; // whatever is still being answered stays silent
            this.opts.log.debug(`ESPHome ${this.deviceName}: the device ended the conversation`);
            this.event(EVENT.RUN_END);
            this.status('idle');
            return;
        }
        if (Date.now() - this.errorSentAt < ERROR_ECHO_MS) {
            return; // the device's own reaction to our ERROR event
        }
        // Nothing is open on our side, but the device still thinks so (it missed a RUN_END): end it there too.
        this.opts.log.debug(`ESPHome ${this.deviceName}: stop outside a conversation — ending it on the device`);
        this.event(EVENT.RUN_END);
    }

    private onAudio(audio: VoiceAssistantAudio): void {
        const capture = this.capture;
        if (!capture || capture.closed) {
            return;
        }
        const chunk = Buffer.from(audio.getData_asU8());
        if (chunk.length) {
            capture.lastAudioAt = Date.now();
            capture.chunks.push(chunk);
            const end = capture.detector.push(chunk);
            if (end) {
                void this.finishCapture(end);
                return;
            }
        }
        if (audio.getEnd()) {
            void this.finishCapture('stream');
        }
    }

    /** End a capture whose device stopped sending audio without ending the stream. */
    private checkStall(): void {
        const capture = this.capture;
        if (!capture || capture.closed) {
            return;
        }
        const now = Date.now();
        const quietMs = capture.lastAudioAt ? now - capture.lastAudioAt : now - capture.startedAt;
        if (quietMs < (capture.lastAudioAt ? STREAM_STALL_MS : STREAM_START_MS)) {
            return;
        }
        const audioMs = Math.round(capture.chunks.reduce((sum, c) => sum + c.length, 0) / 2 / (MIC_SAMPLE_RATE / 1000));
        this.opts.log.info(
            `ESPHome ${this.deviceName}: the device ${
                capture.lastAudioAt ? `stopped sending audio after ${(audioMs / 1000).toFixed(2)} s` : 'sent no audio'
            } without ending the stream — closing the utterance after ${(quietMs / 1000).toFixed(1)} s of nothing`,
        );
        void this.finishCapture('stall');
    }

    /** Hand a recording that never became a request to {@link EsphomeSatellitesOptions.onDiscarded}. */
    private discard(capture: Capture, pcm: Bytes, reason: DiscardReason, vad: VadReport): void {
        if (!this.opts.onDiscarded || !pcm.length) {
            return;
        }
        try {
            this.opts.onDiscarded({
                device: this.deviceName,
                room: this.room,
                wakeWord: capture.wakeWord,
                reason,
                pcm,
                sampleRate: MIC_SAMPLE_RATE,
                // The store writes its own level profile next to it.
                vad: { ...vad, levels: undefined },
            });
        } catch (e) {
            this.opts.log.debug(`ESPHome ${this.deviceName}: keeping the recording failed — ${(e as Error).message}`);
        }
    }

    /** Stop the mic stream and run STT → answer → TTS for what was captured. */
    private async finishCapture(end: CaptureEnd): Promise<void> {
        const capture = this.capture;
        if (!capture || capture.closed) {
            return;
        }
        capture.closed = true;
        this.capture = null;
        clearTimeout(capture.timer);
        clearInterval(capture.stallCheck);
        const run = this.run;
        /** False once the run was ended elsewhere — then nothing more may be sent for it. */
        const current = (): boolean => {
            if (run === this.run) {
                return true;
            }
            this.opts.log.debug(`ESPHome ${this.deviceName}: conversation ended meanwhile — dropping the reply`);
            return false;
        };

        // Send this first: the device streams until it sees it.
        this.event(EVENT.STT_VAD_END);

        const pcm = Buffer.concat(capture.chunks);
        const seconds = pcm.length / 2 / MIC_SAMPLE_RATE;
        const vad: VadReport = { ...capture.detector.report(), end };
        const startedAt =
            vad.speechStartMs !== undefined ? `, speech from ${(vad.speechStartMs / 1000).toFixed(2)} s` : '';
        const endedBy = vad.end === 'speech-end' ? `ended after ${vad.silenceMs} ms of silence` : `ended by ${vad.end}`;
        this.opts.log.debug(
            `ESPHome ${this.deviceName}: captured ${seconds.toFixed(2)} s ` +
                `(peak RMS ${vad.peak}, noise floor ${vad.noiseFloor}, speech/silence gate ${vad.startLevel}/${vad.endLevel}` +
                `${startedAt}, ${endedBy})`,
        );

        if (capture.answersQuestion) {
            // Spoken: that is the answer, a button press now would be a second one. Silent: the buttons still answer
            // for a moment, as the screen may still show them.
            this.questionUntil = capture.detector.sawSpeech ? 0 : Date.now() + CONFIRM_GRACE_MS;
        }

        if (!pcm.length || !capture.detector.sawSpeech) {
            const loudest = Math.round(capture.detector.analysedPeak);
            const gate = Math.round(capture.detector.startLevel);
            if (capture.detector.longestSoundMs > 0) {
                // Something crossed the gate, but too briefly for a word: a click, a knock, a cough.
                this.opts.log.debug(
                    `ESPHome ${this.deviceName}: only a short sound (${capture.detector.longestSoundMs} ms, ` +
                        `RMS ${loudest}) — too short for speech (${MIN_SPEECH_MS} ms), dropping the utterance`,
                );
            } else if (pcm.length && loudest >= gate * QUIET_VOICE_SHARE) {
                // Not an empty room: something came close to the gate. Typically a microphone that is quieter
                // than the default threshold expects (a phone) — say where to change it.
                this.opts.log.info(
                    `ESPHome ${this.deviceName}: dropped the utterance — the loudest sound (RMS ${loudest}) stayed ` +
                        `below the speech threshold ${gate}. If somebody spoke, lower "Speech threshold" for this ` +
                        `device in the ESPHome satellites table (Voice tab), e.g. to ${Math.max(
                            30,
                            Math.round((loudest * 0.6) / 10) * 10,
                        )}.`,
                );
            } else {
                this.opts.log.debug(
                    `ESPHome ${this.deviceName}: nothing but silence${
                        end === 'no-speech' ? ' (nobody started speaking)' : ''
                    } — dropping the utterance`,
                );
            }
            this.discard(capture, pcm, end === 'no-speech' ? 'no-speech' : 'silence', vad);
            this.endWithoutRequest();
            return;
        }

        this.status('processing');
        try {
            const hints = this.opts.getHints ? await this.opts.getHints() : undefined;
            if (!current()) {
                return;
            }
            const speech = prepareForStt(pcm, MIC_SAMPLE_RATE, { startMs: vad.speechStartMs, endLevel: vad.endLevel });
            vad.stt = { fromMs: speech.fromMs, toMs: speech.toMs, gain: speech.gain };
            this.opts.log.debug(
                `ESPHome ${this.deviceName}: speech recognition gets ${(speech.fromMs / 1000).toFixed(2)}–` +
                    `${(speech.toMs / 1000).toFixed(2)} s${speech.gain > 1 ? `, amplified ×${speech.gain}` : ''}`,
            );
            const sttStart = Date.now();
            const text = (
                await this.opts.stt.transcribe(speech.pcm, MIC_SAMPLE_RATE, this.opts.language, hints)
            ).trim();
            const sttMs = Date.now() - sttStart;
            if (!current()) {
                return;
            }
            if (!text) {
                // Speech was heard, so the user waits for an answer: say why none comes. Typically a word in another
                // language than the STT listens in (a German "Ja" to a Russian STT comes back empty).
                this.opts.log.info(
                    `Voice Q (${this.deviceName}): (empty) — speech recognition returned no text for ${seconds.toFixed(1)} s of audio`,
                );
                this.discard(capture, pcm, 'empty-stt', vad);
                if (capture.answersQuestion) {
                    this.questionUntil = Date.now() + CONFIRM_GRACE_MS;
                }
                // No STT_END without text — like Home Assistant, which reports this case as an error only.
                this.endWithoutRequest();
                return;
            }
            this.event(EVENT.STT_END, { text });

            this.event(EVENT.INTENT_START);
            const answer = (
                await this.opts.answer(text, {
                    device: this.deviceName,
                    room: this.room,
                    wakeWord: capture.wakeWord,
                    sttMs,
                    audioMs: Math.round(seconds * 1000),
                    // Numbers only, no audio: shows where a request was cut off without keeping recordings.
                    vad: { ...vad, levels: levelProfile(pcm, MIC_SAMPLE_RATE) },
                })
            ).trim();
            if (!current()) {
                return;
            }
            const followUp = !!answer && this.opts.expectsFollowUp?.(answer, this.deviceName) === true;
            // Always say it, "0" included: ESPHome keeps the flag of the last INTENT_END that carried it, so after
            // one question every later reply re-opened the microphone (field report 2026-11-04). Home Assistant
            // sends "0" just the same.
            const conversation = { continue_conversation: followUp ? '1' : '0' };
            this.event(EVENT.INTENT_END, conversation);

            if (!answer) {
                this.event(EVENT.RUN_END);
                this.status('idle');
                return;
            }

            const ttsStart = Date.now();
            const { pcm: ttsPcm, sampleRate } = await this.opts.tts.synthesize(answer, this.opts.language);
            if (!current()) {
                return;
            }
            this.opts.onSpoken?.(this.deviceName, {
                ms: Date.now() - ttsStart,
                audioMs: (ttsPcm.length / 2 / sampleRate) * 1000,
            });
            const url = await this.publish(ttsPcm, sampleRate);
            if (!current()) {
                return;
            }

            this.status('speaking');
            this.event(EVENT.TTS_START, { text: answer });
            this.event(EVENT.TTS_END, { url });
            // linux-voice-assistant reads the flag here (ignoring "0"), ESPHome at INTENT_END
            this.event(EVENT.RUN_END, conversation);
            this.questionUntil = followUp
                ? Date.now() + (ttsPcm.length / 2 / sampleRate) * 1000 + FOLLOW_UP_START_MS
                : 0;
            this.armPlaybackTimeout();
        } catch (e) {
            const reason = (e as Error).message;
            this.opts.log.error(`ESPHome ${this.deviceName}: voice pipeline failed — ${reason}`);
            if (run !== this.run) {
                return; // the conversation is over already — nothing to tell the device
            }
            // Without this the device stays ducked and its LED keeps spinning.
            this.event(EVENT.ERROR, { code: 'pipeline-failed', message: reason });
            this.event(EVENT.RUN_END);
            this.status('idle');
        }
    }

    /**
     * End a run that produced no request. A RUN_END right after STT_VAD_END gets lost: the firmware is still stopping
     * its microphone then, ignores RUN_END in that state, and afterwards waits for an answer that never comes — the
     * satellite stays in the conversation (field report 2026-11-03). An ERROR event puts it back to idle in any state,
     * so it goes first, with the code Home Assistant uses for this case.
     */
    private endWithoutRequest(): void {
        this.event(EVENT.ERROR, NO_TEXT_ERROR);
        this.event(EVENT.RUN_END);
        this.status('idle');
    }

    /**
     * Select which wake words listen on this device. Unknown ids are dropped and the list is trimmed
     * to what the firmware allows, because the device answers a rejected list with silence rather than
     * an error — better to send something valid and report what we changed.
     *
     * The device persists the selection and echoes it back in a `VoiceAssistantConfigurationResponse`,
     * so we ask for one instead of assuming the write took.
     */
    setWakeWords(ids: string[]): void {
        const known = this.wakeWordConfig?.available.map(w => w.id) ?? [];
        const wanted = [...new Set(ids.map(i => i.trim()).filter(Boolean))];
        const unknown = wanted.filter(i => !known.includes(i));
        if (unknown.length) {
            this.opts.log.warn(
                `ESPHome ${this.deviceName}: unknown wake word(s) ${unknown.join(', ')} — ignored. ` +
                    `Available: ${known.join(', ') || '(none reported)'}`,
            );
        }
        let valid = wanted.filter(i => known.includes(i));
        const max = this.wakeWordConfig?.max || 0;
        if (max > 0 && valid.length > max) {
            this.opts.log.warn(
                `ESPHome ${this.deviceName}: device allows ${max} active wake word(s), keeping ${valid
                    .slice(0, max)
                    .join(', ')}`,
            );
            valid = valid.slice(0, max);
        }

        const message = new pb.VoiceAssistantSetConfiguration();
        message.setActiveWakeWordsList(valid);
        this.send(message);
        this.opts.log.info(`ESPHome ${this.deviceName}: wake words set to ${valid.join(', ') || '(none)'}`);
        // Read back, so the reported state is the device's and not our guess. The device resolves a
        // custom wake word (and downloads it) while handling the SetConfiguration, so this answer
        // already tells whether that worked.
        this.requestWakeWordConfig(valid);
    }

    /**
     * Ask the device for its wake-word configuration. The request always carries the current custom
     * wake words: the firmware replaces its list of offered models with every request, so one sent
     * without them would make an uploaded wake word vanish from the device until the next offer.
     *
     * @param check ids a SetConfiguration just asked for — warned about if the answer lacks them
     */
    requestWakeWordConfig(check: string[] | null = null): void {
        const request = new pb.VoiceAssistantConfigurationRequest();
        const offers = this.opts.externalWakeWords?.() ?? [];
        request.setExternalWakeWordsList(
            offers.map(offer => {
                const w = new pb.VoiceAssistantExternalWakeWord();
                w.setId(offer.id);
                w.setWakeWord(offer.phrase);
                w.setTrainedLanguagesList(offer.languages);
                w.setModelType('micro');
                w.setModelSize(offer.size);
                w.setModelHash(offer.sha256);
                w.setUrl(this.mediaUrl(offer.path));
                return w;
            }),
        );
        // A device that never answers must not let this grow without bound.
        if (this.configChecks.length < 16) {
            this.configChecks.push(check);
        }
        this.send(request);
    }

    /** Drop a half-finished capture (device went away, or told us to stop). */
    private abortCapture(): void {
        const capture = this.capture;
        if (!capture) {
            return;
        }
        this.capture = null;
        capture.closed = true;
        clearTimeout(capture.timer);
        clearInterval(capture.stallCheck);
    }

    // ── announcements ───────────────────────────────────────────────────────────────────────────────

    /**
     * Speak a ready PCM buffer on this device (timers, alarms, `tts.text`, jingles). With
     * `startConversation` the microphone opens once the clip has played, to catch the answer to a question.
     */
    async announce(pcm: Buffer, sampleRate: number, startConversation = false, text = ''): Promise<void> {
        if (!this.online || !pcm.length) {
            return;
        }
        const request = new pb.VoiceAssistantAnnounceRequest();
        request.setMediaId(await this.publish(pcm, sampleRate));
        // What a device with a screen shows while it plays (its on_tts_start)
        request.setText(text);
        request.setPreannounceMediaId('');
        // Needs feature flag 32 (START_CONVERSATION); on a device without it the clip still plays and
        // only the microphone stays shut, so there is nothing to guard here.
        request.setStartConversation(startConversation);
        if (startConversation) {
            // A question: the microphone the device opens after it is wanted, and a button press answers it
            this.ignoreFollowUpUntil = 0;
            this.questionUntil = Date.now() + (pcm.length / 2 / sampleRate) * 1000 + FOLLOW_UP_START_MS;
        }
        this.status('speaking');
        this.send(request);
        this.armPlaybackTimeout();
    }

    /** The format replies should have on this device, from what its media player announced. */
    private replyFormat(): ReplyFormat {
        const formats = this.entities
            .list()
            .filter(e => e.kind === 'mediaPlayer')
            .flatMap(e => e.formats ?? []);
        return chooseReplyFormat(formats, !!this.opts.encodeAudio);
    }

    /**
     * Publish PCM on the media server, in the format the device plays, and build the URL it should fetch.
     *
     * The host matters: on a multi-homed ioBroker machine the device can usually only reach one of the
     * addresses, and the local end of *this* socket is by definition one it can talk to.
     */
    private async publish(pcm: Buffer, sampleRate: number): Promise<string> {
        let format = this.replyFormat();
        let encoded: { body: Buffer; contentType: string };
        try {
            encoded = await encodeReply(pcm, sampleRate, format, this.opts.encodeAudio);
        } catch (e) {
            // MP3/Opus need ffmpeg. Without it a native format is the only chance, whether the device lists it or not.
            const fallback: ReplyFormat = { ...format, codec: 'flac', source: `${format.source}, FLAC as fallback` };
            this.opts.log.warn(
                `ESPHome ${this.deviceName}: cannot write the reply as ${format.codec.toUpperCase()} ` +
                    `(${(e as Error).message}) — sending FLAC, which the device may not play. Install ffmpeg.`,
            );
            format = fallback;
            encoded = await encodeReply(pcm, sampleRate, format);
        }
        const key = `${format.codec}/${format.sampleRate}/${format.channels}`;
        if (key !== this.loggedFormat) {
            this.loggedFormat = key;
            const what = !format.source
                ? 'WAV (the device lists no formats)'
                : `${format.codec.toUpperCase()}${format.sampleRate ? ` ${format.sampleRate} Hz` : ''}` +
                  `${format.channels === 2 ? ' stereo' : ''} (device: ${format.source})`;
            this.opts.log.info(`ESPHome ${this.deviceName}: spoken replies as ${what}`);
        }
        return this.mediaUrl(this.opts.media.publish(encoded.body, encoded.contentType));
    }

    /** Absolute URL of a path on the media server, with a host this device can reach. */
    private mediaUrl(path: string): string {
        const local = (this.socket?.localAddress || '').replace(/^::ffff:/, '');
        const host = this.opts.mediaHost?.trim() || local || '127.0.0.1';
        // An IPv6 literal has to be bracketed in a URL.
        const authority = host.includes(':') ? `[${host}]` : host;
        return `http://${authority}:${this.opts.media.port}${path}`;
    }

    /** Fall back to `idle` if the device never reports that it finished playing. */
    private armPlaybackTimeout(): void {
        if (this.playbackTimer) {
            clearTimeout(this.playbackTimer);
        }
        this.playbackTimer = setTimeout(() => {
            this.playbackTimer = null;
            this.status('idle');
        }, PLAYBACK_TIMEOUT_MS);
        this.playbackTimer.unref();
    }

    private event(type: number, data?: Record<string, string>): void {
        if (type === EVENT.RUN_START) {
            this.runOpen = true;
        } else if (type === EVENT.RUN_END) {
            this.runOpen = false;
        } else if (type === EVENT.ERROR) {
            this.errorSentAt = Date.now();
        }
        const message = new pb.VoiceAssistantEventResponse();
        message.setEventType(type);
        const items: VoiceAssistantEventData[] = [];
        for (const [name, value] of Object.entries(data || {})) {
            const item = new pb.VoiceAssistantEventData();
            item.setName(name);
            item.setValue(value);
            items.push(item);
        }
        message.setDataList(items);
        this.send(message);
    }
}
