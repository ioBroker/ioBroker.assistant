/**
 * Azure Cognitive Services Speech engines (STT + TTS).
 * Credentials: a subscription key + region (e.g. 'westeurope').
 */
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { isoToLocale } from './lang';
import type { SttEngine } from './stt';
import type { TtsEngine, TtsResult } from './tts';

/** List available Azure voices (short names like 'de-DE-KatjaNeural'), optionally filtered by locale. */
export async function listAzureVoices(key: string, region: string, locale: string): Promise<string[]> {
    const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
    const synth = new sdk.SpeechSynthesizer(speechConfig, null);
    try {
        const res = await synth.getVoicesAsync(locale || '');
        if (res.reason === sdk.ResultReason.VoicesListRetrieved) {
            return res.voices.map(v => v.shortName);
        }
        throw new Error(res.errorDetails || 'Azure voice list failed');
    } finally {
        synth.close();
    }
}

/** Azure STT via `recognizeOnceAsync` fed from a PCM push stream (one short utterance). */
export class AzureStt implements SttEngine {
    constructor(
        private readonly key: string,
        private readonly region: string,
    ) {}

    async transcribe(pcm: Buffer, sampleRate: number, lang: string): Promise<string> {
        const speechConfig = sdk.SpeechConfig.fromSubscription(this.key, this.region);
        speechConfig.speechRecognitionLanguage = isoToLocale(lang);

        const format = sdk.AudioStreamFormat.getWaveFormatPCM(sampleRate, 16, 1);
        const pushStream = sdk.AudioInputStream.createPushStream(format);
        // The push stream needs a standalone ArrayBuffer (not the pooled Node Buffer view).
        pushStream.write(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer);
        pushStream.close();

        const recognizer = new sdk.SpeechRecognizer(speechConfig, sdk.AudioConfig.fromStreamInput(pushStream));
        try {
            const result = await new Promise<sdk.SpeechRecognitionResult>((resolve, reject) => {
                recognizer.recognizeOnceAsync(resolve, reject);
            });
            if (result.reason === sdk.ResultReason.RecognizedSpeech) {
                return result.text.trim();
            }
            if (result.reason === sdk.ResultReason.Canceled) {
                const details = sdk.CancellationDetails.fromResult(result);
                throw new Error(`Azure STT canceled: ${details.errorDetails || details.reason}`);
            }
            return '';
        } finally {
            recognizer.close();
        }
    }
}

/** Azure TTS to raw 24 kHz mono 16-bit PCM (no server-side playback). */
export class AzureTts implements TtsEngine {
    constructor(
        private readonly key: string,
        private readonly region: string,
        /** Full Azure voice name (e.g. 'de-DE-KatjaNeural'); empty → pick by language. */
        private readonly voice: string,
    ) {}

    async synthesize(text: string, lang: string): Promise<TtsResult> {
        const speechConfig = sdk.SpeechConfig.fromSubscription(this.key, this.region);
        speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm;
        if (this.voice) {
            speechConfig.speechSynthesisVoiceName = this.voice;
        } else {
            speechConfig.speechSynthesisLanguage = isoToLocale(lang);
        }

        // audioConfig=null → synthesise to memory only, no default-speaker output.
        const synth = new sdk.SpeechSynthesizer(speechConfig, null);
        try {
            const result = await new Promise<sdk.SpeechSynthesisResult>((resolve, reject) => {
                synth.speakTextAsync(text, resolve, reject);
            });
            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                return { pcm: Buffer.from(result.audioData), sampleRate: 24000 };
            }
            throw new Error(`Azure TTS failed: ${result.errorDetails || result.reason}`);
        } finally {
            synth.close();
        }
    }
}
