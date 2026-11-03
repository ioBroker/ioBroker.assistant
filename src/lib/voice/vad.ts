/**
 * End-of-speech detection for satellites that stream microphone audio until they are told to stop.
 *
 * The Hannah/UDP protocol has the satellite decide when an utterance ended (`audio_end`), and Wyoming
 * clients send `audio-stop` themselves. ESPHome voice satellites do neither: they keep streaming until
 * the server sends `STT_VAD_END`/`STT_END`, so the decision has to happen here.
 *
 * This is a plain energy gate, not a neural VAD — good enough to close an utterance, and it costs
 * nothing per frame. Speech must first rise above `startLevel`; after that, `silenceMs` worth of frames
 * below `endLevel` ends it. `maxMs` is the hard stop for rooms that are simply loud.
 *
 * Fixed thresholds only work when the microphone level is known, and on a real satellite it is not.
 * Measured on a ThirdReality Voice & Music Assistant: the device plays a wake-acknowledgement chirp
 * into its own microphone that peaks at full scale (RMS ~16000, clipped), while the speech that follows
 * arrives at RMS 358–469 — below the 700 default for `startLevel` and right on the 400 for `endLevel`.
 * That breaks the gate twice over: `sawSpeech` is satisfied by the chirp rather than by any voice, so
 * the "nothing but speech-free audio" guard never fires, and half the real speech frames count as
 * silence, so the utterance can be cut off mid-sentence.
 *
 * Hence two opt-in knobs, both enabled by the ESPHome transport:
 *
 * - `skipMs` drops the leading chirp from the *analysis* only. What reaches STT is cut later, from where
 *   speech was detected minus a margin (`speechAudio.ts`) — a fast speaker may already be talking.
 * - `adaptive` derives the thresholds from a tracked noise floor instead of fixed levels. The floor
 *   follows the quietest frame seen (instant down, very slow up), so it settles on room noise even when
 *   someone starts talking immediately — which a mean or median over a calibration window would not.
 *
 * And one for longer requests: `longSilenceMs` after `longAfterMs` of speech. In a quiet room the silence
 * threshold sits at its minimum, and a voice a few metres away dips below it between syllables — on a
 * ThirdReality speaker a whole "Мессенджер" (0.7 s) stayed under 150. A pause for thought on top of that
 * ended a long request mid-sentence, while short commands should keep closing quickly.
 */

/**
 * A buffer that may be a view onto any `ArrayBufferLike` — what `Buffer.subarray()` and
 * `Buffer.concat()` hand back. Plain `Buffer` (= `Buffer<ArrayBuffer>`) assigns to it, not the reverse.
 */
export type Bytes = Buffer<ArrayBufferLike>;

/** Root-mean-square amplitude (0…32767) of a mono 16-bit signed LE PCM buffer. */
export function rms(pcm: Bytes): number {
    const samples = Math.floor(pcm.length / 2);
    if (!samples) {
        return 0;
    }
    let sum = 0;
    for (let i = 0; i < samples; i++) {
        const value = pcm.readInt16LE(i * 2);
        sum += value * value;
    }
    return Math.sqrt(sum / samples);
}

export interface SpeechDetectorOptions {
    /** Sample rate of the incoming PCM (ESPHome satellites always capture at 16 kHz). */
    sampleRate?: number;
    /** Analysis window; 30 ms is the usual compromise between latency and stability. */
    frameMs?: number;
    /** RMS above which we consider speech to have started. Ignored when `adaptive` is on. */
    startLevel?: number;
    /** RMS below which a frame counts as silence. Ignored when `adaptive` is on. */
    endLevel?: number;
    /** Silence after speech that ends the utterance. */
    silenceMs?: number;
    /**
     * Silence that ends the utterance once the speaker has talked for {@link longAfterMs} (0 = always
     * {@link silenceMs}). Somebody dictating a longer request pauses to think, and a short command should
     * still close fast.
     */
    longSilenceMs?: number;
    /** Speech (from its start to the pause) after which {@link longSilenceMs} applies; 0 = never. */
    longAfterMs?: number;
    /**
     * Sound above the silence threshold needed before a crossing of the speech threshold counts as speech; 0 = the
     * first loud frame does. A click or a knock is over in 100 ms, the shortest "да" takes about 250.
     */
    minSpeechMs?: number;
    /** A candidate start that falls quiet this long before reaching {@link minSpeechMs} is forgotten. */
    speechGapMs?: number;
    /** Hard cap on one utterance, in case the room never falls quiet. */
    maxMs?: number;
    /**
     * Give up when no speech has started this long after the stream began (the skipped lead-in included);
     * 0 = only {@link maxMs}. A false wake would otherwise keep the microphone open for the whole `maxMs`.
     */
    startTimeoutMs?: number;
    /**
     * Leading audio to leave out of the analysis — for devices that chirp into their own microphone
     * when the wake word fires. The audio itself is untouched; this only stops the chirp from being
     * mistaken for speech and from poisoning the noise floor.
     */
    skipMs?: number;
    /** Derive the thresholds from the tracked noise floor instead of using fixed levels. */
    adaptive?: boolean;
    /** Adaptive mode: `startLevel` is at least this, however quiet the room is. */
    minStartLevel?: number;
    /** Adaptive mode: `endLevel` is at least this. */
    minEndLevel?: number;
    /** Adaptive mode: speech threshold as a multiple of the noise floor. */
    startFactor?: number;
    /** Adaptive mode: silence threshold as a multiple of the noise floor. */
    endFactor?: number;
    /** Adaptive mode: settle the noise floor this long before speech may be declared. */
    warmupMs?: number;
}

/** Why an utterance ended: the speaker stopped, we hit the hard cap, or nobody started speaking at all. */
export type SpeechEnd = 'speech-end' | 'timeout' | 'no-speech';

/**
 * Why a recording ended, from the transport's view: what the detector said, the device ending the stream
 * ('stream'), the device going quiet without ending it ('stall'), or the transport's last-resort timer.
 */
export type CaptureEnd = SpeechEnd | 'stream' | 'stall' | 'pipeline-timeout';

/** What the detector made of one recording — for the request trace and the diagnosis recordings. */
export interface VadReport {
    /** Loudest frame, the wake chirp included. */
    peak: number;
    /** Loudest frame after the skipped lead-in. */
    analysedPeak: number;
    noiseFloor: number;
    startLevel: number;
    endLevel: number;
    /** Where speech began, in ms from the start of the recording; absent when it never did. */
    speechStartMs?: number;
    /** Why the recording ended. */
    end?: CaptureEnd;
    /** Sound above the silence threshold since speech started, in ms. */
    voicedMs?: number;
    /** Silence that was needed to end it at that point (longer once the speaker talked for a while). */
    silenceMs?: number;
    /** RMS per 100 ms of the whole recording. */
    levels?: number[];
    /** What went to speech recognition: the recording cut to the speech, and the gain applied to it. */
    stt?: { fromMs: number; toMs: number; gain: number };
}

/**
 * How fast the tracked noise floor may follow a *rising* ambient level, per analysed frame (30 ms).
 * Fast enough that a genuinely noisy room is matched within about a second, slow enough that a voice
 * cannot pull the floor up to its own level before it has been recognised as speech.
 */
const NOISE_RISE = 0.02;

export class SpeechDetector {
    private readonly frameBytes: number;
    private readonly frameMs: number;
    private readonly fixedStart: number;
    private readonly fixedEnd: number;
    private readonly silenceMs: number;
    private readonly longSilenceMs: number;
    private readonly longAfterMs: number;
    private readonly minSpeechMs: number;
    private readonly speechGapMs: number;
    private readonly maxMs: number;
    private readonly startTimeoutMs: number;
    private readonly skipMs: number;
    private readonly adaptive: boolean;
    private readonly minStartLevel: number;
    private readonly minEndLevel: number;
    private readonly startFactor: number;
    private readonly endFactor: number;
    private readonly warmupMs: number;

    private pending: Bytes = Buffer.alloc(0);
    private speechSeen = false;
    private silentMs = 0;
    /** Tracked room level in adaptive mode; null until the first analysed frame. */
    private floor: number | null = null;
    /** Audio seen so far *including* the skipped lead-in, in milliseconds. */
    private elapsedMs = 0;
    /** Start of the frame that crossed {@link startLevel}, in ms from the start of the recording; -1 = not yet. */
    speechStartMs = -1;
    /** A crossing of {@link startLevel} that has not yet lasted {@link minSpeechMs}: its start, -1 = none. */
    private candidateMs = -1;
    /** Quiet since the last loud frame of the candidate. */
    private candidateQuietMs = 0;
    /** Sound above {@link endLevel} since the candidate (and then the speech) started, in ms. */
    voicedMs = 0;
    /** The longest sound that crossed {@link startLevel}, in ms — also one too short to count as speech. */
    longestSoundMs = 0;
    /** Audio analysed so far, in milliseconds (exposed for logging). */
    totalMs = 0;
    /** Loudest frame seen so far (exposed for logging — the usual clue when a mic is mis-configured). */
    peak = 0;
    /**
     * Loudest frame after the skipped lead-in, i.e. without the wake chirp. Compared with {@link startLevel}
     * it tells whether a dropped utterance was silence or a voice that was simply too quiet for the gate.
     */
    analysedPeak = 0;

    constructor({
        sampleRate = 16000,
        frameMs = 30,
        startLevel = 700,
        endLevel = 400,
        silenceMs = 900,
        longSilenceMs = 0,
        longAfterMs = 0,
        minSpeechMs = 0,
        speechGapMs = 300,
        maxMs = 12000,
        startTimeoutMs = 0,
        skipMs = 0,
        adaptive = false,
        minStartLevel = 250,
        minEndLevel = 150,
        startFactor = 3.5,
        endFactor = 2,
        warmupMs = 150,
    }: SpeechDetectorOptions = {}) {
        this.frameBytes = Math.round((sampleRate * frameMs) / 1000) * 2;
        this.frameMs = frameMs;
        this.fixedStart = startLevel;
        this.fixedEnd = endLevel;
        this.silenceMs = silenceMs;
        this.longSilenceMs = longSilenceMs;
        this.longAfterMs = longAfterMs;
        this.minSpeechMs = minSpeechMs;
        this.speechGapMs = speechGapMs;
        this.maxMs = maxMs;
        this.startTimeoutMs = startTimeoutMs;
        this.skipMs = skipMs;
        this.adaptive = adaptive;
        this.minStartLevel = minStartLevel;
        this.minEndLevel = minEndLevel;
        this.startFactor = startFactor;
        this.endFactor = endFactor;
        this.warmupMs = warmupMs;
    }

    /** True once any frame crossed {@link startLevel} — an utterance that never did is room noise. */
    get sawSpeech(): boolean {
        return this.speechSeen;
    }

    /** Tracked room level (adaptive mode), for logging. 0 before the first analysed frame. */
    get noiseFloor(): number {
        return this.floor ?? 0;
    }

    /** Current speech threshold — fixed, or derived from the noise floor in adaptive mode. */
    get startLevel(): number {
        return this.adaptive ? Math.max(this.minStartLevel, (this.floor ?? 0) * this.startFactor) : this.fixedStart;
    }

    /** Current silence threshold. Never above {@link startLevel}, so the gate keeps its hysteresis. */
    get endLevel(): number {
        if (!this.adaptive) {
            return this.fixedEnd;
        }
        return Math.min(this.startLevel, Math.max(this.minEndLevel, (this.floor ?? 0) * this.endFactor));
    }

    /**
     * Silence that ends the utterance right now: {@link silenceMs}, or {@link longSilenceMs} once the speaker
     * has talked for {@link longAfterMs} before the current pause.
     */
    get requiredSilenceMs(): number {
        if (!this.speechSeen || !this.longAfterMs || this.longSilenceMs <= this.silenceMs) {
            return this.silenceMs;
        }
        const spokenMs = this.elapsedMs - this.silentMs - this.speechStartMs;
        return spokenMs >= this.longAfterMs ? this.longSilenceMs : this.silenceMs;
    }

    /** The detector's view of the recording so far. */
    report(): VadReport {
        return {
            peak: Math.round(this.peak),
            analysedPeak: Math.round(this.analysedPeak),
            noiseFloor: Math.round(this.noiseFloor),
            startLevel: Math.round(this.startLevel),
            endLevel: Math.round(this.endLevel),
            speechStartMs: this.speechSeen ? this.speechStartMs : undefined,
            voicedMs: this.speechSeen ? this.voicedMs : undefined,
            silenceMs: this.requiredSilenceMs,
        };
    }

    /** Feed one audio chunk (any size). Returns why the utterance ended, or null to keep listening. */
    push(chunk: Bytes): SpeechEnd | null {
        this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
        let verdict: SpeechEnd | null = null;

        while (this.pending.length >= this.frameBytes) {
            const frame = this.pending.subarray(0, this.frameBytes);
            this.pending = this.pending.subarray(this.frameBytes);
            this.elapsedMs += this.frameMs;

            const level = rms(frame);
            if (level > this.peak) {
                this.peak = level;
            }

            // The device's own wake chirp: loud, clipped, and not speech. Leaving it out of the
            // analysis is what makes `sawSpeech` mean anything, and keeps the noise floor honest.
            if (this.elapsedMs <= this.skipMs) {
                continue;
            }
            this.totalMs += this.frameMs;
            if (level > this.analysedPeak) {
                this.analysedPeak = level;
            }

            if (this.adaptive) {
                // Three rules, each there to defeat a specific way of getting this wrong:
                //  - start at zero, i.e. maximally sensitive. Seeding from the first frame instead
                //    lets someone who talks straight after the wake word install their own voice as
                //    the room's noise floor, which shuts the gate for good — the same trap an average
                //    or median over a calibration window falls into.
                //  - fall instantly, so a room that went quiet is believed at once.
                //  - rise slowly, and not at all once speech has been recognised: otherwise a long
                //    utterance drags the floor, and with it `endLevel`, up to its own level and cuts
                //    itself off mid-sentence. Falling stays on, so the pauses between words still count.
                this.floor =
                    this.floor === null
                        ? 0
                        : level < this.floor
                          ? level
                          : this.speechSeen || this.candidateMs >= 0
                            ? this.floor
                            : this.floor + (level - this.floor) * NOISE_RISE;
                if (this.totalMs < this.warmupMs) {
                    continue; // let the floor settle before anything may count as speech
                }
            }

            if (!this.speechSeen) {
                // A loud frame opens a candidate; it becomes speech once it has lasted `minSpeechMs`, and is
                // forgotten when it falls quiet for `speechGapMs` before that — a click is not a request.
                if (this.candidateMs < 0) {
                    if (level >= this.startLevel) {
                        this.candidateMs = this.elapsedMs - this.frameMs;
                        this.candidateQuietMs = 0;
                        this.voicedMs = this.frameMs;
                        this.longestSoundMs = Math.max(this.longestSoundMs, this.voicedMs);
                    }
                } else if (level >= this.endLevel) {
                    this.voicedMs += this.frameMs;
                    this.candidateQuietMs = 0;
                    this.longestSoundMs = Math.max(this.longestSoundMs, this.voicedMs);
                } else {
                    this.candidateQuietMs += this.frameMs;
                    if (this.candidateQuietMs >= this.speechGapMs) {
                        this.candidateMs = -1;
                        this.voicedMs = 0;
                    }
                }
                if (this.candidateMs >= 0 && this.voicedMs >= this.minSpeechMs) {
                    this.speechSeen = true;
                    this.speechStartMs = this.candidateMs;
                    // A gap inside the candidate already counts towards the end of the utterance.
                    this.silentMs = this.candidateQuietMs;
                }
            } else if (level < this.endLevel) {
                this.silentMs += this.frameMs;
                if (this.silentMs >= this.requiredSilenceMs) {
                    verdict ||= 'speech-end';
                }
            } else {
                this.silentMs = 0;
                this.voicedMs += this.frameMs;
            }

            if (!this.speechSeen && this.startTimeoutMs > 0 && this.elapsedMs >= this.startTimeoutMs) {
                verdict ||= 'no-speech';
            }
            if (this.totalMs >= this.maxMs) {
                verdict ||= 'timeout';
            }
        }
        return verdict;
    }
}
