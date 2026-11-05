/**
 * Speech recognition by the adapter ioBroker.ai-parakeet (NVIDIA Parakeet TDT 0.6B v3 on the CPU, 25 European
 * languages, detected automatically).
 *
 * Over the message bus, not over its HTTP API: `sendTo('ai-parakeet.0', 'transcribe', { pcm, sampleRate, prompt })`
 * works on any host of a multihost system without an address, and an API key set there does not matter. The PCM goes
 * as base64 — a Buffer would be serialised as a JSON array of numbers.
 */
import { hintsToPrompt, type SttEngine } from './stt';

/** Sends a message to another instance and resolves with its answer; rejects when it is not running or times out. */
export type MessageSender = (instance: string, command: string, message: Record<string, unknown>) => Promise<unknown>;

export class ParakeetStt implements SttEngine {
    constructor(
        private readonly instance: string,
        private readonly send: MessageSender,
    ) {
        if (!instance) {
            throw new Error('Parakeet speech recognition needs an ai-parakeet instance');
        }
    }

    /** `lang` is not sent: the model detects the language itself. */
    async transcribe(pcm: Buffer, sampleRate: number, _lang: string, hints?: string[]): Promise<string> {
        const prompt = hintsToPrompt(hints);
        const answer = (await this.send(this.instance, 'transcribe', {
            pcm: pcm.toString('base64'),
            sampleRate,
            ...(prompt ? { prompt } : {}),
        })) as { text?: unknown; error?: unknown } | null | undefined;
        if (!answer || typeof answer !== 'object') {
            throw new Error(`${this.instance} gave no answer`);
        }
        if (answer.error) {
            const error = typeof answer.error === 'string' ? answer.error : JSON.stringify(answer.error);
            throw new Error(`${this.instance}: ${error}`);
        }
        return typeof answer.text === 'string' ? answer.text.trim() : '';
    }
}
