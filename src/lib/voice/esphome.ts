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
import { SpeechDetector, type Bytes } from './vad';
import { pcmToWav } from './stt';
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
 * four captures, with no change to when the utterance closes. The audio itself is untouched and still
 * goes to STT in full, so a speaker who starts inside this window loses nothing but a late gate open.
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

export interface EsphomeDevice {
    /** Host name or IP of the satellite. */
    ip: string;
    /** API port; empty/0 → 6053. */
    port?: number;
    /** API password, if one is configured on the device. */
    password?: string;
    /** Room this satellite belongs to (drives `satellites.<room>.*` and the answer context). */
    room?: string;
}

export interface EsphomeSatellitesOptions {
    devices: EsphomeDevice[];
    /** ISO-639-1 language hint for STT/TTS ('' = auto/provider default). */
    language: string;
    stt: SttEngine;
    tts: TtsEngine;
    /** Produce the assistant reply for a transcribed utterance. */
    answer: (question: string, ctx: { device: string; room: string }) => Promise<string>;
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
    /** Notified on every satellite state transition (idle/listening/processing/speaking/offline). */
    onStatus?: (device: string, room: string, state: SatelliteState | 'offline') => void;
    /** Notified with the device's wake-word configuration, on connect and after every change. */
    onWakeWords?: (device: string, room: string, config: WakeWordConfig) => void;
    /** Notified once per connect with everything the device exposes besides the voice pipeline. */
    onEntities?: (device: string, room: string, entities: EsphomeEntity[]) => void;
    /** Notified whenever one of those entities changes (and once per entity right after connecting). */
    onEntityState?: (device: string, room: string, entity: EsphomeEntity) => void;
    /** True when the reply asks something back, so the device should re-open its mic without a wake word. */
    expectsFollowUp?: (answer: string) => boolean;
}

/** What a device reports about its wake words. Which ones exist is fixed by the firmware. */
export interface WakeWordConfig {
    /** Ids currently listening, e.g. `['okay_nabu']`. */
    active: string[];
    /** Everything the firmware ships, with the spoken phrase and the languages it was trained on. */
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
    timer: NodeJS.Timeout;
    closed: boolean;
}

/** One satellite: socket lifecycle, handshake, and the voice pipeline. */
class EsphomeConnection {
    /** Device name as reported by the device; falls back to its address until the handshake answers. */
    deviceName: string;
    online = false;
    /** Last wake-word configuration the device reported; null until the handshake answers. */
    wakeWordConfig: WakeWordConfig | null = null;
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

    constructor(
        device: EsphomeDevice,
        private readonly opts: EsphomeSatellitesOptions,
    ) {
        this.host = device.ip.trim();
        this.port = device.port || DEFAULT_PORT;
        this.room = (device.room || '').trim();
        this.password = device.password || '';
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
            this.opts.onStatus?.(this.deviceName, this.room, 'offline');
        }
    }

    private status(state: SatelliteState): void {
        this.opts.onStatus?.(this.deviceName, this.room, state);
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

        this.send(new pb.VoiceAssistantConfigurationRequest());

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
                this.online = true;
                this.opts.log.info(
                    `ESPHome satellite online: ${this.deviceName} (${info.getModel()}) @ ${this.host}${this.room ? `, room ${this.room}` : ''}`,
                );
                this.status('idle');
                return;
            }

            case 'VoiceAssistantConfigurationResponse': {
                const config = message as VoiceAssistantConfigurationResponse;
                this.wakeWordConfig = {
                    active: config.getActiveWakeWordsList(),
                    available: config.getAvailableWakeWordsList().map(w => ({
                        id: w.getId(),
                        phrase: w.getWakeWord(),
                        languages: w.getTrainedLanguagesList(),
                    })),
                    max: config.getMaxActiveWakeWords(),
                };
                const active = this.wakeWordConfig.active.join(', ') || '(none active)';
                const available = this.wakeWordConfig.available.map(w => w.id);
                this.opts.log.info(
                    `ESPHome ${this.deviceName}: wake words ${active}${available.length ? ` (available: ${available.join(', ')})` : ''}`,
                );
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
                    this.entities.addFromAnnouncement(name, message);
                } else if (isEntityStateMessage(name)) {
                    const entity = this.entities.applyState(name, message);
                    if (entity) {
                        this.opts.onEntityState?.(this.deviceName, this.room, entity);
                    }
                }
                return;
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
            this.abortCapture();
            return;
        }
        if (this.capture) {
            this.opts.log.debug(`ESPHome ${this.deviceName}: pipeline already running — ignoring wake`);
            return;
        }

        const phrase = request.getWakeWordPhrase();
        this.opts.log.debug(`ESPHome ${this.deviceName}: wake "${phrase || '(follow-up)'}"`);

        const response = new pb.VoiceAssistantResponse();
        response.setPort(0); // 0 = stream the audio over this socket
        response.setError(false);
        this.send(response);

        const timer = setTimeout(() => {
            this.opts.log.warn(`ESPHome ${this.deviceName}: no end of speech within ${PIPELINE_TIMEOUT_MS} ms`);
            void this.finishCapture();
        }, PIPELINE_TIMEOUT_MS);
        timer.unref();

        this.capture = {
            chunks: [],
            detector: new SpeechDetector({
                sampleRate: MIC_SAMPLE_RATE,
                silenceMs: this.opts.silenceMs || undefined,
                // Microphone gain differs wildly between these devices, so fixed RMS levels do not
                // travel: derive them from the room instead, once the wake chirp is out of the way.
                skipMs: WAKE_CHIRP_MS,
                adaptive: true,
            }),
            conversationId: request.getConversationId(),
            timer,
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

    private onAudio(audio: VoiceAssistantAudio): void {
        const capture = this.capture;
        if (!capture || capture.closed) {
            return;
        }
        const chunk = Buffer.from(audio.getData_asU8());
        if (chunk.length) {
            capture.chunks.push(chunk);
            if (capture.detector.push(chunk)) {
                void this.finishCapture();
                return;
            }
        }
        if (audio.getEnd()) {
            void this.finishCapture();
        }
    }

    /** Stop the mic stream and run STT → answer → TTS for what was captured. */
    private async finishCapture(): Promise<void> {
        const capture = this.capture;
        if (!capture || capture.closed) {
            return;
        }
        capture.closed = true;
        this.capture = null;
        clearTimeout(capture.timer);

        // Send this first: the device streams until it sees it.
        this.event(EVENT.STT_VAD_END);

        const pcm = Buffer.concat(capture.chunks);
        const seconds = pcm.length / 2 / MIC_SAMPLE_RATE;
        this.opts.log.debug(
            `ESPHome ${this.deviceName}: captured ${seconds.toFixed(2)} s ` +
                `(peak RMS ${Math.round(capture.detector.peak)}, noise floor ${Math.round(capture.detector.noiseFloor)}, ` +
                `speech/silence gate ${Math.round(capture.detector.startLevel)}/${Math.round(capture.detector.endLevel)})`,
        );

        if (!pcm.length || !capture.detector.sawSpeech) {
            this.opts.log.debug(`ESPHome ${this.deviceName}: nothing but silence — dropping the utterance`);
            this.event(EVENT.RUN_END);
            this.status('idle');
            return;
        }

        this.status('processing');
        try {
            const hints = this.opts.getHints ? await this.opts.getHints() : undefined;
            const text = (await this.opts.stt.transcribe(pcm, MIC_SAMPLE_RATE, this.opts.language, hints)).trim();
            this.event(EVENT.STT_END, { text });
            if (!text) {
                this.event(EVENT.RUN_END);
                this.status('idle');
                return;
            }

            this.event(EVENT.INTENT_START);
            const answer = (await this.opts.answer(text, { device: this.deviceName, room: this.room })).trim();
            const followUp = !!answer && this.opts.expectsFollowUp?.(answer) === true;
            this.event(EVENT.INTENT_END, followUp ? { continue_conversation: '1' } : undefined);

            if (!answer) {
                this.event(EVENT.RUN_END);
                this.status('idle');
                return;
            }

            const { pcm: ttsPcm, sampleRate } = await this.opts.tts.synthesize(answer, this.opts.language);
            const url = this.publish(ttsPcm, sampleRate);

            this.status('speaking');
            this.event(EVENT.TTS_START, { text: answer });
            this.event(EVENT.TTS_END, { url });
            this.event(EVENT.RUN_END, followUp ? { continue_conversation: '1' } : undefined);
            this.armPlaybackTimeout();
        } catch (e) {
            const reason = (e as Error).message;
            this.opts.log.error(`ESPHome ${this.deviceName}: voice pipeline failed — ${reason}`);
            // Without this the device stays ducked and its LED keeps spinning.
            this.event(EVENT.ERROR, { code: 'pipeline-failed', message: reason });
            this.event(EVENT.RUN_END);
            this.status('idle');
        }
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
        // Read back, so the reported state is the device's and not our guess.
        this.send(new pb.VoiceAssistantConfigurationRequest());
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
    }

    // ── announcements ───────────────────────────────────────────────────────────────────────────────

    /**
     * Speak a ready PCM buffer on this device (timers, alarms, `tts.text`, jingles). With
     * `startConversation` the microphone opens once the clip has played, to catch the answer to a question.
     */
    announce(pcm: Buffer, sampleRate: number, startConversation = false): Promise<void> {
        if (!this.online || !pcm.length) {
            return Promise.resolve();
        }
        const request = new pb.VoiceAssistantAnnounceRequest();
        request.setMediaId(this.publish(pcm, sampleRate));
        request.setText('');
        request.setPreannounceMediaId('');
        // Needs feature flag 32 (START_CONVERSATION); on a device without it the clip still plays and
        // only the microphone stays shut, so there is nothing to guard here.
        request.setStartConversation(startConversation);
        this.status('speaking');
        this.send(request);
        this.armPlaybackTimeout();
        return Promise.resolve();
    }

    /**
     * Publish PCM as a WAV on the media server and build the URL the device should fetch.
     *
     * The host matters: on a multi-homed ioBroker machine the device can usually only reach one of the
     * addresses, and the local end of *this* socket is by definition one it can talk to.
     */
    private publish(pcm: Buffer, sampleRate: number): string {
        const path = this.opts.media.publish(pcmToWav(pcm, sampleRate), 'audio/wav');
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
