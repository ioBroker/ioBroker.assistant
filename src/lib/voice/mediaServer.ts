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
 */
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';

interface Clip {
    body: Buffer;
    contentType: string;
    expiresAt: number;
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
        const extension = contentType === 'audio/mpeg' ? 'mp3' : 'wav';
        const token = `${randomBytes(12).toString('hex')}.${extension}`;
        this.clips.set(token, { body, contentType, expiresAt: Date.now() + ttlMs });
        return `/media/${token}`;
    }

    private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const token = /^\/media\/([\w.]+)$/.exec((req.url || '').split('?')[0])?.[1];
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
