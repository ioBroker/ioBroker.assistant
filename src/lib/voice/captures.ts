/**
 * Diagnosis recordings: microphone audio that a satellite captured but that never became a request — dropped as
 * silence, or returned empty by the speech recognition. Without the audio there is no telling whether a false
 * wake heard the TV, a quiet microphone missed a voice, or the recognition failed on real speech.
 *
 * Each recording is a WAV plus a JSON with what the voice activity detection made of it and a level profile (RMS
 * per 100 ms), so the levels can be read without an audio editor. Only the newest {@link MAX_CAPTURES} are kept.
 * The store does not care where files go; the adapter hands it its file storage (Admin → Files).
 */

import { pcmToWav } from './stt';
import { rms, type Bytes } from './vad';

/** Why a recording was dropped. */
export type DiscardReason =
    /** nobody started speaking before the start timeout */
    | 'no-speech'
    /** sound, but never loud enough for the speech threshold */
    | 'silence'
    /** speech by level, but the recognition returned no text */
    | 'empty-stt';

export interface DiscardedCapture {
    device: string;
    room: string;
    /** Wake word that opened the mic; '' = re-opened for a follow-up. */
    wakeWord: string;
    reason: DiscardReason;
    pcm: Bytes;
    sampleRate: number;
    vad: { peak: number; analysedPeak: number; noiseFloor: number; startLevel: number; endLevel: number };
}

/** File operations, relative to the store's root (the adapter's file storage). */
export interface CaptureFiles {
    write(path: string, data: Buffer | string): Promise<void>;
    /** File names in `dir`; empty (not an error) when it does not exist yet. */
    list(dir: string): Promise<string[]>;
    remove(path: string): Promise<void>;
}

export const CAPTURE_DIR = 'captures';
/** ~400 KB per 12 s recording at 16 kHz, so at most ~20 MB. */
export const MAX_CAPTURES = 50;
/** Resolution of the level profile in the JSON. */
export const LEVEL_STEP_MS = 100;

/** RMS per `stepMs` of mono 16-bit PCM, rounded. */
export function levelProfile(pcm: Bytes, sampleRate: number, stepMs = LEVEL_STEP_MS): number[] {
    const step = Math.max(2, Math.round((sampleRate * stepMs) / 1000) * 2);
    const levels: number[] = [];
    for (let offset = 0; offset < pcm.length; offset += step) {
        levels.push(Math.round(rms(pcm.subarray(offset, Math.min(pcm.length, offset + step)))));
    }
    return levels;
}

/**
 * `2026-11-03_08-33-36-123_<device>_<reason>` in local time: sorts chronologically by name, which is what
 * pruning relies on, and reads well in the Admin file list.
 */
export function captureBaseName(date: Date, device: string, reason: DiscardReason): string {
    const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
    const time =
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
        `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
    const name = (device || 'satellite').replace(/[^\w.-]/g, '_').slice(0, 60);
    return `${time}_${name}_${reason}`;
}

export class CaptureStore {
    /** Saves run one after another, so two at once cannot prune each other's files. */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly files: CaptureFiles,
        private readonly max = MAX_CAPTURES,
    ) {}

    /** Store one recording and drop the oldest beyond the limit. Resolves with the path of the WAV. */
    save(capture: DiscardedCapture, now = new Date()): Promise<string> {
        const run = this.queue.then(() => this.write(capture, now));
        this.queue = run.catch(() => undefined);
        return run;
    }

    private async write(capture: DiscardedCapture, now: Date): Promise<string> {
        const base = `${CAPTURE_DIR}/${captureBaseName(now, capture.device, capture.reason)}`;
        const info = {
            time: now.toISOString(),
            device: capture.device,
            room: capture.room,
            wakeWord: capture.wakeWord || '(follow-up)',
            reason: capture.reason,
            seconds: Math.round((capture.pcm.length / 2 / capture.sampleRate) * 100) / 100,
            sampleRate: capture.sampleRate,
            vad: capture.vad,
            levelStepMs: LEVEL_STEP_MS,
            levels: levelProfile(capture.pcm, capture.sampleRate),
        };
        await this.files.write(`${base}.wav`, pcmToWav(Buffer.from(capture.pcm), capture.sampleRate));
        await this.files.write(`${base}.json`, `${JSON.stringify(info, null, 2)}\n`);
        await this.prune();
        return `${base}.wav`;
    }

    private async prune(): Promise<void> {
        const names = (await this.files.list(CAPTURE_DIR)).filter(n => /\.(wav|json)$/.test(n));
        const bases = [...new Set(names.map(n => n.replace(/\.(wav|json)$/, '')))].sort();
        for (const base of bases.slice(0, Math.max(0, bases.length - this.max))) {
            for (const name of names.filter(n => n.replace(/\.(wav|json)$/, '') === base)) {
                await this.files.remove(`${CAPTURE_DIR}/${name}`).catch(() => undefined);
            }
        }
    }
}
