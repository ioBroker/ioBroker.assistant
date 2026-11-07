/**
 * Audio for speech recognition: the recording cut to the speech and brought to a usable level.
 *
 * ESPHome satellites stream from the wake word on, so a recording starts with the device's own chirp or beep
 * and the silence before anybody speaks, and ends with the silence that told us the speaker stopped. Measured
 * on a ThirdReality speaker (2026-11-03): the answer to a follow-up question — a 250 ms beep, a second of
 * digital silence, then "Мессенджер. Да, да." at RMS 150–500 — came back empty from Nemotron, and Whisper
 * made "Продолжение следует... Мессенджет. и я" of it (the subtitle line Whisper invents for silence). Cut to
 * the speech and amplified, Whisper heard it right.
 *
 * Only what goes to the recognition changes; the diagnosis recordings keep the audio as it arrived.
 */
import { rms, type Bytes } from './vad';

/** Audio kept before the frame where speech was detected: the soft start of a word lies below the gate. */
export const PRE_ROLL_MS = 400;
/** Audio kept after the last sound: the fading end of a word. */
export const TAIL_MS = 400;
/**
 * A frame in the tail counts as sound when it reaches this share of the silence threshold — low, so that a
 * quiet last syllable stays in. In a noisy room nothing is quiet enough, and the tail is simply kept.
 */
export const TAIL_SHARE = 0.4;
/** Peak sample quiet speech is raised to — about half of full scale, headroom for the loudest syllable. */
export const TARGET_PEAK = 16000;
/** Never amplify more than this: beyond it only the noise grows. */
export const MAX_GAIN = 10;
/** Gains below this are not worth touching the audio for. */
const MIN_GAIN = 1.25;
/** Never cut a recording shorter than this — a short "да" plus its margins. */
const MIN_KEEP_MS = 600;
/** Resolution of the tail search. */
const FRAME_MS = 30;

export interface SttAudio {
    /** The audio to recognise. */
    pcm: Buffer;
    /** Where it starts and ends in the recording, in ms. */
    fromMs: number;
    toMs: number;
    /** Gain applied to it (1 = unchanged), rounded to two decimals. */
    gain: number;
}

/**
 * Cut `pcm` (mono 16-bit) to the speech and amplify it when it is quiet.
 *
 * @param pcm the whole recording
 * @param sampleRate its sample rate
 * @param speech what the detector saw
 * @param speech.startMs where speech started, in ms (absent = keep the beginning)
 * @param speech.endLevel the silence threshold; the tail keeps everything above 40 % of it
 */
export function prepareForStt(
    pcm: Bytes,
    sampleRate: number,
    speech: { startMs?: number; endLevel: number },
): SttAudio {
    const samples = Math.floor(pcm.length / 2);
    const perMs = sampleRate / 1000;
    const totalMs = Math.floor(samples / perMs);

    let fromMs = speech.startMs !== undefined && speech.startMs >= 0 ? Math.max(0, speech.startMs - PRE_ROLL_MS) : 0;
    fromMs = Math.min(fromMs, Math.max(0, totalMs - MIN_KEEP_MS));

    // The tail: the last frame with any sound in it, plus a margin.
    let toMs = totalMs;
    const quiet = speech.endLevel * TAIL_SHARE;
    if (quiet > 0) {
        const frame = Math.max(1, Math.round(FRAME_MS * perMs));
        const first = Math.round(fromMs * perMs);
        let lastSound = -1;
        for (let start = samples - frame; start >= first; start -= frame) {
            if (rms(pcm.subarray(start * 2, (start + frame) * 2)) >= quiet) {
                lastSound = start + frame;
                break;
            }
        }
        if (lastSound >= 0) {
            toMs = Math.min(totalMs, Math.ceil(lastSound / perMs) + TAIL_MS);
        }
    }
    if (toMs - fromMs < MIN_KEEP_MS) {
        toMs = Math.min(totalMs, fromMs + MIN_KEEP_MS);
    }

    const from = Math.round(fromMs * perMs);
    const to = Math.min(samples, Math.round(toMs * perMs));
    let peak = 0;
    for (let i = from; i < to; i++) {
        const value = Math.abs(pcm.readInt16LE(i * 2));
        if (value > peak) {
            peak = value;
        }
    }
    let gain = peak > 0 ? Math.min(MAX_GAIN, TARGET_PEAK / peak) : 1;
    if (gain < MIN_GAIN) {
        gain = 1;
    }

    const out = Buffer.alloc((to - from) * 2);
    if (gain === 1) {
        pcm.copy(out, 0, from * 2, to * 2);
    } else {
        for (let i = from; i < to; i++) {
            const value = Math.round(pcm.readInt16LE(i * 2) * gain);
            out.writeInt16LE(Math.max(-32768, Math.min(32767, value)), (i - from) * 2);
        }
    }
    return { pcm: out, fromMs, toMs, gain: Math.round(gain * 100) / 100 };
}
