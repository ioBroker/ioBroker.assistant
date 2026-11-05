/**
 * Tiny HTTP server that hands out short-lived audio clips.
 *
 * ESPHome voice satellites do not receive the spoken reply over their API socket: the server puts a
 * **URL** into the `tts-end` event (and into `VoiceAssistantAnnounceRequest.media_id`), and the device
 * fetches and plays it with mpv. So the adapter has to be an HTTP origin for as long as a clip is
 * needed — that is all this is.
 *
 * Clips live in memory, are addressed by an unguessable token and expire on their own, so nothing is
 * written to disk and a clip cannot be replayed indefinitely by anyone who once saw the URL.
 *
 * Besides the clips it serves a few **fixed files** under a path the caller picks — the custom wake-word
 * models, which a device may fetch at any time after it was offered one. Only paths registered with
 * {@link MediaServer.serve} answer, so nothing beyond what was put there is reachable.
 *
 * And **live streams** ({@link MediaServer.serveStream}): music from a URL the device cannot decode itself, which
 * ffmpeg turns into a codec it can while the device listens.
 */
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';

interface Clip {
    body: Buffer;
    contentType: string;
    expiresAt: number;
}

/**
 * Starts the source of a live stream for one listener and writes it into `res` (ffmpeg's stdout piped in). Returns
 * what stops it; that runs when the listener goes away or the stream is removed.
 */
export type StreamSource = (res: http.ServerResponse) => () => void;

interface LiveStream {
    contentType: string;
    open: StreamSource;
    /** One per listener currently connected: ends that listener's source and connection. */
    listeners: Set<() => void>;
}

export interface MediaServerOptions {
    port: number;
    /** Interface to bind ('0.0.0.0'/'' = all). */
    bindAddress?: string;
    log: ioBroker.Logger;
}

/** How long a published clip stays fetchable. Generous: a device may buffer before it starts playing. */
const DEFAULT_TTL_MS = 120_000;
/** Safety net against a leak if a device never fetches what we published. */
const MAX_CLIPS = 64;

export class MediaServer {
    private server: http.Server | null = null;
    private readonly clips = new Map<string, Clip>();
    /** Fixed files by exact path (`/wakeword/<id>.tflite`), served until removed. */
    private readonly files = new Map<string, { body: Buffer; contentType: string }>();
    /** Live streams by exact path (`/stream/<token>.flac`), served until removed. */
    private readonly streams = new Map<string, LiveStream>();
    private sweepTimer: NodeJS.Timeout | null = null;
    /** Port the OS actually handed out — differs from the configured one when that is 0. */
    private boundPort = 0;

    constructor(private readonly opts: MediaServerOptions) {}

    /** Port the server listens on. Only meaningful after `start()` when port 0 was configured. */
    get port(): number {
        return this.boundPort || this.opts.port;
    }

    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => this.onRequest(req, res));
            this.server = server;
            server.once('error', reject);
            server.on('error', e => this.opts.log.error(`media server error: ${e.message}`));
            const address =
                this.opts.bindAddress && this.opts.bindAddress !== '0.0.0.0' ? this.opts.bindAddress : undefined;
            const onListening = (): void => {
                const bound = server.address();
                this.boundPort = typeof bound === 'object' && bound ? bound.port : this.opts.port;
                this.opts.log.info(`Media server listening on http://${address || '0.0.0.0'}:${this.port}`);
                this.sweepTimer = setInterval(() => this.sweep(), 30_000);
                this.sweepTimer.unref();
                resolve();
            };
            if (address) {
                server.listen(this.opts.port, address, onListening);
            } else {
                server.listen(this.opts.port, onListening);
            }
        });
    }

    async stop(): Promise<void> {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
        this.clips.clear();
        for (const path of [...this.streams.keys()]) {
            this.unserve(path);
        }
        const server = this.server;
        this.server = null;
        if (server) {
            server.closeAllConnections?.();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    }

    /**
     * Publish a clip and return the path it is served under (e.g. `/media/ab12….wav`). The caller
     * prefixes the host it wants the device to call back on — which interface that is depends on the
     * device, so only the caller can know it.
     */
    publish(body: Buffer, contentType = 'audio/wav', ttlMs = DEFAULT_TTL_MS): string {
        if (this.clips.size >= MAX_CLIPS) {
            this.sweep();
            // Still full? Drop the oldest — insertion order is age order.
            const oldest = this.clips.keys().next();
            if (this.clips.size >= MAX_CLIPS && !oldest.done) {
                this.clips.delete(oldest.value);
            }
        }
        // A device without a usable Content-Type check goes by the extension (ESPHome `detect_audio_file_type`).
        const extension = contentType.startsWith('audio/mpeg')
            ? 'mp3'
            : contentType.startsWith('audio/flac')
              ? 'flac'
              : contentType.startsWith('audio/ogg')
                ? 'opus'
                : 'wav';
        const token = `${randomBytes(12).toString('hex')}.${extension}`;
        this.clips.set(token, { body, contentType, expiresAt: Date.now() + ttlMs });
        return `/media/${token}`;
    }

    /**
     * Serve `body` at exactly `urlPath` (e.g. `/wakeword/hey_hannah_1a2b3c4d.tflite`) until
     * {@link unserve} removes it. Replaces whatever was there.
     */
    serve(urlPath: string, body: Buffer, contentType: string): void {
        this.files.set(urlPath, { body, contentType });
    }

    /**
     * Serve a live stream at exactly `urlPath`: every GET starts its own source with `open`, which runs until the
     * listener disconnects or {@link unserve} removes the path. Replaces (and ends) whatever was there.
     */
    serveStream(urlPath: string, contentType: string, open: StreamSource): void {
        this.unserve(urlPath);
        this.streams.set(urlPath, { contentType, open, listeners: new Set() });
    }

    /** Remove a fixed file or a live stream; a stream's listeners are cut off. */
    unserve(urlPath: string): void {
        this.files.delete(urlPath);
        const stream = this.streams.get(urlPath);
        if (stream) {
            this.streams.delete(urlPath);
            for (const end of [...stream.listeners]) {
                end();
            }
        }
    }

    /** Number of listeners connected to live streams (for tests and the log). */
    get streamListeners(): number {
        let n = 0;
        for (const stream of this.streams.values()) {
            n += stream.listeners.size;
        }
        return n;
    }

    private onStream(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string, stream: LiveStream): void {
        res.writeHead(200, {
            'Content-Type': stream.contentType,
            'Cache-Control': 'no-store',
            'Accept-Ranges': 'none',
        });
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        // Node sends the headers with the first data, and ffmpeg needs a moment to look at the source before it
        // writes anything — the device's HTTP client should not sit there without even an answer meanwhile.
        res.flushHeaders();
        this.opts.log.debug(`media: ${req.method} ${urlPath} → live stream`);
        let stopSource: (() => void) | null = null;
        const end = (): void => {
            if (!stream.listeners.delete(end)) {
                return; // already ended
            }
            stopSource?.();
            res.destroy();
        };
        stream.listeners.add(end);
        res.on('close', end);
        try {
            stopSource = stream.open(res);
        } catch (e) {
            this.opts.log.warn(`media: stream ${urlPath} did not start: ${(e as Error).message}`);
            end();
        }
    }

    private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const urlPath = (req.url || '').split('?')[0];
        const stream = this.streams.get(urlPath);
        if (stream) {
            this.onStream(req, res, urlPath, stream);
            return;
        }
        const file = this.files.get(urlPath);
        if (file) {
            this.opts.log.debug(`media: ${req.method} ${urlPath} → ${file.body.length} bytes`);
            res.writeHead(200, {
                'Content-Type': file.contentType,
                'Content-Length': file.body.length,
                'Cache-Control': 'no-cache',
            });
            res.end(req.method === 'HEAD' ? undefined : file.body);
            return;
        }

        const token = /^\/media\/([\w.]+)$/.exec(urlPath)?.[1];
        const clip = token ? this.clips.get(token) : undefined;

        if (!clip || clip.expiresAt < Date.now()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found');
            return;
        }
        this.opts.log.debug(`media: ${req.method} ${req.url} → ${clip.body.length} bytes`);
        res.writeHead(200, {
            'Content-Type': clip.contentType,
            'Content-Length': clip.body.length,
            'Cache-Control': 'no-store',
            // mpv asks for ranges on some builds; saying so up front avoids a needless second request.
            'Accept-Ranges': 'none',
        });
        res.end(req.method === 'HEAD' ? undefined : clip.body);
    }

    private sweep(): void {
        const now = Date.now();
        for (const [token, clip] of this.clips) {
            if (clip.expiresAt < now) {
                this.clips.delete(token);
            }
        }
    }
}
