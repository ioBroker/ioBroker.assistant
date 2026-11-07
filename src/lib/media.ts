/**
 * Pictures and videos that come with a question (`ask` with `images` / `video`, e.g. from Telegram).
 *
 * Pictures go to the cloud model as they are (base64, the vendors take JPEG/PNG/GIF/WebP). Videos are not looked at
 * yet: the sender keeps them and only says where, so a video never travels through the message bus as base64 - on its
 * disk as an `iobdisk://` URL (js-controller 8.0+, read with `adapter.readDiskFile(url)` from any host), or in the
 * ioBroker file storage as `{ adapter, path }`.
 */

/** A picture for the model: base64 without a `data:` prefix and its type. */
export interface ImageInput {
    data: string;
    mimeType: string;
}

/** Where the sender stored a video, with what it knows about it. */
export interface VideoRef {
    /**
     * The file on the disk of the sender's host, e.g. `iobdisk://pi4/telegram.0/assistant/video_1.mp4`
     * (js-controller 8.0+: `adapter.readDiskFile(url)` reads it from any host). Empty `adapter` and `path` then.
     */
    url?: string;
    /** File storage namespace, e.g. `telegram.0` (empty with `url`) */
    adapter: string;
    /** Path in it, e.g. `assistant/video_2026-11-04_10-00-00.mp4` (empty with `url`) */
    path: string;
    mimeType?: string;
    durationSec?: number;
    size?: number;
    /** Set when the sender could not store it (e.g. too big to download) */
    error?: string;
}

/** At most this many pictures per question (an album of Telegram has up to 10) */
export const MAX_IMAGES = 4;

/** Largest picture as base64 text: Anthropic refuses images over 5 MB */
export const MAX_IMAGE_BASE64 = 5 * 1024 * 1024;

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * The type of a picture from its first bytes, `null` if it is none of the four the vendors take.
 *
 * @param buf the start of the file (16 bytes are enough)
 */
export function sniffImageType(buf: Buffer): string | null {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return 'image/jpeg';
    }
    if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'image/png';
    }
    if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) {
        return 'image/gif';
    }
    if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
        return 'image/webp';
    }
    return null;
}

/**
 * Check the `images` of an `ask`: base64 of JPEG/PNG/GIF/WebP, at most {@link MAX_IMAGES} and
 * {@link MAX_IMAGE_BASE64} each. The type is taken from the content, not from what the sender says.
 *
 * @param raw the `images` field: a list of `{ data, mimeType? }` (one object or a bare base64 string work too)
 * @returns the pictures, or the reason they are refused
 */
export function parseAskImages(raw: unknown): { images: ImageInput[]; error?: string } {
    if (raw === undefined || raw === null || raw === '') {
        return { images: [] };
    }
    const list = Array.isArray(raw) ? raw : [raw];
    if (list.length > MAX_IMAGES) {
        return { images: [], error: `too many pictures (${list.length}, at most ${MAX_IMAGES})` };
    }
    const images: ImageInput[] = [];
    for (const item of list) {
        const data = typeof item === 'string' ? item : (item as { data?: unknown } | null)?.data;
        if (typeof data !== 'string' || !data) {
            return { images: [], error: 'a picture without data' };
        }
        // a data URL is fine as well
        const base64 = data.replace(/^data:[^;,]*;base64,/, '').replace(/\s+/g, '');
        if (base64.length > MAX_IMAGE_BASE64) {
            return {
                images: [],
                error: `picture too big (${Math.round((base64.length * 3) / 4 / 1024)} KB, at most ${(MAX_IMAGE_BASE64 * 3) / 4 / 1024} KB)`,
            };
        }
        const mimeType = sniffImageType(Buffer.from(base64.slice(0, 32), 'base64'));
        if (!mimeType || !IMAGE_TYPES.has(mimeType)) {
            return { images: [], error: 'not a JPEG, PNG, GIF or WebP picture' };
        }
        images.push({ data: base64, mimeType });
    }
    return { images };
}

/**
 * Check the `video` of an `ask`: only a reference - an `iobdisk://` URL or a file of the ioBroker file storage -,
 * never the content.
 *
 * @param raw the `video` field
 * @returns the reference, `null` without one, or the reason it is refused (e.g. base64 content)
 */
export function parseAskVideo(raw: unknown): VideoRef | null | { error: string } {
    if (raw === undefined || raw === null || raw === '') {
        return null;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { error: 'video must be { url } (iobdisk://) or { adapter, path } of the ioBroker file storage' };
    }
    const v = raw as Record<string, unknown>;
    if ('data' in v) {
        return { error: 'a video is not sent as content - store it and send { url } or { adapter, path }' };
    }
    const str = (x: unknown): string => (typeof x === 'string' ? x.trim() : '');
    const num = (x: unknown): number | undefined =>
        typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined;
    const url = str(v.url);
    if (url && !/^iobdisk:\/\/[^/]+\/[^/]+\/.+/.test(url)) {
        return { error: 'video url must be iobdisk://<host>/<namespace>/<path>' };
    }
    const ref: VideoRef = {
        url: url || undefined,
        adapter: url ? '' : str(v.adapter),
        path: url ? '' : str(v.path).replace(/^\/+/, ''),
        mimeType: str(v.mimeType) || undefined,
        durationSec: num(v.durationSec),
        size: num(v.size),
        error: str(v.error) || undefined,
    };
    if (!ref.url && (!ref.adapter || !ref.path) && !ref.error) {
        return { error: 'video without url or adapter and path' };
    }
    return ref;
}

/**
 * Where a video is, for the log, the journal and the trace: the `iobdisk://` URL or `adapter/path`.
 *
 * @param video the reference
 */
export function videoLocation(video: VideoRef): string {
    return video.url || (video.adapter ? `${video.adapter}/${video.path}` : `not stored: ${video.error || 'unknown'}`);
}

/** Whether {@link parseAskVideo} refused the video */
export function isVideoError(v: VideoRef | null | { error: string }): v is { error: string } {
    return !!v && !('adapter' in v);
}

/**
 * Copy of a request / message list with the pictures replaced by a short note — for the trace and the debug log,
 * where hundreds of KB of base64 per round help nobody. Understands the OpenAI (`image_url` with a data URL) and the
 * Anthropic form (`image` with a base64 `source`).
 *
 * @param value what to copy
 */
export function redactImages<T>(value: T): T {
    const walk = (v: unknown): unknown => {
        if (Array.isArray(v)) {
            return v.map(walk);
        }
        if (!v || typeof v !== 'object') {
            return v;
        }
        const o = v as Record<string, any>;
        if (o.type === 'image_url' && typeof o.image_url?.url === 'string' && o.image_url.url.startsWith('data:')) {
            return { ...o, image_url: { ...o.image_url, url: imageNote(o.image_url.url) } };
        }
        if (o.type === 'image' && o.source?.type === 'base64' && typeof o.source.data === 'string') {
            return { ...o, source: { ...o.source, data: imageNote(o.source.data, o.source.media_type) } };
        }
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(o)) {
            out[k] = walk(x);
        }
        return out;
    };
    return walk(value) as T;
}

function imageNote(data: string, mimeType?: string): string {
    const m = /^data:([^;,]+)/.exec(data);
    const base64 = data.replace(/^data:[^,]*,/, '');
    return `<${mimeType || m?.[1] || 'image'}, ${Math.round((base64.length * 3) / 4 / 1024)} KB>`;
}

/** Language of the texts below: de, ru, else en */
type Lang = string;

/**
 * The question for pictures that came without one (a photo without caption).
 *
 * @param lang language of the answer
 * @param count number of pictures
 */
export function imageOnlyQuestion(lang: Lang, count = 1): string {
    if (lang === 'ru') {
        return count > 1 ? 'Что на этих картинках?' : 'Что на этой картинке?';
    }
    if (lang === 'de') {
        return count > 1 ? 'Was ist auf diesen Bildern?' : 'Was ist auf diesem Bild?';
    }
    return count > 1 ? 'What is in these pictures?' : 'What is in this picture?';
}

/**
 * The answer to a video that came without a question.
 *
 * @param lang language of the answer
 */
export function videoNotSupportedText(lang: Lang): string {
    if (lang === 'ru') {
        return 'Видео я пока смотреть не умею.';
    }
    if (lang === 'de') {
        return 'Videos kann ich mir noch nicht ansehen.';
    }
    return "I can't watch videos yet.";
}

/**
 * The answer to pictures when there is no cloud model to look at them.
 *
 * @param lang language of the answer
 */
export function noVisionText(lang: Lang): string {
    if (lang === 'ru') {
        return 'Картинки я могу посмотреть только с облачной моделью.';
    }
    if (lang === 'de') {
        return 'Bilder kann ich mir nur mit einem Cloud-Modell ansehen.';
    }
    return 'I can only look at pictures with a cloud model.';
}

/**
 * Note for the model in the user turn: what came along besides the text. A model that does not get the pictures
 * (an older pi-agent) at least knows that there were some.
 *
 * @param images number of pictures attached
 * @param video whether a video came along
 */
export function attachmentNote(images: number, video: boolean): string {
    const parts: string[] = [];
    if (images) {
        parts.push(images > 1 ? `${images} pictures are attached.` : 'A picture is attached.');
    }
    if (video) {
        parts.push('The user also sent a video, which you cannot watch yet - say so if the question is about it.');
    }
    return parts.length ? `(${parts.join(' ')})` : '';
}

/**
 * How the question is kept in the conversation history: the pictures are not repeated in later turns, a marker says
 * there were some.
 *
 * @param question the question
 * @param images number of pictures
 * @param video whether a video came along
 */
export function historyText(question: string, images: number, video: boolean): string {
    const marks = [images ? `[${images > 1 ? `${images} pictures` : 'picture'}]` : '', video ? '[video]' : ''];
    return [...marks, question].filter(Boolean).join(' ');
}
