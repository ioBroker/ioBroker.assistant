/**
 * Speech-to-text engines. V1 ships the cloud engine (OpenAI Whisper); local engines
 * (Vosk / whisper.cpp / Wyoming) plug in behind the same `SttEngine` interface later.
 */
import OpenAI, { toFile } from 'openai';

export interface SttEngine {
    /**
     * Transcribe raw mono 16-bit PCM. `lang` is an ISO-639-1 hint ('' = auto-detect).
     *
     * `hints` is an optional domain vocabulary (device / room / scene names …) to bias recognition toward,
     * so the engine better transcribes those proper nouns. Only engines that support *soft* biasing use it
     * (OpenAI Whisper `prompt`, Azure phrase list); engines where a word list would be a hard constraint or
     * needs pre-registration (Vosk grammar, AWS custom vocabulary) ignore it.
     */
    transcribe(pcm: Buffer, sampleRate: number, lang: string, hints?: string[]): Promise<string>;
    /** Optional warm-up (install/download engine + model for `lang`) so the first request isn't slow. */
    prepare?(lang: string): Promise<void>;
}

/**
 * Join vocabulary hints into a Whisper `prompt` string (a soft bias toward these terms), de-duplicated and
 * length-bounded to stay within the model's ~224-token prompt budget. Returns '' when there are no hints.
 */
export function hintsToPrompt(hints: string[] | undefined, maxChars = 800): string {
    if (!hints?.length) {
        return '';
    }
    const seen = new Set<string>();
    const parts: string[] = [];
    let len = 0;
    for (const h of hints) {
        const term = (h || '').trim();
        const key = term.toLowerCase();
        if (!term || seen.has(key)) {
            continue;
        }
        if (len + term.length + 2 > maxChars) {
            break;
        }
        seen.add(key);
        parts.push(term);
        len += term.length + 2;
    }
    return parts.join(', ');
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

    async transcribe(pcm: Buffer, sampleRate: number, lang: string, hints?: string[]): Promise<string> {
        const file = await toFile(pcmToWav(pcm, sampleRate), 'audio.wav', { type: 'audio/wav' });
        // A prompt biases Whisper toward the given domain vocabulary (device/room names) without excluding
        // other words — improves recognition of proper nouns the NLU then needs to match.
        const prompt = hintsToPrompt(hints);
        const res = await this.client.audio.transcriptions.create({
            file,
            model: this.model,
            // Whisper wants the bare ISO-639-1 code; strip any region (de-DE → de). '' → auto-detect.
            language: (lang || '').split('-')[0] || undefined,
            ...(prompt ? { prompt } : {}),
        });
        return (res.text || '').trim();
    }
}
