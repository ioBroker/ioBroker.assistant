import { isHandoff } from './localLlm';
import type { BenchmarkResult } from './llmModels';

/**
 * Benchmark for the local model in exactly its role here: questions about the home must be handed off
 * (the model has no tools), general questions answered with the right fact. Runs on the user's hardware,
 * so speed and error rate are real numbers for that host — published benchmarks say nothing about either.
 */

export interface BenchmarkCase {
    lang: string;
    question: string;
    /** `handoff` = must hand off; otherwise the answer must match this pattern. */
    expect: 'handoff' | RegExp;
}

const CASES: Record<string, { home: string[]; facts: [string, RegExp][] }> = {
    en: {
        home: [
            'Turn on the light in the kitchen.',
            'What is the temperature in the living room?',
            'Close the blinds in the bedroom.',
        ],
        facts: [
            ['How many days does a leap year have?', /\b366\b/],
            ['What is the capital of France?', /paris/i],
            ['What is 7 times 8?', /\b56\b/],
        ],
    },
    de: {
        home: [
            'Schalte das Licht in der Küche ein.',
            'Wie warm ist es im Wohnzimmer?',
            'Mach die Rollläden im Schlafzimmer zu.',
        ],
        facts: [
            ['Wie viele Tage hat ein Schaltjahr?', /\b366\b/],
            ['Was ist die Hauptstadt von Frankreich?', /paris/i],
            ['Was ist 7 mal 8?', /\b56\b/],
        ],
    },
    ru: {
        home: ['Включи свет на кухне.', 'Какая температура в гостиной?', 'Закрой жалюзи в спальне.'],
        facts: [
            ['Сколько дней в високосном году?', /366/],
            ['Какая столица Франции?', /париж|paris/i],
            ['Сколько будет семь умножить на восемь?', /56|пятьдесят шесть/i],
        ],
    },
};

/** Languages the benchmark knows. */
export const BENCHMARK_LANGUAGES = Object.keys(CASES);

/** The cases for the assistant's language plus English (unknown languages fall back to English only). */
export function benchmarkCases(language: string): BenchmarkCase[] {
    const langs = [...new Set([CASES[language] ? language : 'en', 'en'])];
    const out: BenchmarkCase[] = [];
    for (const lang of langs) {
        const set = CASES[lang];
        for (const question of set.home) {
            out.push({ lang, question, expect: 'handoff' });
        }
        for (const [question, expect] of set.facts) {
            out.push({ lang, question, expect });
        }
    }
    return out;
}

export interface BenchmarkRun {
    answer: string;
    ms: number;
    tokens?: number;
    genMs?: number;
    firstTokenMs?: number;
}

/**
 * Runs the cases one after another through `ask` (which must throw on timeout/error with a message
 * containing "timed out" for a timeout). `onCase` reports progress.
 */
export async function runBenchmark(
    cases: BenchmarkCase[],
    ask: (question: string) => Promise<BenchmarkRun>,
    onCase?: (done: number, total: number) => void,
): Promise<BenchmarkResult> {
    const result: BenchmarkResult = {
        at: Date.now(),
        languages: [...new Set(cases.map(c => c.lang))],
        cases: cases.length,
        correct: 0,
        missedHandoffs: 0,
        needlessHandoffs: 0,
        wrongAnswers: 0,
        timeouts: 0,
        errors: 0,
        tokensPerSec: 0,
        avgFirstTokenMs: 0,
        avgMs: 0,
        details: [],
    };
    let tokens = 0;
    let genMs = 0;
    let firstMs = 0;
    let firstRuns = 0;
    let totalMs = 0;
    let runs = 0;
    for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        const expect = c.expect === 'handoff' ? 'handoff' : String(c.expect);
        try {
            const run = await ask(c.question);
            runs++;
            totalMs += run.ms;
            if (run.tokens && run.genMs) {
                tokens += run.tokens;
                genMs += run.genMs;
            }
            if (run.firstTokenMs !== undefined) {
                firstMs += run.firstTokenMs;
                firstRuns++;
            }
            const handedOff = isHandoff(run.answer);
            let ok: boolean;
            if (c.expect === 'handoff') {
                ok = handedOff;
                if (!ok) {
                    result.missedHandoffs++;
                }
            } else if (handedOff) {
                ok = false;
                result.needlessHandoffs++;
            } else {
                ok = c.expect.test(run.answer);
                if (!ok) {
                    result.wrongAnswers++;
                }
            }
            if (ok) {
                result.correct++;
            }
            result.details.push({ lang: c.lang, question: c.question, expect, answer: run.answer, ok, ms: run.ms });
        } catch (e) {
            const msg = (e as Error).message;
            if (/timed out/i.test(msg)) {
                result.timeouts++;
            } else {
                result.errors++;
            }
            result.details.push({ lang: c.lang, question: c.question, expect, answer: `(${msg})`, ok: false, ms: 0 });
        }
        onCase?.(i + 1, cases.length);
    }
    result.tokensPerSec = genMs > 0 ? Math.round((tokens / genMs) * 10000) / 10 : 0;
    result.avgFirstTokenMs = firstRuns ? Math.round(firstMs / firstRuns) : 0;
    result.avgMs = runs ? Math.round(totalMs / runs) : 0;
    return result;
}
