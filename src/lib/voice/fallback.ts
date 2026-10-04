/**
 * A second speech engine behind the first one, so an outage does not take the voice away.
 *
 * The usual setup is a cloud engine with a local one behind it: when OpenAI/Azure/AWS is unreachable, the
 * API key expired or the quota ran out, Vosk and Piper keep the house answering — worse sounding, but
 * answering. That is the whole value: without it, the assistant goes mute exactly when the internet does.
 *
 * The idea comes from the Python original (`C:\iot\Hannah`, `core/hannah/stt.py`, which chains
 * aws → azure → remote → local); here it is one explicit fallback rather than an open chain, because a
 * household configures at most two speech providers and a longer chain would mostly be a way to wait
 * several timeouts in a row.
 *
 * Any failure of the primary moves on to the fallback: the alternative would be classifying provider
 * errors into "retryable" and "not", which is guesswork across three SDKs — and a request the primary
 * cannot answer is one the user still wants answered.
 */
import type { SttEngine } from './stt';
import type { TtsEngine, TtsResult } from './tts';
import type { VoiceLogger } from './download';

/** One named engine in the chain. */
export interface NamedEngine<T> {
    name: string;
    engine: T;
}

/** Run `attempt` over the engines in order; the last error survives if all of them fail. */
async function overEngines<T, R>(
    engines: NamedEngine<T>[],
    what: string,
    log: VoiceLogger,
    attempt: (engine: T) => Promise<R>,
): Promise<R> {
    let last: Error | undefined;
    for (const [index, entry] of engines.entries()) {
        try {
            const result = await attempt(entry.engine);
            if (index > 0) {
                log.info(`${what}: answered by the fallback engine (${entry.name}).`);
            }
            return result;
        } catch (e) {
            last = e as Error;
            const next = engines[index + 1];
            log[next ? 'warn' : 'error'](
                `${what}: ${entry.name} failed (${last.message})${next ? ` — trying ${next.name}` : ''}.`,
            );
        }
    }
    throw last ?? new Error(`${what}: no engine configured`);
}

/** Speech-to-text with one fallback engine. */
export class FallbackStt implements SttEngine {
    constructor(
        private readonly engines: NamedEngine<SttEngine>[],
        private readonly log: VoiceLogger,
    ) {}

    transcribe(pcm: Buffer, sampleRate: number, lang: string, hints?: string[]): Promise<string> {
        return overEngines(this.engines, 'Speech-to-text', this.log, e => e.transcribe(pcm, sampleRate, lang, hints));
    }

    /** Prepare every engine: the fallback is useless if its model is only downloaded once it is needed. */
    async prepare(lang: string): Promise<void> {
        for (const entry of this.engines) {
            try {
                await entry.engine.prepare?.(lang);
            } catch (e) {
                this.log.warn(`Speech-to-text: preparing ${entry.name} failed (${(e as Error).message}).`);
            }
        }
    }
}

/** Text-to-speech with one fallback engine. */
export class FallbackTts implements TtsEngine {
    constructor(
        private readonly engines: NamedEngine<TtsEngine>[],
        private readonly log: VoiceLogger,
    ) {}

    synthesize(text: string, lang: string): Promise<TtsResult> {
        return overEngines(this.engines, 'Text-to-speech', this.log, e => e.synthesize(text, lang));
    }

    /**
     * SSML only goes to engines that can speak it; if none can, the primary's plain-text path handles it
     * (its cache wrapper strips the markup).
     */
    synthesizeSsml(ssml: string, lang: string): Promise<TtsResult> {
        const capable = this.engines.filter(e => !!e.engine.synthesizeSsml);
        if (!capable.length) {
            return this.synthesize(ssml, lang);
        }
        return overEngines(capable, 'Text-to-speech (SSML)', this.log, e => e.synthesizeSsml!(ssml, lang));
    }

    async prepare(lang: string): Promise<void> {
        for (const entry of this.engines) {
            try {
                await entry.engine.prepare?.(lang);
            } catch (e) {
                this.log.warn(`Text-to-speech: preparing ${entry.name} failed (${(e as Error).message}).`);
            }
        }
    }

    /** Warm only the primary's cache: the fallback is for an outage, not for everyday phrases. */
    warm(phrases: string[], lang: string): Promise<number> {
        return this.engines[0]?.engine.warm?.(phrases, lang) ?? Promise.resolve(0);
    }
}
