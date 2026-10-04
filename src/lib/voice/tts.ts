/**
 * Text-to-speech engines. V1 ships the cloud engine (OpenAI TTS); local engines
 * (Piper / Wyoming) plug in behind the same `TtsEngine` interface later.
 */
import OpenAI from 'openai';

export interface TtsResult {
    /** Raw mono 16-bit signed LE PCM. */
    pcm: Buffer;
    sampleRate: number;
}

export interface TtsEngine {
    synthesize(text: string, lang: string): Promise<TtsResult>;
    /**
     * Speak SSML (`<speak>…</speak>`) — only implemented by engines that understand it (Azure, Polly).
     * Callers go through `CachedTts`, which strips the markup for the engines that do not.
     */
    synthesizeSsml?(ssml: string, lang: string): Promise<TtsResult>;
    /** Optional warm-up (install/download engine + voice for `lang`) so the first request isn't slow. */
    prepare?(lang: string): Promise<void>;
    /**
     * Pre-synthesise phrases into whatever cache this engine has, returning how many were added.
     * Implemented by `CachedTts`; absent on a bare provider binding.
     */
    warm?(phrases: string[], lang: string): Promise<number>;
}

/** OpenAI TTS voice ids. */
export type OpenAiVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';

/**
 * Cloud TTS via the OpenAI speech API. Requests `pcm` output — 24 kHz mono 16-bit signed LE —
 * so no client-side decoding is needed; the satellite resamples to its speaker rate.
 */
export class OpenAiTts implements TtsEngine {
    private readonly client: OpenAI;
    private readonly voice: OpenAiVoice;
    private readonly model: string;

    constructor(apiKey: string, voice: OpenAiVoice = 'alloy', model = 'tts-1') {
        this.client = new OpenAI({ apiKey });
        this.voice = voice;
        this.model = model;
    }

    async synthesize(text: string, _lang: string): Promise<TtsResult> {
        const resp = await this.client.audio.speech.create({
            model: this.model,
            voice: this.voice,
            input: text,
            response_format: 'pcm',
        });
        return { pcm: Buffer.from(await resp.arrayBuffer()), sampleRate: 24000 };
    }
}
