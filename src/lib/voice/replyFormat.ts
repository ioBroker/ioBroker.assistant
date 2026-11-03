/**
 * Which audio format an ESPHome satellite gets its spoken replies in.
 *
 * A media player announces the formats it takes (`ListEntitiesMediaPlayerResponse.supported_formats`, one per
 * purpose: default playback and announcements). Home Assistant transcodes every reply to the announcement format,
 * so that is the only one a firmware is tested with — and since ESPHome 2026.10 often the only one it can decode at
 * all: the player is built with just the codecs its pipelines use. We do the same: the announcement format first,
 * at its sample rate and channel count. A device that lists nothing (linux-voice-assistant, older firmware) keeps
 * getting WAV as before.
 */
import { encodeFlac } from './flac';
import { pcmToWav } from './stt';

/** One entry of `supported_formats`. */
export interface MediaFormat {
    /** `flac`, `mp3`, `wav`, `opus`, `none` … as the device names it. */
    format: string;
    /** 0 = no preference. */
    sampleRate: number;
    /** 0 = no preference. */
    channels: number;
    purpose: 'default' | 'announcement';
    sampleBytes: number;
}

export type ReplyCodec = 'wav' | 'flac' | 'mp3' | 'opus';

export interface ReplyFormat {
    codec: ReplyCodec;
    /** Target rate; 0 keeps the rate of the TTS engine. */
    sampleRate: number;
    channels: 1 | 2;
    /** What the device asked for, for the log. */
    source: string;
}

/** Turns PCM into a codec we cannot write ourselves (MP3, Opus) — ffmpeg in the adapter. */
export type ExternalEncoder = (
    pcm: Buffer,
    sampleRate: number,
    target: { codec: 'mp3' | 'opus'; sampleRate: number; channels: number },
) => Promise<Buffer>;

/** Codecs written here, without any tool. */
const NATIVE: ReplyCodec[] = ['flac', 'wav'];
const EXTERNAL: ReplyCodec[] = ['mp3', 'opus'];

export const CONTENT_TYPES: Record<ReplyCodec, string> = {
    wav: 'audio/wav',
    flac: 'audio/flac',
    mp3: 'audio/mpeg',
    // ESPHome takes Opus only as `audio/ogg` with an opus codecs parameter.
    opus: 'audio/ogg; codecs=opus',
};

/** The format replies have always had: WAV at the rate of the TTS engine. */
export const LEGACY_FORMAT: ReplyFormat = { codec: 'wav', sampleRate: 0, channels: 1, source: '' };

function describe(f: MediaFormat): string {
    return `${f.format}${f.sampleRate ? ` ${f.sampleRate} Hz` : ''}${f.channels ? ` ×${f.channels}` : ''} (${f.purpose})`;
}

/**
 * Pick the reply format from what the device's media players announced.
 *
 * @param formats every `supported_formats` entry of the device
 * @param external whether MP3/Opus can be produced (ffmpeg)
 */
export function chooseReplyFormat(formats: MediaFormat[], external: boolean): ReplyFormat {
    if (!formats.length) {
        return LEGACY_FORMAT;
    }
    const usable = (f: MediaFormat): ReplyCodec | null => {
        const codec = f.format.trim().toLowerCase() as ReplyCodec;
        return NATIVE.includes(codec) || (external && EXTERNAL.includes(codec)) ? codec : null;
    };
    // Announcements first (that is how a reply is played), our own codecs before ffmpeg ones.
    const ordered = [
        ...formats.filter(f => f.purpose === 'announcement'),
        ...formats.filter(f => f.purpose !== 'announcement'),
    ];
    const pick =
        ordered.find(f => {
            const codec = usable(f);
            return codec !== null && NATIVE.includes(codec);
        }) ?? ordered.find(f => usable(f) !== null);
    if (!pick) {
        // Nothing we can write (or `none` = the device takes anything): WAV, as before.
        return { ...LEGACY_FORMAT, source: ordered.map(describe).join(', ') };
    }
    return {
        codec: usable(pick) as ReplyCodec,
        sampleRate: pick.sampleRate || 0,
        channels: pick.channels === 2 ? 2 : 1,
        source: describe(pick),
    };
}

/** Filter taps per side at the lower of the two rates, and the number of precomputed sub-sample positions. */
const ZERO_CROSSINGS = 8;
const PHASES = 128;

/**
 * Resample mono s16le PCM with a Hann-windowed sinc. Cheap enough for the voice path (a table per sub-sample
 * position, ~20 taps when upsampling), and — unlike linear interpolation — it filters before it decimates, so a
 * 24 kHz voice taken down to 16 kHz does not fold its sibilants back into the speech band.
 */
export function resamplePcm(pcm: Buffer, from: number, to: number): Buffer {
    const n = pcm.length >> 1;
    if (from === to || !n || from <= 0 || to <= 0) {
        return pcm;
    }
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        input[i] = pcm.readInt16LE(i * 2);
    }
    const ratio = to / from;
    // A little below the Nyquist frequency of the lower rate.
    const cutoff = Math.min(1, ratio) * 0.95;
    const half = Math.ceil(ZERO_CROSSINGS / cutoff);
    const taps = 2 * half;
    const table = new Float32Array((PHASES + 1) * taps);
    for (let p = 0; p <= PHASES; p++) {
        const frac = p / PHASES;
        let sum = 0;
        for (let k = 0; k < taps; k++) {
            const d = k - half + 1 - frac; // distance of the input sample from the output position
            const x = d * cutoff;
            const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
            const w = Math.abs(d) >= half ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * d) / half);
            table[p * taps + k] = sinc * w;
            sum += sinc * w;
        }
        for (let k = 0; k < taps; k++) {
            table[p * taps + k] /= sum; // unity gain at every position: no ripple on a constant level
        }
    }
    const outLen = Math.max(1, Math.round(n * ratio));
    const out = Buffer.alloc(outLen * 2);
    for (let i = 0; i < outLen; i++) {
        const center = i / ratio;
        const base = Math.floor(center);
        const row = Math.round((center - base) * PHASES) * taps;
        const first = base - half + 1;
        let acc = 0;
        for (let k = 0; k < taps; k++) {
            const j = first + k;
            if (j >= 0 && j < n) {
                acc += input[j] * table[row + k];
            }
        }
        out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(acc))), i * 2);
    }
    return out;
}

/** Duplicate mono s16le PCM into interleaved stereo. */
export function monoToStereo(pcm: Buffer): Buffer {
    const n = pcm.length >> 1;
    const out = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
        const v = pcm.readInt16LE(i * 2);
        out.writeInt16LE(v, i * 4);
        out.writeInt16LE(v, i * 4 + 2);
    }
    return out;
}

/**
 * Encode a mono reply in `format`. MP3/Opus go through `external`; everything else is written here.
 * Throws when `external` is needed but missing or fails — the caller falls back to a native format.
 */
export async function encodeReply(
    pcm: Buffer,
    sampleRate: number,
    format: ReplyFormat,
    external?: ExternalEncoder,
): Promise<{ body: Buffer; contentType: string }> {
    const rate = format.sampleRate || sampleRate;
    if (format.codec === 'mp3' || format.codec === 'opus') {
        if (!external) {
            throw new Error(`no encoder for ${format.codec}`);
        }
        const body = await external(pcm, sampleRate, {
            codec: format.codec,
            sampleRate: rate,
            channels: format.channels,
        });
        return { body, contentType: CONTENT_TYPES[format.codec] };
    }
    const resampled = resamplePcm(pcm, sampleRate, rate);
    const samples = format.channels === 2 ? monoToStereo(resampled) : resampled;
    const body =
        format.codec === 'flac' ? encodeFlac(samples, rate, format.channels) : pcmToWav(samples, rate, format.channels);
    return { body, contentType: CONTENT_TYPES[format.codec] };
}
