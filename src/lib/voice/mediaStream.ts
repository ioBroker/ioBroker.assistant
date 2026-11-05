/**
 * Music from a URL on an ESPHome satellite's media player: internet radio, a file on a web server.
 *
 * The device plays a URL itself (`MediaPlayerCommandRequest.media_url` with `announcement = false`: the media
 * pipeline, so replies and announcements only duck it, and play/pause/stop/volume apply to it). It decodes only
 * the codecs its firmware was built with, though: since ESPHome 2026.10 the media player gets the decoders of the
 * formats its pipelines announce (`supported_formats`), all of MP3/FLAC/WAV only with format `NONE` or on older
 * firmware that announces nothing. Many stations send AAC or HLS (`.m3u8`), and radio directories hand out
 * playlists (`.pls`, `.m3u`) that no device plays.
 *
 * So before a URL goes to the device, {@link planStream} looks at what it really is: one request for the headers
 * (and the body of a playlist), the first stream of a playlist instead of the playlist, then the codec — from the
 * Content-Type, else the extension. A codec the device decodes is played directly; anything else runs through
 * ffmpeg and is served by our media server in a codec the device takes, FLAC first (what Home Assistant does).
 */
import type { MediaFormat } from './replyFormat';

/** What a URL turned out to be. */
export type StreamKind = 'mp3' | 'flac' | 'wav' | 'opus' | 'hls' | 'playlist' | 'other' | 'unknown';

/** Codecs an ESPHome media player can decode (`audio_decoder`). */
export type DeviceCodec = 'mp3' | 'flac' | 'wav' | 'opus';

const DEVICE_CODECS: DeviceCodec[] = ['flac', 'mp3', 'opus', 'wav'];

/** What every ESPHome speaker media player decoded before the codecs followed the pipelines. */
const CLASSIC_CODECS: DeviceCodec[] = ['mp3', 'flac', 'wav'];

/** Bytes of a playlist we read; a real one is a few hundred. */
const MAX_PLAYLIST_BYTES = 64 * 1024;

/** Playlists pointing at playlists: how deep we follow. */
const MAX_DEPTH = 3;

/**
 * The kind of stream a Content-Type announces; 'unknown' when it says nothing useful (missing,
 * `application/octet-stream`, `text/html` of a server that does not care).
 */
export function kindFromContentType(contentType: string): StreamKind {
    const [type, ...params] = contentType.toLowerCase().split(';');
    const t = type.trim();
    if (/^audio\/(mpeg|mp3|mpeg3|x-mpeg|x-mp3)$/.test(t)) {
        return 'mp3';
    }
    if (/^audio\/(x-)?flac$/.test(t)) {
        return 'flac';
    }
    if (/^audio\/((x-)?wav|wave|vnd\.wave)$/.test(t)) {
        return 'wav';
    }
    // ESPHome takes Ogg only with Opus in it; plain audio/ogg is almost always Vorbis
    if (t === 'audio/opus' || (t === 'audio/ogg' && params.join(';').includes('opus'))) {
        return 'opus';
    }
    // m3u and HLS share their types; the body tells them apart
    if (/^(application|audio)\/(vnd\.apple\.mpegurl|x-mpegurl|mpegurl)$/.test(t)) {
        return 'playlist';
    }
    if (t === 'audio/x-scpls' || t === 'application/pls+xml') {
        return 'playlist';
    }
    if (/^(audio|video)\//.test(t)) {
        return 'other'; // AAC, Vorbis, MP4 …
    }
    return 'unknown';
}

/** The kind of stream the file extension of a URL suggests. */
export function kindFromUrl(url: string): StreamKind {
    let path: string;
    try {
        path = new URL(url).pathname.toLowerCase();
    } catch {
        return 'unknown';
    }
    const ext = /\.([a-z0-9]+)$/.exec(path)?.[1] || '';
    const byExt: Record<string, StreamKind> = {
        mp3: 'mp3',
        flac: 'flac',
        wav: 'wav',
        opus: 'opus',
        m3u8: 'hls',
        m3u: 'playlist',
        pls: 'playlist',
        aac: 'other',
        m4a: 'other',
        mp4: 'other',
        ogg: 'other',
        oga: 'other',
        wma: 'other',
    };
    return byExt[ext] || 'unknown';
}

/**
 * Read a playlist: HLS (`#EXT-X-…`) is a stream in itself and stays as it is; a `.pls` or plain `.m3u` gives its
 * first http(s) entry, resolved against the playlist's own URL. `url` is '' when there is none.
 */
export function parsePlaylist(text: string, base: string): { hls: boolean; url: string } {
    if (/^#EXT-X-/m.test(text)) {
        return { hls: true, url: base };
    }
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        const entry =
            /^File\d+\s*=\s*(.+)$/i.exec(line)?.[1] ??
            (line && !line.startsWith('#') && !line.startsWith('[') ? line : '');
        if (!entry || /^[a-z]+\s*=/i.test(entry)) {
            continue; // "NumberOfEntries=1", "Title1=…"
        }
        try {
            const url = new URL(entry.trim(), base);
            if (url.protocol === 'http:' || url.protocol === 'https:') {
                return { hls: false, url: url.href };
            }
        } catch {
            /* not a URL */
        }
    }
    return { hls: false, url: '' };
}

/** What a URL turned out to be after following its playlists. */
export interface StreamProbe {
    /** The stream itself (a playlist's entry) — what the device or ffmpeg should open. */
    url: string;
    kind: StreamKind;
    contentType: string;
    /** Why the probe could not look (network error, a server that does not speak HTTP/1.1 like old SHOUTcast). */
    error?: string;
}

export interface ProbeOptions {
    /** Per request. */
    timeoutMs?: number;
    fetch?: typeof fetch;
}

/** Read at most `max` bytes of a response body, then let go of it. */
async function readSome(res: Response, max: number): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) {
        return '';
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (size < max) {
            const { done, value } = await reader.read();
            if (done || !value) {
                break;
            }
            chunks.push(value);
            size += value.length;
        }
    } finally {
        reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks).subarray(0, max).toString('utf8');
}

/**
 * Find out what `url` is: one GET per step for the headers — the body is read only for a playlist, a live
 * stream is dropped right after its headers. Playlists are followed to their first stream.
 */
export async function probeStream(url: string, opts: ProbeOptions = {}): Promise<StreamProbe> {
    const doFetch = opts.fetch ?? fetch;
    const timeoutMs = opts.timeoutMs ?? 5000;
    let current = url;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await doFetch(current, {
                signal: controller.signal,
                redirect: 'follow',
                headers: { 'User-Agent': 'ioBroker.assistant', 'Icy-MetaData': '0' },
            });
            const contentType = res.headers.get('content-type') || '';
            const final = res.url || current;
            if (!res.ok) {
                controller.abort();
                return { url: current, kind: kindFromUrl(final), contentType, error: `HTTP ${res.status}` };
            }
            let kind = kindFromContentType(contentType);
            if (kind === 'unknown' || (kind === 'other' && kindFromUrl(final) === 'hls')) {
                kind = kindFromUrl(final);
            }
            if (kind !== 'playlist' && kind !== 'hls') {
                controller.abort(); // a live stream would never end
                return { url: current, kind, contentType };
            }
            const list = parsePlaylist(await readSome(res, MAX_PLAYLIST_BYTES), final);
            if (list.hls) {
                return { url: current, kind: 'hls', contentType };
            }
            if (!list.url) {
                return { url: current, kind: 'playlist', contentType, error: 'empty playlist' };
            }
            current = list.url;
        } catch (e) {
            const err = e as Error & { cause?: { message?: string } };
            const error = controller.signal.aborted ? 'timeout' : err.cause?.message || err.message;
            return { url: current, kind: kindFromUrl(current), contentType: '', error };
        } finally {
            clearTimeout(timer);
        }
    }
    return { url: current, kind: 'playlist', contentType: '', error: 'playlists nested too deep' };
}

/**
 * The codecs the device decodes, from its media players' `supported_formats`: the listed ones; all classic ones
 * when it lists nothing (older firmware, built with every decoder) or a pipeline takes `NONE` (no preference — the
 * firmware then has to be built with every decoder).
 */
export function deviceCodecs(formats: MediaFormat[]): Set<DeviceCodec> {
    const listed = formats.map(f => f.format.trim().toLowerCase());
    if (!listed.length || listed.includes('none')) {
        return new Set(CLASSIC_CODECS);
    }
    return new Set(DEVICE_CODECS.filter(c => listed.includes(c)));
}

/** What ffmpeg writes for the device. */
export interface TranscodeTarget {
    codec: DeviceCodec;
    sampleRate: number;
    channels: 1 | 2;
}

/**
 * The format a transcoded stream gets: FLAC if the device decodes it (lossless, cheap to write), else MP3, Opus,
 * WAV. Rate and channels from the device's entry for that codec, music (default purpose) before announcements;
 * without a preference 48 kHz mono like the spoken replies.
 */
export function transcodeTarget(formats: MediaFormat[]): TranscodeTarget {
    const codecs = deviceCodecs(formats);
    const codec = DEVICE_CODECS.find(c => codecs.has(c)) || 'flac';
    const entry = [
        ...formats.filter(f => f.purpose === 'default'),
        ...formats.filter(f => f.purpose !== 'default'),
    ].find(f => f.format.trim().toLowerCase() === codec);
    let sampleRate = entry?.sampleRate || 48000;
    // libopus runs at 48/24/16/12/8 kHz only
    if (codec === 'opus' && ![48000, 24000, 16000, 12000, 8000].includes(sampleRate)) {
        sampleRate = 48000;
    }
    return { codec, sampleRate, channels: entry?.channels === 2 ? 2 : 1 };
}

/** Content-Type of a transcoded stream; ESPHome goes by it (or the extension). */
export const STREAM_CONTENT_TYPES: Record<DeviceCodec, string> = {
    flac: 'audio/flac',
    mp3: 'audio/mpeg',
    opus: 'audio/ogg; codecs=opus',
    wav: 'audio/wav',
};

/** File extension of a transcoded stream's URL. */
export const STREAM_EXTENSIONS: Record<DeviceCodec, string> = { flac: 'flac', mp3: 'mp3', opus: 'opus', wav: 'wav' };

/** ffmpeg arguments that read `url` and write `target` to stdout, for as long as the source sends. */
export function transcodeArgs(url: string, target: TranscodeTarget, hls: boolean): string[] {
    // A dropped radio connection comes back by itself instead of ending the music; HLS reloads its playlist anyway.
    const reconnect = hls ? [] : ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
    const codec: Record<DeviceCodec, string[]> = {
        flac: ['-c:a', 'flac', '-f', 'flac'],
        mp3: ['-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3'],
        opus: ['-c:a', 'libopus', '-b:a', '128k', '-f', 'ogg'],
        wav: ['-c:a', 'pcm_s16le', '-f', 'wav'],
    };
    // prettier-ignore
    return [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        ...reconnect,
        '-i', url,
        '-map', '0:a:0', '-vn', '-map_metadata', '-1',
        '-ar', String(target.sampleRate), '-ac', String(target.channels), '-sample_fmt', 's16',
        ...codec[target.codec],
        '-',
    ];
}

/** How a URL is going to be played. */
export interface StreamPlan {
    mode: 'direct' | 'transcode';
    /** The stream itself (a playlist resolved): what the device or ffmpeg opens. */
    url: string;
    kind: StreamKind;
    /** For the log: why this way. */
    reason: string;
}

/**
 * Direct or through ffmpeg?
 *
 * @param probe what the URL is
 * @param codecs what the device decodes ({@link deviceCodecs})
 * @param always the player's `transcode` switch: through ffmpeg whatever the stream is
 * @param ffmpeg whether ffmpeg is there; without it everything is played directly — maybe the device manages
 */
export function planStream(probe: StreamProbe, codecs: Set<DeviceCodec>, always: boolean, ffmpeg: boolean): StreamPlan {
    const detail = [probe.contentType.split(';')[0].trim(), probe.error].filter(Boolean).join(', ');
    const what = `${probe.kind === 'unknown' ? 'unknown format' : probe.kind}${detail ? ` (${detail})` : ''}`;
    const decodable = (DEVICE_CODECS as StreamKind[]).includes(probe.kind) && codecs.has(probe.kind as DeviceCodec);
    let mode: StreamPlan['mode'] = always || !decodable ? 'transcode' : 'direct';
    let reason = always
        ? `${what}, transcoding is switched on`
        : decodable
          ? `${what}, the device decodes it`
          : `${what}, the device decodes ${[...codecs].join('/') || 'nothing it lists'}`;
    if (mode === 'transcode' && !ffmpeg) {
        mode = 'direct';
        reason += ' — but ffmpeg is missing, so the device gets it as it is';
    }
    return { mode, url: probe.url, kind: probe.kind, reason };
}
