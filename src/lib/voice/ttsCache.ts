/**
 * The plumbing every TTS engine benefits from: a disk cache, a length limit, and SSML handling.
 *
 * Wrapped around any {@link TtsEngine}, so each engine stays a thin provider binding:
 *   - **cache** — the assistant says the same short things over and over ("Ok.", "Timer abgelaufen",
 *     a trigger's announcement). Synthesising those again on every repeat costs a cloud round-trip and
 *     a few hundred milliseconds of latency for audio that is byte-for-byte identical. Only short texts
 *     are cached: a long one-off answer will never be asked for twice, so it would only fill the disk.
 *   - **length limit** — an LLM can answer with three paragraphs. Spoken at a speaker that is a minute
 *     of monologue nobody can interrupt, so the text is cut at the last sentence end that fits.
 *   - **SSML** — Azure and Polly can speak `<speak>…</speak>` (pauses, emphasis); OpenAI and the local
 *     engines cannot, so there the tags are stripped rather than read out loud.
 *
 * All three come from the Python original (`C:\iot\Hannah`, `core/hannah/tts.py`: `_TTSCache`,
 * `_truncate_for_tts`, `_strip_ssml_tags`), including the detail that the sample rate belongs in the
 * cache entry — serving 24 kHz audio as 16 kHz plays it back at the wrong pitch.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TtsEngine, TtsResult } from './tts';
import type { VoiceLogger } from './download';

/** Hard limit for a spoken text. Hannah's 400 characters ≈ 25 seconds of speech. */
export const MAX_TTS_CHARS = 400;

/** Texts up to this length are worth caching; a longer one is a one-off answer. */
export const MAX_CACHE_CHARS = 200;

/** Default budget for the cache directory. ~1 MB per 20 s of 24 kHz 16-bit audio. */
export const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;

/** Does this text ask for SSML? */
export function isSsml(text: string): boolean {
    return /^\s*<speak[\s>]/i.test(text || '');
}

/** Drop the XML tags, for an engine that cannot speak SSML (reading them aloud would be worse). */
export function stripSsml(text: string): string {
    return (text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Cut `text` to `maxChars`, preferring the last sentence end in the second half so the result does not
 * stop mid-thought; failing that, the last word boundary plus an ellipsis. SSML is left alone — cutting
 * it would break the markup, and it is written by us, not by a model.
 */
export function truncateForTts(text: string, maxChars = MAX_TTS_CHARS): string {
    const t = (text || '').trim();
    if (t.length <= maxChars || isSsml(t)) {
        return t;
    }
    const chunk = t.slice(0, maxChars);
    for (const sep of ['.', '!', '?', '…']) {
        const idx = chunk.lastIndexOf(sep);
        if (idx > maxChars / 2) {
            return chunk.slice(0, idx + 1);
        }
    }
    const lastSpace = chunk.lastIndexOf(' ');
    return `${(lastSpace > 0 ? chunk.slice(0, lastSpace) : chunk).trim()} …`;
}

/** A cache entry on disk: the sample rate first, so an entry can never be replayed at the wrong pitch. */
function encodeEntry(result: TtsResult): Buffer {
    const head = Buffer.alloc(4);
    head.writeUInt32LE(result.sampleRate, 0);
    return Buffer.concat([head, result.pcm]);
}

function decodeEntry(data: Buffer): TtsResult | null {
    if (data.length < 8) {
        return null;
    }
    const sampleRate = data.readUInt32LE(0);
    // A plausible speech rate; anything else means the file is not one of ours (or is truncated).
    if (sampleRate < 8000 || sampleRate > 48000) {
        return null;
    }
    return { pcm: data.subarray(4), sampleRate };
}

export interface TtsCacheOptions {
    /** Directory for this engine's entries (one per provider+voice, so a voice change cannot serve stale audio). */
    dir: string;
    log: VoiceLogger;
    /** Cut texts longer than this before synthesising (0 = no limit). */
    maxChars?: number;
    /** Only cache texts up to this length (0 = cache everything). */
    maxCacheChars?: number;
    /** Prune the oldest entries once the directory exceeds this (0 = no limit). */
    maxBytes?: number;
}

/**
 * A {@link TtsEngine} wrapper that truncates, serves repeats from disk and resolves SSML against what the
 * wrapped engine actually supports. Every cache operation is best-effort: a broken or read-only cache
 * directory must never stop the assistant from speaking.
 */
export class CachedTts implements TtsEngine {
    private readonly maxChars: number;
    private readonly maxCacheChars: number;
    private readonly maxBytes: number;
    private ready = false;

    constructor(
        private readonly engine: TtsEngine,
        private readonly opts: TtsCacheOptions,
    ) {
        this.maxChars = opts.maxChars ?? MAX_TTS_CHARS;
        this.maxCacheChars = opts.maxCacheChars ?? MAX_CACHE_CHARS;
        this.maxBytes = opts.maxBytes ?? DEFAULT_CACHE_BYTES;
    }

    prepare(lang: string): Promise<void> {
        return this.engine.prepare ? this.engine.prepare(lang) : Promise.resolve();
    }

    async synthesize(text: string, lang: string): Promise<TtsResult> {
        const wanted = this.maxChars > 0 ? truncateForTts(text, this.maxChars) : (text || '').trim();
        if (wanted.length < (text || '').trim().length) {
            this.opts.log.warn(`TTS text shortened from ${text.trim().length} to ${wanted.length} characters.`);
        }
        const cacheable = this.maxCacheChars === 0 || wanted.length <= this.maxCacheChars;
        const file = cacheable ? this.entryPath(wanted, lang) : '';
        if (file) {
            const hit = this.read(file);
            if (hit) {
                this.opts.log.debug(`TTS cache hit: "${wanted.slice(0, 40)}"`);
                return hit;
            }
        }
        const result = await this.speak(wanted, lang);
        if (file && result.pcm.length) {
            this.write(file, result);
        }
        return result;
    }

    /** Hand SSML to the engine only if it can speak it; otherwise speak the text without the markup. */
    private speak(text: string, lang: string): Promise<TtsResult> {
        if (!isSsml(text)) {
            return this.engine.synthesize(text, lang);
        }
        if (this.engine.synthesizeSsml) {
            return this.engine.synthesizeSsml(text, lang);
        }
        this.opts.log.debug('TTS engine cannot speak SSML — using the plain text.');
        return this.engine.synthesize(stripSsml(text), lang);
    }

    /** Is this text already on disk? Used by the warm-up to skip what it has. */
    has(text: string, lang: string): boolean {
        const wanted = this.maxChars > 0 ? truncateForTts(text, this.maxChars) : (text || '').trim();
        const file = this.entryPath(wanted, lang);
        try {
            return fs.existsSync(file);
        } catch {
            return false;
        }
    }

    /** Pre-synthesise frequently spoken phrases, so the first "Ok." of the day is not a cloud call. */
    async warm(phrases: string[], lang: string): Promise<number> {
        let added = 0;
        for (const phrase of phrases) {
            const text = (phrase || '').trim();
            if (!text || this.has(text, lang)) {
                continue;
            }
            try {
                await this.synthesize(text, lang);
                added++;
            } catch (e) {
                this.opts.log.debug(`TTS warm-up failed for "${text.slice(0, 30)}": ${(e as Error).message}`);
                break; // the engine is unavailable — no point trying the rest
            }
        }
        if (added) {
            this.opts.log.info(`TTS cache warmed with ${added} phrase(s).`);
        }
        return added;
    }

    /** The language is part of the key: the same words are spoken differently in another language. */
    private entryPath(text: string, lang: string): string {
        const key = crypto.createHash('sha256').update(`${lang}\u0000${text}`).digest('hex').slice(0, 20);
        return path.join(this.opts.dir, `${key}.pcm`);
    }

    private read(file: string): TtsResult | null {
        try {
            if (!fs.existsSync(file)) {
                return null;
            }
            const entry = decodeEntry(fs.readFileSync(file));
            if (entry) {
                // Touch it, so pruning drops what nobody asks for rather than what is merely old.
                const now = new Date();
                try {
                    fs.utimesSync(file, now, now);
                } catch {
                    /* a read-only cache is still a usable cache */
                }
            }
            return entry;
        } catch (e) {
            this.opts.log.debug(`TTS cache read failed: ${(e as Error).message}`);
            return null;
        }
    }

    private write(file: string, result: TtsResult): void {
        try {
            if (!this.ready) {
                fs.mkdirSync(this.opts.dir, { recursive: true });
                this.ready = true;
            }
            fs.writeFileSync(file, encodeEntry(result));
            this.prune();
        } catch (e) {
            this.opts.log.debug(`TTS cache write failed: ${(e as Error).message}`);
        }
    }

    /** Keep the directory under its budget by dropping the least recently used entries. */
    private prune(): void {
        if (this.maxBytes <= 0) {
            return;
        }
        try {
            const entries = fs
                .readdirSync(this.opts.dir)
                .filter(name => name.endsWith('.pcm'))
                .map(name => {
                    const full = path.join(this.opts.dir, name);
                    const stat = fs.statSync(full);
                    return { full, size: stat.size, used: stat.mtimeMs };
                });
            let total = entries.reduce((sum, e) => sum + e.size, 0);
            if (total <= this.maxBytes) {
                return;
            }
            for (const entry of entries.sort((a, b) => a.used - b.used)) {
                if (total <= this.maxBytes) {
                    break;
                }
                fs.unlinkSync(entry.full);
                total -= entry.size;
            }
            this.opts.log.debug(`TTS cache pruned to ${Math.round(total / 1024)} KiB.`);
        } catch (e) {
            this.opts.log.debug(`TTS cache prune failed: ${(e as Error).message}`);
        }
    }
}
