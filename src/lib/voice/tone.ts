/**
 * A short confirmation beep, as an alternative to speaking "Okay" after a switch command.
 *
 * Every spoken confirmation costs a TTS round-trip — about a second between pressing the metaphorical
 * switch and hearing that it worked, for information the user already expects. A 300 ms tone is instant
 * and (once you know it) just as clear.
 *
 * Synthesised rather than shipped as a file, so it needs no asset, no decoder and no ffmpeg: a sine with
 * a fast attack and an exponential decay, which is what the Python original uses
 * (`C:\iot\Hannah`, `core/hannah/tts.py` `_synthesize_confirmation_tone`).
 */

/** Mono 16-bit signed little-endian PCM, like every other audio path in this adapter. */
export interface Tone {
    pcm: Buffer;
    sampleRate: number;
}

export interface ToneOptions {
    /** Hz. The default is an E6 — high enough to cut through, short enough not to annoy. */
    freq?: number;
    /** Seconds. */
    duration?: number;
    /** 0…1, relative to full scale. */
    volume?: number;
    sampleRate?: number;
}

/** Build the confirmation beep. Deterministic: the same options always give the same bytes. */
export function confirmationTone(opts: ToneOptions = {}): Tone {
    const sampleRate = opts.sampleRate ?? 24000;
    const duration = Math.max(0.05, opts.duration ?? 0.3);
    const freq = opts.freq ?? 1318.51;
    const volume = Math.max(0, Math.min(1, opts.volume ?? 0.4));
    const attack = 0.01; // a hard start would click
    const samples = Math.round(sampleRate * duration);
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        const t = i / sampleRate;
        const envelope = t < attack ? t / attack : Math.exp((-12 * (t - attack)) / duration);
        const value = Math.round(32767 * volume * envelope * Math.sin(2 * Math.PI * freq * t));
        pcm.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
    }
    return { pcm, sampleRate };
}
