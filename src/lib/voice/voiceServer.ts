/**
 * UDP voice server — the "brain" side of the satellite protocol.
 *
 * Receives streamed microphone audio from satellites, runs STT → answer callback → TTS,
 * and streams the spoken reply back. Registration + heartbeat keep the satellite registry
 * live. Protocol is Hannah-compatible (see `protocol.ts`).
 */
import * as dgram from 'node:dgram';
import {
    AUDIO_SAMPLE_RATE,
    TYPE_AUDIO,
    TYPE_CONTROL,
    decodePacket,
    encodeControl,
    encodeTts,
    type SatToServer,
    type SatelliteState,
} from './protocol';
import type { SttEngine } from './stt';
import type { TtsEngine } from './tts';

interface Satellite {
    device: string;
    room: string;
    address: string;
    port: number;
    lastSeen: number;
    /** Buffered audio chunks of the utterance currently being spoken. */
    chunks: Buffer[];
    /** Puts the satellite back to `idle` once a mic-on window passed unanswered. */
    listenTimer?: NodeJS.Timeout;
}

export interface VoiceServerOptions {
    port: number;
    /** Interface to bind to ('0.0.0.0'/'' = all interfaces, or a specific IP). */
    bindAddress?: string;
    /** ISO-639-1 language hint for STT/TTS ('' = auto/provider default). */
    language: string;
    stt: SttEngine;
    tts: TtsEngine;
    /** Produce the assistant reply for a transcribed utterance. */
    answer: (question: string, ctx: { device: string; room: string; sttMs: number }) => Promise<string>;
    /** Optional STT vocabulary hints (device/room names) to bias recognition; re-read per utterance. */
    getHints?: () => string[] | Promise<string[]>;
    log: ioBroker.Logger;
    /** Notified on every satellite state transition (idle/listening/processing/speaking/offline). */
    onStatus?: (device: string, room: string, state: SatelliteState | 'offline') => void;
    /** True when the reply asks something back, so the satellite should re-open its mic without a wake word. */
    expectsFollowUp?: (answer: string, device: string) => boolean;
    /** The playback volume (0–100) a satellite reported, after a `volume` command or a local change. */
    onVolume?: (device: string, room: string, level: number) => void;
}

/** Payload bytes per TTS datagram — well under the typical MTU-fragmentation-free UDP size. */
const TTS_CHUNK_BYTES = 8192;
/** Drop a satellite after this long without any packet (3× the satellite's 10 s heartbeat). */
const STALE_MS = 30_000;
/**
 * How long a satellite stays `listening` after a mic-on once its playback is over. A little longer than the
 * satellite's own follow-up window (6 s by default), which we cannot see from here.
 */
const LISTEN_WINDOW_MS = 10_000;

export class VoiceServer {
    private sock: dgram.Socket | null = null;
    /** Keyed by `${address}:${port}` — audio packets carry no device name, only their source. */
    private readonly sats = new Map<string, Satellite>();
    private sweepTimer: NodeJS.Timeout | null = null;

    constructor(private readonly opts: VoiceServerOptions) {}

    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            const sock = dgram.createSocket('udp4');
            this.sock = sock;
            sock.on('message', (data, rinfo) => this.onMessage(data, rinfo));
            sock.on('error', e => this.opts.log.error(`voice UDP error: ${e.message}`));
            sock.once('error', reject);
            // '0.0.0.0'/'' → bind all interfaces (omit the address); otherwise bind the given IP.
            const addr =
                this.opts.bindAddress && this.opts.bindAddress !== '0.0.0.0' ? this.opts.bindAddress : undefined;
            const onBound = (): void => {
                this.opts.log.info(`Voice server listening on UDP ${addr || '0.0.0.0'}:${this.opts.port}`);
                this.sweepTimer = setInterval(() => this.sweepStale(), 15_000);
                resolve();
            };
            if (addr) {
                sock.bind(this.opts.port, addr, onBound);
            } else {
                sock.bind(this.opts.port, onBound);
            }
        });
    }

    async stop(): Promise<void> {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
        const sock = this.sock;
        this.sock = null;
        this.sats.forEach(sat => this.clearListenTimer(sat));
        this.sats.clear();
        if (sock) {
            await new Promise<void>(res => sock.close(() => res()));
        }
    }

    private static addrKey(address: string, port: number): string {
        return `${address}:${port}`;
    }

    private onMessage(data: Buffer, rinfo: dgram.RemoteInfo): void {
        if (!data.length) {
            return;
        }
        const { type, payload } = decodePacket(data);
        if (type === TYPE_AUDIO) {
            const sat = this.sats.get(VoiceServer.addrKey(rinfo.address, rinfo.port));
            if (sat) {
                sat.lastSeen = Date.now();
                // The user answered within the mic-on window — don't let the timer flip the LED to idle.
                this.clearListenTimer(sat);
                sat.chunks.push(Buffer.from(payload)); // copy: payload is a view onto a reused recv buffer
            }
            return;
        }
        if (type === TYPE_CONTROL) {
            let msg: SatToServer;
            try {
                msg = JSON.parse(payload.toString('utf8')) as SatToServer;
            } catch {
                return;
            }
            this.onControl(msg, rinfo).catch(e => this.opts.log.warn(`voice control error: ${(e as Error).message}`));
        }
    }

    private async onControl(msg: SatToServer, rinfo: dgram.RemoteInfo): Promise<void> {
        const key = VoiceServer.addrKey(rinfo.address, rinfo.port);

        if (msg.type === 'register') {
            const sat: Satellite = {
                device: msg.device || key,
                room: msg.room || '',
                address: rinfo.address,
                port: rinfo.port,
                lastSeen: Date.now(),
                chunks: [],
            };
            const previous = this.sats.get(key);
            if (previous) {
                this.clearListenTimer(previous);
            }
            this.sats.set(key, sat);
            void this.send(encodeControl({ type: 'registered', ok: true }), sat);
            this.opts.log.info(`Satellite registered: ${sat.device} (room: ${sat.room || '-'}) @ ${key}`);
            this.setStatus(sat, 'idle');
            return;
        }

        const sat = this.sats.get(key);
        if (!sat) {
            // Unknown source (server restarted?) — tell the satellite to register again.
            this.sock?.send(encodeControl({ type: 'reregister' }), rinfo.port, rinfo.address);
            return;
        }
        sat.lastSeen = Date.now();

        if (msg.type === 'heartbeat') {
            void this.send(encodeControl({ type: 'heartbeat_ack' }), sat);
            return;
        }
        if (msg.type === 'audio_end') {
            await this.handleUtterance(sat);
            return;
        }
        if (msg.type === 'volume') {
            const level = Math.round(Number(msg.level));
            if (Number.isFinite(level)) {
                this.opts.onVolume?.(sat.device, sat.room, Math.min(100, Math.max(0, level)));
            }
        }
    }

    /** STT → answer → TTS for one completed utterance, with status transitions along the way. */
    private async handleUtterance(sat: Satellite): Promise<void> {
        const pcm = Buffer.concat(sat.chunks);
        sat.chunks = [];
        if (!pcm.length) {
            this.setStatus(sat, 'idle');
            return;
        }

        this.setStatus(sat, 'processing');
        let listen = false;
        let playMs = 0;
        try {
            const hints = this.opts.getHints ? await this.opts.getHints() : undefined;
            const sttStart = Date.now();
            const text = await this.opts.stt.transcribe(pcm, AUDIO_SAMPLE_RATE, this.opts.language, hints);
            const sttMs = Date.now() - sttStart;
            this.opts.log.info(`Voice Q (${sat.device}): ${text || '(empty)'}`);
            if (!text) {
                this.setStatus(sat, 'idle');
                return;
            }

            const answer = (await this.opts.answer(text, { device: sat.device, room: sat.room, sttMs })).trim();
            this.opts.log.info(`Voice A (${sat.device}): ${answer}`);
            if (!answer) {
                this.setStatus(sat, 'idle');
                return;
            }

            this.setStatus(sat, 'speaking');
            const { pcm: ttsPcm, sampleRate } = await this.opts.tts.synthesize(answer, this.opts.language);
            listen = this.opts.expectsFollowUp?.(answer, sat.device) === true;
            await this.streamTts(sat, ttsPcm, sampleRate, listen);
            playMs = (ttsPcm.length / 2 / sampleRate) * 1000;
        } catch (e) {
            this.opts.log.error(`Voice pipeline failed (${sat.device}): ${(e as Error).message}`);
            listen = false;
        } finally {
            if (listen) {
                this.markListening(sat, playMs);
            } else {
                this.setStatus(sat, 'idle');
            }
        }
    }

    /**
     * Stream one reply. `listen` travels inside `tts_end` rather than as a message of its own: the satellite
     * then knows before playback starts that it has to open the mic afterwards, and nothing can overtake it.
     */
    private async streamTts(sat: Satellite, pcm: Buffer, sampleRate: number, listen = false): Promise<void> {
        for (let off = 0, i = 0; off < pcm.length; off += TTS_CHUNK_BYTES, i++) {
            await this.send(encodeTts(pcm.subarray(off, off + TTS_CHUNK_BYTES)), sat);
            // Yield every 16 packets so a long reply doesn't burst the OS send buffer / the satellite's recv.
            if ((i & 15) === 15) {
                await new Promise<void>(res => setImmediate(res));
            }
        }
        await this.send(
            encodeControl(
                listen
                    ? { type: 'tts_end', sample_rate: sampleRate, listen }
                    : { type: 'tts_end', sample_rate: sampleRate },
            ),
            sat,
        );
    }

    /**
     * Play arbitrary PCM on one satellite (by device name) or all registered satellites (device=null).
     * Used for announcements (`tts.text` / per-satellite `tts`), independent of the wake-word flow.
     */
    async announce(device: string | null, pcm: Buffer, sampleRate: number): Promise<void> {
        if (!pcm.length) {
            return;
        }
        const targets = [...this.sats.values()].filter(s => !device || s.device === device);
        if (!targets.length) {
            this.opts.log.warn(`announce: no ${device ? `satellite '${device}'` : 'satellites'} registered`);
            return;
        }
        await Promise.all(
            targets.map(async sat => {
                this.setStatus(sat, 'speaking');
                try {
                    await this.streamTts(sat, pcm, sampleRate);
                } finally {
                    this.setStatus(sat, 'idle');
                }
            }),
        );
    }

    /**
     * Re-open the microphone on one satellite (by device name) or all of them, so the user can answer a
     * question the assistant just asked without saying the wake word again. Returns how many satellites
     * were told to listen — whether they can is up to their firmware (the message is additive).
     */
    listen(device: string | null, playMs = 0): number {
        const targets = [...this.sats.values()].filter(s => !device || s.device === device);
        for (const sat of targets) {
            void this.send(encodeControl({ type: 'listen' }), sat);
            this.markListening(sat, playMs);
        }
        return targets.length;
    }

    /**
     * Change the playback volume of one satellite: absolute (`level`, 0–100) or relative (`delta`). The
     * satellite answers with the level it ended up at (→ `onVolume`); one built before this message
     * existed ignores it. Returns false when the device is not registered.
     */
    volume(device: string, change: { level?: number; delta?: number }): boolean {
        const sat = [...this.sats.values()].find(s => s.device === device);
        if (!sat) {
            return false;
        }
        const msg =
            change.level !== undefined
                ? { type: 'volume' as const, level: Math.min(100, Math.max(0, Math.round(change.level))) }
                : { type: 'volume' as const, delta: Math.round(change.delta || 0) };
        void this.send(encodeControl(msg), sat);
        return true;
    }

    /** Whether a satellite with this device name is registered. */
    has(device: string): boolean {
        return [...this.sats.values()].some(s => s.device === device);
    }

    /** Show `listening` while the satellite waits for an answer, and fall back to `idle` if none comes. */
    private markListening(sat: Satellite, playMs: number): void {
        this.setStatus(sat, 'listening');
        sat.listenTimer = setTimeout(() => {
            sat.listenTimer = undefined;
            this.setStatus(sat, 'idle');
        }, playMs + LISTEN_WINDOW_MS);
    }

    private clearListenTimer(sat: Satellite): void {
        if (sat.listenTimer) {
            clearTimeout(sat.listenTimer);
            sat.listenTimer = undefined;
        }
    }

    /** Device names of the currently registered satellites. */
    devices(): string[] {
        return [...this.sats.values()].map(s => s.device);
    }

    private setStatus(sat: Satellite, state: SatelliteState): void {
        this.clearListenTimer(sat);
        void this.send(encodeControl({ type: 'status', state }), sat);
        this.opts.onStatus?.(sat.device, sat.room, state);
    }

    private send(data: Buffer, sat: Satellite): Promise<void> {
        return new Promise((resolve, reject) => {
            const sock = this.sock;
            if (!sock) {
                resolve();
                return;
            }
            sock.send(data, sat.port, sat.address, err => (err ? reject(err) : resolve()));
        });
    }

    private sweepStale(): void {
        const now = Date.now();
        for (const [key, sat] of this.sats) {
            if (now - sat.lastSeen > STALE_MS) {
                this.clearListenTimer(sat);
                this.sats.delete(key);
                this.opts.log.info(`Satellite offline (timeout): ${sat.device}`);
                this.opts.onStatus?.(sat.device, sat.room, 'offline');
            }
        }
    }
}
