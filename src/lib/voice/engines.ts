/**
 * Factory that builds the configured STT/TTS engine. Cloud engines (OpenAI/Azure/AWS) use resolved
 * credentials; local engines (Vosk/Piper) download their models on demand into the data dir.
 * Adding a provider = one new engine class + one `case` here.
 */
import { OpenAiStt, type SttEngine } from './stt';
import { OpenAiTts, type OpenAiVoice, type TtsEngine } from './tts';
import { AzureStt, AzureTts, listAzureVoices } from './azure';
import { AwsStt, AwsTts, listPollyVoices, type AwsCreds } from './aws';
import { VoskStt } from './vosk';
import { PiperTts, listPiperVoices } from './piper';
import { isoToLocale } from './lang';
import type { VoiceLogger } from './download';

export type SpeechProvider = 'openai' | 'azure' | 'aws' | 'vosk' | 'piper';

/** All speech credentials, resolved from config (or the central credential store). */
export interface VoiceCredentials {
    openaiKey: string;
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
}

/** Everything the factory needs to build any engine. */
export interface EngineContext {
    creds: VoiceCredentials;
    voices: VoiceNames;
    /** Writable instance data dir (for the local engines' downloads). */
    dataDir: string;
    log: VoiceLogger;
    /** Local model overrides ('' → default per language). */
    voskModel: string;
    /** OpenAI STT model ('' → 'whisper-1'; e.g. 'gpt-4o-transcribe'). */
    sttModel: string;
    /** OpenAI TTS model ('' → 'tts-1'; e.g. 'gpt-4o-mini-tts'). */
    ttsModel: string;
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

export function createSttEngine(provider: SpeechProvider, ctx: EngineContext): SttEngine {
    switch (provider) {
        case 'azure':
            requireAzure(ctx.creds);
            return new AzureStt(ctx.creds.azureKey, ctx.creds.azureRegion);
        case 'aws':
            requireAws(ctx.creds);
            return new AwsStt(ctx.creds.aws);
        case 'vosk':
            return new VoskStt(ctx.dataDir, ctx.voskModel, ctx.log);
        case 'piper':
            throw new Error('Piper is a text-to-speech engine, not speech-to-text');
        default:
            requireOpenAi(ctx.creds);
            return new OpenAiStt(ctx.creds.openaiKey, ctx.sttModel || undefined);
    }
}

export function createTtsEngine(provider: SpeechProvider, ctx: EngineContext): TtsEngine {
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
        default:
            return OPENAI_VOICES;
    }
}
