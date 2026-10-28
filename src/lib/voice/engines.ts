/**
 * Factory that builds the configured STT/TTS engine. Cloud engines (OpenAI/Azure/AWS) use resolved
 * credentials; local engines (Vosk/Piper) download their models on demand into the data dir.
 * Adding a provider = one new engine class + one `case` here.
 */
import { OpenAiStt, type SttEngine } from './stt';
import { OpenAiTts, type OpenAiVoice, type TtsEngine } from './tts';
import { AzureStt, AzureTts, listAzureVoices } from './azure';
import { AwsStt, AwsTts, listPollyVoices, type AwsCreds } from './aws';
import { VoskStt, listVoskModels } from './vosk';
import { PiperTts, listPiperVoices } from './piper';
import {
    OpenRouterStt,
    OpenRouterTts,
    listOpenRouterSpeechModels,
    voicesForLanguage,
    DEFAULT_OPENROUTER_TTS_MODEL,
    type AudioDecoder,
} from './openrouter';
import * as path from 'node:path';

import { CachedTts } from './ttsCache';
import { FallbackStt, FallbackTts, type NamedEngine } from './fallback';
import { isoToLocale } from './lang';
import type { VoiceLogger } from './download';

export type SpeechProvider = 'openai' | 'openrouter' | 'azure' | 'aws' | 'vosk' | 'piper';

/** All speech credentials, resolved from config (or the central credential store). */
export interface VoiceCredentials {
    openaiKey: string;
    openrouterKey: string;
    azureKey: string;
    azureRegion: string;
    aws: AwsCreds;
}

/** Provider-specific voice ids (each provider names voices differently). */
export interface VoiceNames {
    openai: string; // alloy/echo/…
    azure: string; // e.g. de-DE-KatjaNeural
    aws: string; // e.g. Vicki
    piper: string; // e.g. de_DE-thorsten-medium
    openrouter: string; // depends on the model, e.g. Kore, george
}

/** Everything the factory needs to build any engine. */
export interface EngineContext {
    creds: VoiceCredentials;
    voices: VoiceNames;
    /** Optional second engine, used when the primary one fails ('' = none). */
    sttFallback?: SpeechProvider | '';
    ttsFallback?: SpeechProvider | '';
    /** Writable instance data dir (for the local engines' downloads). */
    dataDir: string;
    log: VoiceLogger;
    /** Local model overrides ('' → default per language). */
    voskModel: string;
    /** OpenAI STT model ('' → 'whisper-1'; e.g. 'gpt-4o-transcribe'). */
    sttModel: string;
    /** OpenAI TTS model ('' → 'tts-1'; e.g. 'gpt-4o-mini-tts'). */
    ttsModel: string;
    /** OpenRouter models ('' → the defaults of openrouter.ts) */
    openrouterSttModel: string;
    openrouterTtsModel: string;
    /** Decoder for compressed speech (OpenRouter models that only return mp3); absent → those models fail */
    decodeAudio?: AudioDecoder;
}

function requireAzure(creds: VoiceCredentials): void {
    if (!creds.azureKey || !creds.azureRegion) {
        throw new Error('Azure speech needs a subscription key and region');
    }
}

function requireAws(creds: VoiceCredentials): void {
    if (!creds.aws.accessKeyId || !creds.aws.secretAccessKey || !creds.aws.region) {
        throw new Error('AWS speech needs an access key id, secret access key and region');
    }
}

function requireOpenAi(creds: VoiceCredentials): void {
    if (!creds.openaiKey) {
        throw new Error('OpenAI speech needs an API key');
    }
}

function requireOpenRouter(creds: VoiceCredentials): void {
    if (!creds.openrouterKey) {
        throw new Error('OpenRouter speech needs an API key');
    }
}

export function createSttEngine(provider: SpeechProvider, ctx: EngineContext): SttEngine {
    const primary: NamedEngine<SttEngine> = { name: provider, engine: buildSttEngine(provider, ctx) };
    const fallback = ctx.sttFallback && ctx.sttFallback !== provider ? ctx.sttFallback : '';
    if (!fallback) {
        return primary.engine;
    }
    try {
        return new FallbackStt([primary, { name: fallback, engine: buildSttEngine(fallback, ctx) }], ctx.log);
    } catch (e) {
        ctx.log.warn(`Speech-to-text fallback '${fallback}' unavailable: ${(e as Error).message}`);
        return primary.engine;
    }
}

function buildSttEngine(provider: SpeechProvider, ctx: EngineContext): SttEngine {
    switch (provider) {
        case 'azure':
            requireAzure(ctx.creds);
            return new AzureStt(ctx.creds.azureKey, ctx.creds.azureRegion);
        case 'aws':
            requireAws(ctx.creds);
            return new AwsStt(ctx.creds.aws);
        case 'vosk':
            return new VoskStt(ctx.dataDir, ctx.voskModel, ctx.log);
        case 'openrouter':
            requireOpenRouter(ctx.creds);
            return new OpenRouterStt(ctx.creds.openrouterKey, ctx.openrouterSttModel);
        case 'piper':
            throw new Error('Piper is a text-to-speech engine, not speech-to-text');
        default:
            requireOpenAi(ctx.creds);
            return new OpenAiStt(ctx.creds.openaiKey, ctx.sttModel || undefined);
    }
}

export function createTtsEngine(provider: SpeechProvider, ctx: EngineContext): TtsEngine {
    // Each engine gets the shared behaviour (disk cache, length limit, SSML) and its own cache directory,
    // so a fallback engine's voice can never be served later while the primary one is healthy again.
    const primary: NamedEngine<TtsEngine> = { name: provider, engine: cachedTts(provider, ctx) };
    const fallback = ctx.ttsFallback && ctx.ttsFallback !== provider ? ctx.ttsFallback : '';
    if (!fallback) {
        return primary.engine;
    }
    try {
        return new FallbackTts([primary, { name: fallback, engine: cachedTts(fallback, ctx) }], ctx.log);
    } catch (e) {
        // A fallback that cannot even be built (missing key, wrong provider) must not take the main one down.
        ctx.log.warn(`Text-to-speech fallback '${fallback}' unavailable: ${(e as Error).message}`);
        return primary.engine;
    }
}

/**
 * One provider binding plus the shared cache/length/SSML layer. One cache directory per provider+voice —
 * a voice change must not serve audio in the old voice.
 */
function cachedTts(provider: SpeechProvider, ctx: EngineContext): TtsEngine {
    const voice =
        provider === 'azure'
            ? ctx.voices.azure
            : provider === 'aws'
              ? ctx.voices.aws
              : provider === 'piper'
                ? ctx.voices.piper
                : provider === 'openrouter'
                  ? `${ctx.openrouterTtsModel || DEFAULT_OPENROUTER_TTS_MODEL}-${ctx.voices.openrouter}`
                  : ctx.voices.openai;
    const dir = path.join(ctx.dataDir, 'ttscache', `${provider}-${(voice || 'default').replace(/[^\w.-]/g, '_')}`);
    return new CachedTts(buildTtsEngine(provider, ctx), { dir, log: ctx.log });
}

function buildTtsEngine(provider: SpeechProvider, ctx: EngineContext): TtsEngine {
    switch (provider) {
        case 'azure':
            requireAzure(ctx.creds);
            return new AzureTts(ctx.creds.azureKey, ctx.creds.azureRegion, ctx.voices.azure);
        case 'aws':
            requireAws(ctx.creds);
            return new AwsTts(ctx.creds.aws, ctx.voices.aws);
        case 'piper':
            return new PiperTts(ctx.dataDir, ctx.voices.piper, ctx.log);
        case 'vosk':
            throw new Error('Vosk is a speech-to-text engine, not text-to-speech');
        case 'openrouter':
            requireOpenRouter(ctx.creds);
            return new OpenRouterTts(
                ctx.creds.openrouterKey,
                ctx.openrouterTtsModel,
                ctx.voices.openrouter,
                ctx.decodeAudio,
            );
        default:
            requireOpenAi(ctx.creds);
            return new OpenAiTts(
                ctx.creds.openaiKey,
                (ctx.voices.openai || 'alloy') as OpenAiVoice,
                ctx.ttsModel || undefined,
            );
    }
}

/** OpenAI TTS voices are a fixed set (no list API). */
const OPENAI_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

/** List the available TTS voices for a provider (for the settings voice dropdown). */
export async function listVoices(provider: SpeechProvider, ctx: EngineContext, language: string): Promise<string[]> {
    switch (provider) {
        case 'azure':
            requireAzure(ctx.creds);
            return listAzureVoices(ctx.creds.azureKey, ctx.creds.azureRegion, isoToLocale(language));
        case 'aws':
            requireAws(ctx.creds);
            return listPollyVoices(ctx.creds.aws, isoToLocale(language));
        case 'piper':
            return listPiperVoices();
        case 'openrouter': {
            // public list, no key needed: the voices of the chosen model
            const model = ctx.openrouterTtsModel || DEFAULT_OPENROUTER_TTS_MODEL;
            const models = await listOpenRouterSpeechModels('speech');
            return voicesForLanguage(models.find(m => m.id === model)?.voices || [], language);
        }
        default:
            return OPENAI_VOICES;
    }
}

/** Suggested STT model names for the settings dropdown: the local Vosk catalogue, or the models of OpenRouter. */
export async function listSttModels(provider: SpeechProvider, language: string): Promise<string[]> {
    if (provider === 'openrouter') {
        return (await listOpenRouterSpeechModels('transcription')).map(m => m.id);
    }
    return provider === 'vosk' ? listVoskModels(language) : [];
}

/** TTS model names for the settings dropdown — only OpenRouter has a choice worth listing. */
export async function listTtsModels(provider: SpeechProvider): Promise<string[]> {
    return provider === 'openrouter' ? (await listOpenRouterSpeechModels('speech')).map(m => m.id) : [];
}
