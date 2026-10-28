/**
 * Speech over OpenRouter: one key for the speech-to-text and text-to-speech models of many vendors (OpenAI,
 * ElevenLabs, Google, Deepgram, Mistral …) behind the OpenAI audio API at https://openrouter.ai/api/v1.
 * Model ids carry the vendor (`openai/whisper-large-v3-turbo`), and the voices depend on the model — the public
 * model list names them (`supported_voices`), so the settings offer exactly the voices of the chosen model.
 *
 * Differences to OpenAI itself: transcription ignores `prompt` (no vocabulary hints), and speech comes back as
 * `pcm` (most models, the default) or `mp3` (MiniMax only). The PCM rate is not part of the API — OpenRouter
 * documents 24 kHz, the rate of OpenAI, Gemini and Azure — so a rate in the content type wins over that default.
 */
import OpenAI, { toFile } from 'openai';
import { OPENROUTER_HEADERS, PROVIDER_PRESETS } from '../llm';
import { pcmToWav, type SttEngine } from './stt';
import type { TtsEngine, TtsResult } from './tts';

/** Speech-to-text model when none is configured: Whisper large v3 turbo, multilingual and the cheapest Whisper */
export const DEFAULT_OPENROUTER_STT_MODEL = 'openai/whisper-large-v3-turbo';
/**
 * Text-to-speech model when none is configured: multilingual, PCM (no decoder needed) and fast — in a test about
 * 0.8 s for a sentence where Gemini TTS took 2.5 s, which a spoken answer waits for.
 */
export const DEFAULT_OPENROUTER_TTS_MODEL = 'elevenlabs/eleven-flash-v2.5';

/** Rate of the PCM OpenRouter returns when the content type does not say otherwise */
const PCM_RATE = 24000;

/** Vendors whose speech models only return mp3 (they answer `pcm` with a 400) */
const MP3_ONLY = ['minimax/'];

/** How long the public model list is kept */
const MODEL_LIST_TTL_MS = 60 * 60 * 1000;

/** Decode compressed audio (mp3) to mono 16-bit PCM — ffmpeg in the adapter */
export type AudioDecoder = (audio: Buffer) => Promise<TtsResult>;

/** A speech model of OpenRouter */
export interface OpenRouterSpeechModel {
    id: string;
    name: string;
    /** Voices of a text-to-speech model, empty when the model names none */
    voices: string[];
}

function client(apiKey: string): OpenAI {
    return new OpenAI({ apiKey, baseURL: PROVIDER_PRESETS.openrouter.baseUrl, defaultHeaders: OPENROUTER_HEADERS });
}

const modelLists = new Map<string, { at: number; models: Promise<OpenRouterSpeechModel[]> }>();

/**
 * The speech models of OpenRouter. The list is public (no key), cached for an hour; a failed request is not kept.
 *
 * @param kind `speech` = text-to-speech, `transcription` = speech-to-text
 * @param fetchImpl fetch (tests)
 */
export function listOpenRouterSpeechModels(
    kind: 'speech' | 'transcription',
    fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterSpeechModel[]> {
    const cached = modelLists.get(kind);
    if (cached && Date.now() - cached.at < MODEL_LIST_TTL_MS) {
        return cached.models;
    }
    const models = (async () => {
        const res = await fetchImpl(`${PROVIDER_PRESETS.openrouter.baseUrl}/models?output_modalities=${kind}`, {
            headers: OPENROUTER_HEADERS,
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            throw new Error(`OpenRouter model list: HTTP ${res.status}`);
        }
        const body = (await res.json()) as { data?: { id?: unknown; name?: unknown; supported_voices?: unknown }[] };
        return (body.data || [])
            .filter(m => typeof m.id === 'string' && m.id)
            .map(m => ({
                id: m.id as string,
                name: typeof m.name === 'string' ? m.name : (m.id as string),
                voices: Array.isArray(m.supported_voices)
                    ? m.supported_voices.filter((v): v is string => typeof v === 'string')
                    : [],
            }));
    })();
    modelLists.set(kind, { at: Date.now(), models });
    models.catch(() => modelLists.delete(kind));
    return models;
}

/**
 * The voices of a text-to-speech model. Voices named after a locale (`de-DE-Klaus:MAI-Voice-2`) are narrowed to
 * the language, if that leaves any; other names (`Kore`, `george`) say nothing about the language.
 *
 * @param voices the voices of the model
 * @param language ISO-639-1 language ('' = all)
 */
export function voicesForLanguage(voices: string[], language: string): string[] {
    const lang = (language || '').split('-')[0].toLowerCase();
    if (!lang) {
        return voices;
    }
    const matching = voices.filter(v => new RegExp(`^${lang}[-_][A-Z]{2}\\b`).test(v));
    return matching.length ? matching : voices;
}

/**
 * Raw PCM out of a speech response: WAV is unwrapped, the rate comes from the content type (`audio/pcm;rate=…`)
 * or is the documented 24 kHz.
 *
 * @param audio the response body
 * @param contentType the content type of the response
 */
export function pcmFromResponse(audio: Buffer, contentType: string): TtsResult {
    if (audio.length > 44 && audio.toString('latin1', 0, 4) === 'RIFF' && audio.toString('latin1', 8, 12) === 'WAVE') {
        const sampleRate = audio.readUInt32LE(24);
        // the data chunk is not always right after the 16-byte fmt chunk
        let offset = 12;
        while (offset + 8 <= audio.length) {
            const id = audio.toString('latin1', offset, offset + 4);
            const size = audio.readUInt32LE(offset + 4);
            if (id === 'data') {
                return { pcm: audio.subarray(offset + 8, Math.min(audio.length, offset + 8 + size)), sampleRate };
            }
            offset += 8 + size + (size % 2);
        }
        return { pcm: audio.subarray(44), sampleRate };
    }
    const rate = /(?:^|[;\s])(?:rate|sample_?rate)=(\d+)/i.exec(contentType || '');
    return { pcm: audio, sampleRate: rate ? Number(rate[1]) : PCM_RATE };
}

/** Speech-to-text over OpenRouter (OpenAI-compatible multipart upload) */
export class OpenRouterStt implements SttEngine {
    private readonly client: OpenAI;
    private readonly model: string;

    constructor(apiKey: string, model = '') {
        this.client = client(apiKey);
        this.model = model || DEFAULT_OPENROUTER_STT_MODEL;
    }

    async transcribe(pcm: Buffer, sampleRate: number, lang: string): Promise<string> {
        const file = await toFile(pcmToWav(pcm, sampleRate), 'audio.wav', { type: 'audio/wav' });
        // no vocabulary hints: OpenRouter accepts `prompt`, but ignores it
        const res = await this.client.audio.transcriptions.create({
            file,
            model: this.model,
            language: (lang || '').split('-')[0] || undefined,
        });
        return (res.text || '').trim();
    }
}

/** Text-to-speech over OpenRouter */
export class OpenRouterTts implements TtsEngine {
    private readonly client: OpenAI;
    private readonly model: string;
    private readonly voice: string;
    private readonly decode?: AudioDecoder;
    private readonly fetchImpl?: typeof fetch;

    /**
     * @param apiKey OpenRouter key
     * @param model model id ('' = {@link DEFAULT_OPENROUTER_TTS_MODEL})
     * @param voice voice of the model ('' = the first voice of the model for the language)
     * @param decode decoder for the models that only return mp3
     * @param fetchImpl fetch for the model list (tests)
     */
    constructor(apiKey: string, model = '', voice = '', decode?: AudioDecoder, fetchImpl?: typeof fetch) {
        this.client = client(apiKey);
        this.model = model || DEFAULT_OPENROUTER_TTS_MODEL;
        this.voice = voice;
        this.decode = decode;
        this.fetchImpl = fetchImpl;
    }

    /** The configured voice, or the first one the model offers for the language — most models need a voice */
    private async voiceFor(lang: string): Promise<string> {
        if (this.voice) {
            return this.voice;
        }
        try {
            const models = await listOpenRouterSpeechModels('speech', this.fetchImpl);
            const voices = models.find(m => m.id === this.model)?.voices || [];
            return voicesForLanguage(voices, lang)[0] || '';
        } catch {
            return '';
        }
    }

    async synthesize(text: string, lang: string): Promise<TtsResult> {
        const mp3 = MP3_ONLY.some(prefix => this.model.startsWith(prefix));
        if (mp3 && !this.decode) {
            throw new Error(`${this.model} only returns mp3, which needs ffmpeg`);
        }
        const voice = await this.voiceFor(lang);
        const res = await this.client.audio.speech.create({
            model: this.model,
            input: text,
            // `voice` is required by the OpenAI types; an empty one is left out (a model with a default voice)
            ...(voice ? { voice } : {}),
            response_format: mp3 ? 'mp3' : 'pcm',
        } as OpenAI.Audio.SpeechCreateParams);
        const audio = Buffer.from(await res.arrayBuffer());
        if (mp3) {
            return this.decode!(audio);
        }
        return pcmFromResponse(audio, res.headers.get('content-type') || '');
    }
}
