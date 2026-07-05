/**
 * AWS speech engines: STT via Amazon Transcribe (streaming) and TTS via Amazon Polly.
 * Credentials: accessKeyId + secretAccessKey + region.
 */
import {
    PollyClient,
    SynthesizeSpeechCommand,
    DescribeVoicesCommand,
    type VoiceId,
    type LanguageCode as PollyLanguageCode,
} from '@aws-sdk/client-polly';
import {
    TranscribeStreamingClient,
    StartStreamTranscriptionCommand,
    type AudioStream,
    type LanguageCode,
} from '@aws-sdk/client-transcribe-streaming';
import { isoToLocale } from './lang';
import type { SttEngine } from './stt';
import type { TtsEngine, TtsResult } from './tts';

export interface AwsCreds {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
}

/** Reasonable default Polly voice per language when none is configured. */
const DEFAULT_POLLY_VOICE: Record<string, string> = {
    de: 'Vicki',
    en: 'Joanna',
    ru: 'Tatyana',
    fr: 'Lea',
    it: 'Bianca',
    es: 'Lucia',
    nl: 'Laura',
    pl: 'Ewa',
    pt: 'Ines',
};

/** ~100 ms of 16 kHz mono 16-bit PCM per Transcribe audio chunk. */
const STT_CHUNK_BYTES = 3200;

/** List available Polly voice ids, optionally filtered by language (locale, e.g. 'de-DE'). */
export async function listPollyVoices(creds: AwsCreds, languageCode: string): Promise<string[]> {
    const client = new PollyClient({
        region: creds.region,
        credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
    });
    const res = await client.send(
        new DescribeVoicesCommand(languageCode ? { LanguageCode: languageCode as PollyLanguageCode } : {}),
    );
    return (res.Voices || []).map(v => v.Id).filter((id): id is VoiceId => !!id);
}

export class AwsStt implements SttEngine {
    private readonly client: TranscribeStreamingClient;

    constructor(creds: AwsCreds) {
        this.client = new TranscribeStreamingClient({
            region: creds.region,
            credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
        });
    }

    async transcribe(pcm: Buffer, sampleRate: number, lang: string): Promise<string> {
        // Must be an async generator: Transcribe's AudioStream is an AsyncIterable.
        // eslint-disable-next-line @typescript-eslint/require-await
        async function* audio(): AsyncGenerator<AudioStream> {
            for (let off = 0; off < pcm.length; off += STT_CHUNK_BYTES) {
                yield { AudioEvent: { AudioChunk: pcm.subarray(off, off + STT_CHUNK_BYTES) } };
            }
        }

        const resp = await this.client.send(
            new StartStreamTranscriptionCommand({
                LanguageCode: isoToLocale(lang) as LanguageCode,
                MediaSampleRateHertz: sampleRate,
                MediaEncoding: 'pcm',
                AudioStream: audio(),
            }),
        );

        let text = '';
        for await (const event of resp.TranscriptResultStream || []) {
            for (const result of event.TranscriptEvent?.Transcript?.Results || []) {
                const transcript = result.Alternatives?.[0]?.Transcript;
                if (!result.IsPartial && transcript) {
                    text += (text ? ' ' : '') + transcript;
                }
            }
        }
        return text.trim();
    }
}

export class AwsTts implements TtsEngine {
    private readonly client: PollyClient;

    constructor(
        creds: AwsCreds,
        /** Polly VoiceId (e.g. 'Vicki', 'Tatyana'); empty → default per language. */
        private readonly voice: string,
    ) {
        this.client = new PollyClient({
            region: creds.region,
            credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
        });
    }

    async synthesize(text: string, lang: string): Promise<TtsResult> {
        const iso = (lang || 'en').split('-')[0].toLowerCase();
        const voice = this.voice || DEFAULT_POLLY_VOICE[iso] || 'Joanna';
        const resp = await this.client.send(
            new SynthesizeSpeechCommand({
                Text: text,
                OutputFormat: 'pcm', // 16-bit signed 1-channel little-endian
                SampleRate: '16000',
                VoiceId: voice as VoiceId,
            }),
        );
        if (!resp.AudioStream) {
            throw new Error('Polly returned no audio stream');
        }
        const bytes = await resp.AudioStream.transformToByteArray();
        return { pcm: Buffer.from(bytes), sampleRate: 16000 };
    }
}
