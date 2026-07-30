/**
 * Wyoming protocol endpoint (https://github.com/rhasspy/wyoming) — a TCP server that bridges Wyoming
 * events to the existing STT → answer → TTS pipeline, so a `wyoming-satellite`, Home Assistant Voice PE
 * or ESPHome voice device can stream to this adapter directly.
 *
 * Wire format: one JSON header line terminated by '\n', optionally followed by `payload_length` raw
 * bytes (audio). We handle: describe → info; audio-start/chunk/stop → STT → answer → TTS (streamed back
 * as audio-*); synthesize → TTS.
 *
 * ⚠️ Framing is unit-tested (loopback); interop with real HA Voice PE / wyoming-satellite still needs
 * on-device validation.
 */
import * as net from 'node:net';
import type { SttEngine } from './stt';
import type { TtsEngine } from './tts';
import { Buffer } from 'node:buffer';

export interface WyomingServerOptions {
    port: number;
    bindAddress?: string;
    /** ISO-639-1 language hint for STT/TTS. */
    language: string;
    stt: SttEngine;
    tts: TtsEngine;
    answer: (question: string) => Promise<string>;
    /** Optional STT vocabulary hints (device/room names) to bias recognition; re-read per utterance. */
    getHints?: () => string[] | Promise<string[]>;
    log: ioBroker.Logger;
}

interface WyEvent {
    type: string;
    data?: Record<string, unknown>;
    payload?: Buffer;
}

/** Bytes of PCM per outgoing audio-chunk. */
const AUDIO_CHUNK = 8192;

export class WyomingServer {
    private server: net.Server | null = null;
    private readonly conns = new Set<net.Socket>();

    constructor(private readonly opts: WyomingServerOptions) {}

    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = net.createServer(sock => this.onConnection(sock));
            this.server = server;
            server.once('error', reject);
            server.on('error', e => this.opts.log.error(`Wyoming server error: ${e.message}`));
            const addr =
                this.opts.bindAddress && this.opts.bindAddress !== '0.0.0.0' ? this.opts.bindAddress : undefined;
            server.listen(this.opts.port, addr, () => {
                this.opts.log.info(`Wyoming server listening on TCP ${addr || '0.0.0.0'}:${this.opts.port}`);
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        for (const s of this.conns) {
            s.destroy();
        }
        this.conns.clear();
        const server = this.server;
        this.server = null;
        if (server) {
            await new Promise<void>(res => server.close(() => res()));
        }
    }

    private onConnection(sock: net.Socket): void {
        this.conns.add(sock);
        sock.on('close', () => this.conns.delete(sock));
        sock.on('error', () => this.conns.delete(sock));
        new WyomingConnection(sock, this.opts);
    }
}

/** One client connection: frame parser + event handling. */
class WyomingConnection {
    private buf = Buffer.alloc(0);
    private draining = false;
    private audioChunks: Buffer[] = [];
    private audioRate = 16000;
    /** Per-utterance language (overridable via `transcribe`/`synthesize` `data.language`). */
    private lang: string;

    constructor(
        private readonly sock: net.Socket,
        private readonly opts: WyomingServerOptions,
    ) {
        this.lang = opts.language;
        sock.on('data', d => {
            this.buf = Buffer.concat([this.buf, d as Buffer<ArrayBuffer>]);
            void this.drain();
        });
    }

    /** Pull complete events (header line + optional payload) out of the receive buffer. */
    private async drain(): Promise<void> {
        if (this.draining) {
            return;
        }
        this.draining = true;
        try {
            for (;;) {
                const nl = this.buf.indexOf(0x0a); // '\n'
                if (nl < 0) {
                    break;
                }
                let header: { type?: string; data?: Record<string, unknown>; payload_length?: number };
                try {
                    header = JSON.parse(this.buf.subarray(0, nl).toString('utf8'));
                } catch {
                    this.buf = this.buf.subarray(nl + 1); // skip a bad line
                    continue;
                }
                const payloadLen = Number(header.payload_length || 0);
                const total = nl + 1 + payloadLen;
                if (this.buf.length < total) {
                    break; // wait for the rest of the payload
                }
                const payload = payloadLen ? Buffer.from(this.buf.subarray(nl + 1, total)) : undefined;
                this.buf = this.buf.subarray(total);
                await this.handle({ type: String(header.type || ''), data: header.data, payload });
            }
        } catch (e) {
            this.opts.log.warn(`Wyoming connection error: ${(e as Error).message}`);
        } finally {
            this.draining = false;
        }
    }

    private write(type: string, data?: Record<string, unknown>, payload?: Buffer): void {
        const header: Record<string, unknown> = { type };
        if (data !== undefined) {
            header.data = data;
        }
        if (payload) {
            header.payload_length = payload.length;
        }
        this.sock.write(`${JSON.stringify(header)}\n`);
        if (payload) {
            this.sock.write(payload);
        }
    }

    private async handle(ev: WyEvent): Promise<void> {
        switch (ev.type) {
            case 'describe':
                this.write('info', this.info());
                break;
            // ASR request / start-of-speech (VAD) — reset the buffer, optional language hint.
            case 'transcribe':
            case 'voice-started':
            case 'audio-start':
                if (ev.data?.language) {
                    this.lang =
                        typeof ev.data.language === 'object'
                            ? JSON.stringify(ev.data.language)
                            : (ev.data.language as string).toString();
                }
                if (ev.data?.rate) {
                    this.audioRate = Number(ev.data.rate) || this.audioRate;
                }
                this.audioChunks = [];
                break;
            case 'audio-chunk':
                if (ev.payload) {
                    if (!this.audioChunks.length && ev.data?.rate) {
                        this.audioRate = Number(ev.data.rate) || this.audioRate;
                    }
                    this.audioChunks.push(ev.payload);
                }
                break;
            // End-of-speech — either the explicit audio-stop or a VAD voice-stopped.
            case 'audio-stop':
            case 'voice-stopped':
                await this.onUtterance();
                break;
            case 'synthesize':
                if (ev.data?.language) {
                    this.lang =
                        typeof ev.data.language === 'object'
                            ? JSON.stringify(ev.data.language)
                            : (ev.data.language as string).toString();
                }
                await this.speak(
                    ev.data?.text
                        ? typeof ev.data?.text === 'object'
                            ? JSON.stringify(ev.data.text)
                            : (ev.data.text as string).toString()
                        : '',
                );
                break;
            case 'ping':
                this.write('pong', ev.data);
                break;
        }
    }

    private async onUtterance(): Promise<void> {
        const pcm = Buffer.concat(this.audioChunks);
        this.audioChunks = [];
        if (!pcm.length) {
            return;
        }
        try {
            const hints = this.opts.getHints ? await this.opts.getHints() : undefined;
            const text = await this.opts.stt.transcribe(pcm, this.audioRate, this.lang, hints);
            this.opts.log.info(`Wyoming Q: ${text || '(empty)'}`);
            this.write('transcript', { text });
            if (!text) {
                return;
            }
            const answer = (await this.opts.answer(text)).trim();
            this.opts.log.info(`Wyoming A: ${answer}`);
            if (answer) {
                await this.speak(answer);
            }
        } catch (e) {
            this.opts.log.error(`Wyoming pipeline failed: ${(e as Error).message}`);
            this.write('error', { text: (e as Error).message });
        }
    }

    private async speak(text: string): Promise<void> {
        if (!text) {
            return;
        }
        try {
            const { pcm, sampleRate } = await this.opts.tts.synthesize(text, this.lang);
            const meta = { rate: sampleRate, width: 2, channels: 1 };
            this.write('audio-start', meta);
            for (let off = 0; off < pcm.length; off += AUDIO_CHUNK) {
                this.write('audio-chunk', meta, pcm.subarray(off, off + AUDIO_CHUNK));
            }
            this.write('audio-stop', {});
        } catch (e) {
            this.opts.log.error(`Wyoming TTS failed: ${(e as Error).message}`);
            this.write('error', { text: (e as Error).message });
        }
    }

    /** Capabilities advertised in response to `describe`. */
    private info(): Record<string, unknown> {
        const lang = (this.opts.language || 'en').split('-')[0];
        const attribution = { name: 'ioBroker', url: 'https://github.com/ioBroker/ioBroker.assistant' };
        return {
            asr: [
                {
                    name: 'iobroker-assistant',
                    attribution,
                    installed: true,
                    description: 'ioBroker.assistant speech-to-text',
                    version: '1.0',
                    models: [
                        {
                            name: 'default',
                            attribution,
                            installed: true,
                            description: '',
                            version: '1.0',
                            languages: [lang],
                        },
                    ],
                },
            ],
            tts: [
                {
                    name: 'iobroker-assistant',
                    attribution,
                    installed: true,
                    description: 'ioBroker.assistant text-to-speech',
                    version: '1.0',
                    voices: [
                        {
                            name: 'default',
                            attribution,
                            installed: true,
                            description: '',
                            version: '1.0',
                            languages: [lang],
                        },
                    ],
                },
            ],
            handle: [
                {
                    name: 'iobroker-assistant',
                    attribution,
                    installed: true,
                    description: 'ioBroker.assistant intent handling',
                    version: '1.0',
                    models: [
                        {
                            name: 'default',
                            attribution,
                            installed: true,
                            description: '',
                            version: '1.0',
                            languages: [lang],
                        },
                    ],
                },
            ],
        };
    }
}
