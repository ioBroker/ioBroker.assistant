/**
 * Speech-to-text engines. V1 ships the cloud engine (OpenAI Whisper); local engines
 * (Vosk / whisper.cpp / Wyoming) plug in behind the same `SttEngine` interface later.
 */
import OpenAI, { toFile } from 'openai';

export interface SttEngine {
    /** Transcribe raw mono 16-bit PCM. `lang` is an ISO-639-1 hint ('' = auto-detect). */
    transcribe(pcm: Buffer, sampleRate: number, lang: string): Promise<string>;
}

/** Wrap raw mono 16-bit-signed-LE PCM into a minimal 44-byte WAV container. */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
    const numChannels = 1;
    const bitsPerSample = 16;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const byteRate = sampleRate * blockAlign;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // PCM fmt chunk size
    header.writeUInt16LE(1, 20); // audio format = PCM
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

/** Cloud STT via the OpenAI transcription API (Whisper). */
export class OpenAiStt implements SttEngine {
    private readonly client: OpenAI;
    private readonly model: string;

    constructor(apiKey: string, model = 'whisper-1') {
        this.client = new OpenAI({ apiKey });
        this.model = model;
    }

    async transcribe(pcm: Buffer, sampleRate: number, lang: string): Promise<string> {
        const file = await toFile(pcmToWav(pcm, sampleRate), 'audio.wav', { type: 'audio/wav' });
        const res = await this.client.audio.transcriptions.create({
            file,
            model: this.model,
            // Whisper wants the bare ISO-639-1 code; strip any region (de-DE → de). '' → auto-detect.
            language: (lang || '').split('-')[0] || undefined,
        });
        return (res.text || '').trim();
    }
}
