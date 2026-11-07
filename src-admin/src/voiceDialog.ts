/**
 * Dialog mode of the chat: the microphone stays open, and everything said becomes a question.
 *
 * The end of an utterance is found here, in the browser — an energy gate like the one the adapter uses for ESPHome
 * satellites (src/lib/voice/vad.ts): a noise floor that follows the room, a candidate that must last
 * {@link DetectorOptions.minSpeechMs} before it counts as speech (a click or a cough does not), and a pause that ends
 * it. The utterance goes to the assistant as 16-kHz PCM and is recognised by the STT engine of the Voice tab.
 *
 * Half duplex: while the answer is found and read aloud the microphone is not listened to, otherwise the assistant
 * would hear — and answer — itself. Echo cancellation of the browser is on, but it does not catch every speaker.
 */

/** Rate of the PCM sent to the assistant (what the satellites send). */
export const DIALOG_RATE = 16000;
const FRAME_MS = 30;
const FRAME = (DIALOG_RATE * FRAME_MS) / 1000;
/** How fast the noise floor may follow a rising room level, per frame (as in the adapter). */
const NOISE_RISE = 0.02;
/** After an answer was read aloud: the room is still ringing. */
const RESUME_MS = 400;

export interface DetectorOptions {
    /** Speech threshold, at least this however quiet the room is (16-bit RMS). */
    minStartLevel: number;
    /** Silence threshold, at least this. */
    minEndLevel: number;
    /** Speech threshold as a multiple of the noise floor. */
    startFactor: number;
    /** Silence threshold as a multiple of the noise floor. */
    endFactor: number;
    /** Silence that ends an utterance. */
    silenceMs: number;
    /** Silence that ends it once the speaker has talked for {@link longAfterMs} — longer requests have pauses. */
    longSilenceMs: number;
    longAfterMs: number;
    /** Sound needed before a loud frame counts as the start of speech. */
    minSpeechMs: number;
    /** A candidate that falls quiet this long before {@link minSpeechMs} is forgotten. */
    speechGapMs: number;
    /** Hard cap on one utterance. */
    maxMs: number;
    /** Audio before the start of speech that goes along (the first syllable starts below the threshold). */
    preRollMs: number;
    /** Silence after the speech that goes along. */
    tailMs: number;
    /** Frames to settle the noise floor before anything counts as speech. */
    warmupMs: number;
}

/**
 * Levels for a browser microphone: echo cancellation, noise suppression and automatic gain are on, so the room is
 * near zero and a voice at normal distance reaches RMS 1000–8000.
 */
export const BROWSER_DETECTOR: DetectorOptions = {
    minStartLevel: 400,
    minEndLevel: 240,
    startFactor: 3.5,
    endFactor: 2,
    silenceMs: 1000,
    longSilenceMs: 1600,
    longAfterMs: 2500,
    minSpeechMs: 250,
    speechGapMs: 300,
    maxMs: 30000,
    preRollMs: 400,
    tailMs: 300,
    warmupMs: 150,
};

function frameRms(frame: Int16Array): number {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) {
        sum += frame[i] * frame[i];
    }
    return Math.sqrt(sum / frame.length);
}

/** Finds utterances in a stream of 16-kHz PCM. */
export class UtteranceDetector {
    private readonly opts: DetectorOptions;
    private pending = new Int16Array(0);
    private floor: number | null = null;
    private seenMs = 0;
    /** Frames before a candidate, for the pre-roll. */
    private history: Int16Array[] = [];
    /** Frames of the candidate or utterance; null = none. */
    private frames: Int16Array[] | null = null;
    private speech = false;
    private voicedMs = 0;
    private quietMs = 0;
    /** Frames of the current utterance from the start of speech, without the pre-roll. */
    private spokenMs = 0;
    /** RMS of the last frame. */
    level = 0;

    constructor(opts: Partial<DetectorOptions> = {}) {
        this.opts = { ...BROWSER_DETECTOR, ...opts };
    }

    get startLevel(): number {
        return Math.max(this.opts.minStartLevel, (this.floor ?? 0) * this.opts.startFactor);
    }

    get endLevel(): number {
        return Math.min(this.startLevel, Math.max(this.opts.minEndLevel, (this.floor ?? 0) * this.opts.endFactor));
    }

    /** Something loud is going on: a candidate or speech. */
    get hearing(): boolean {
        return this.frames !== null;
    }

    /** Forget the audio, keep the noise floor (after an answer the room is the same). */
    reset(): void {
        this.pending = new Int16Array(0);
        this.history = [];
        this.frames = null;
        this.speech = false;
        this.voicedMs = 0;
        this.quietMs = 0;
        this.spokenMs = 0;
        this.level = 0;
    }

    /** Feed PCM of any length; returns an utterance when one ended. */
    push(pcm: Int16Array): Int16Array | null {
        let input = pcm;
        if (this.pending.length) {
            input = new Int16Array(this.pending.length + pcm.length);
            input.set(this.pending);
            input.set(pcm, this.pending.length);
        }
        let offset = 0;
        let result: Int16Array | null = null;
        while (input.length - offset >= FRAME) {
            const frame = input.slice(offset, offset + FRAME);
            offset += FRAME;
            result = this.frame(frame) || result;
        }
        this.pending = input.slice(offset);
        return result;
    }

    private frame(frame: Int16Array): Int16Array | null {
        const o = this.opts;
        const level = frameRms(frame);
        this.level = level;
        this.seenMs += FRAME_MS;
        // the floor falls at once, rises slowly — and not while something is being heard (see vad.ts)
        this.floor =
            this.floor === null
                ? 0
                : level < this.floor
                  ? level
                  : this.frames
                    ? this.floor
                    : this.floor + (level - this.floor) * NOISE_RISE;

        if (!this.frames) {
            this.history.push(frame);
            if (this.history.length > Math.ceil(o.preRollMs / FRAME_MS) + 1) {
                this.history.shift();
            }
            if (this.seenMs >= o.warmupMs && level >= this.startLevel) {
                // the loud frame is the last one of the history
                this.frames = this.history;
                this.history = [];
                this.voicedMs = FRAME_MS;
                this.quietMs = 0;
            }
            return null;
        }

        this.frames.push(frame);
        const loud = level >= this.endLevel;
        if (!this.speech) {
            if (loud) {
                this.voicedMs += FRAME_MS;
                this.quietMs = 0;
            } else {
                this.quietMs += FRAME_MS;
                if (this.quietMs >= o.speechGapMs) {
                    // a click, a knock: forget it, keep its end as history
                    this.history = this.frames.slice(-(Math.ceil(o.preRollMs / FRAME_MS) + 1));
                    this.frames = null;
                    return null;
                }
            }
            if (this.voicedMs >= o.minSpeechMs) {
                this.speech = true;
                this.spokenMs = this.voicedMs + this.quietMs;
            }
            return null;
        }

        this.spokenMs += FRAME_MS;
        if (loud) {
            this.quietMs = 0;
        } else {
            this.quietMs += FRAME_MS;
        }
        const talkedMs = this.spokenMs - this.quietMs;
        const needed = o.longAfterMs && talkedMs >= o.longAfterMs ? o.longSilenceMs : o.silenceMs;
        if (this.quietMs >= needed || this.spokenMs >= o.maxMs) {
            const drop = Math.max(0, Math.floor((this.quietMs - o.tailMs) / FRAME_MS));
            const frames = this.frames.slice(0, this.frames.length - drop);
            this.reset();
            return concat(frames);
        }
        return null;
    }
}

function concat(frames: Int16Array[]): Int16Array {
    const out = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of frames) {
        out.set(f, at);
        at += f.length;
    }
    return out;
}

/** Float samples at the rate of the audio context → 16-bit PCM at {@link DIALOG_RATE}, chunk by chunk. */
export class Resampler {
    /** Input position of the next output sample, relative to the start of the next chunk (−1 … 0 = between chunks). */
    private pos = 0;
    private last = 0;
    private readonly ratio: number;

    constructor(inputRate: number) {
        this.ratio = inputRate / DIALOG_RATE;
    }

    process(input: Float32Array): Int16Array {
        const out = new Int16Array(Math.ceil((input.length + 1) / this.ratio) + 1);
        let n = 0;
        while (this.pos < input.length - 1) {
            const j = Math.floor(this.pos);
            const a = j < 0 ? this.last : input[j];
            const b = input[j + 1];
            const v = a + (b - a) * (this.pos - j);
            out[n++] = Math.round(Math.max(-1, Math.min(1, v)) * 0x7fff);
            this.pos += this.ratio;
        }
        this.pos -= input.length;
        this.last = input.length ? input[input.length - 1] : this.last;
        return out.subarray(0, n);
    }
}

export function pcmToBase64(pcm: Int16Array): string {
    // PCM is little-endian on the wire; every browser runs little-endian
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

export interface DialogHandlers {
    /** An utterance ended; the microphone is not listened to until the returned promise settles. */
    onUtterance(pcm: Int16Array): Promise<void>;
    /** Level of the microphone (0…1 of the speech threshold, capped at 1) and whether something is heard. */
    onLevel?(level: number, hearing: boolean): void;
}

/** The open microphone of the dialog mode. */
export class VoiceDialog {
    private context: AudioContext | null = null;
    private stream: MediaStream | null = null;
    private node: ScriptProcessorNode | null = null;
    private resampler: Resampler | null = null;
    private readonly detector = new UtteranceDetector();
    private busy = false;
    private resumeAt = 0;
    private stopped = false;

    constructor(private readonly handlers: DialogHandlers) {}

    static get supported(): boolean {
        return typeof window !== 'undefined' && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
    }

    async start(): Promise<void> {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
        if (this.stopped) {
            stream.getTracks().forEach(track => track.stop());
            return;
        }
        const context = new AudioContext();
        if (context.state === 'suspended') {
            await context.resume();
        }
        const source = context.createMediaStreamSource(stream);
        // ScriptProcessor: deprecated, but available everywhere and without a separate worklet file
        const node = context.createScriptProcessor(2048, 1, 1);
        this.resampler = new Resampler(context.sampleRate);
        node.onaudioprocess = e => this.onAudio(e.inputBuffer.getChannelData(0));
        source.connect(node);
        node.connect(context.destination); // Chrome runs a processor only when it is connected; its output is silence
        this.context = context;
        this.stream = stream;
        this.node = node;
    }

    stop(): void {
        this.stopped = true;
        if (this.node) {
            this.node.onaudioprocess = null;
            this.node.disconnect();
        }
        this.stream?.getTracks().forEach(track => track.stop());
        void this.context?.close().catch(() => {});
        this.node = null;
        this.stream = null;
        this.context = null;
    }

    private onAudio(data: Float32Array): void {
        if (this.stopped || !this.resampler) {
            return;
        }
        const pcm = this.resampler.process(data);
        if (this.busy || Date.now() < this.resumeAt) {
            return;
        }
        const utterance = this.detector.push(pcm);
        this.handlers.onLevel?.(Math.min(1, this.detector.level / this.detector.startLevel), this.detector.hearing);
        if (!utterance) {
            return;
        }
        this.busy = true;
        this.handlers.onLevel?.(0, false);
        this.handlers
            .onUtterance(utterance)
            .catch(() => {})
            .finally(() => {
                this.busy = false;
                this.resumeAt = Date.now() + RESUME_MS;
                this.detector.reset();
            });
    }
}
