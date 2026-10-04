'use strict';
// Integration test: the second speech engine behind the first one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FallbackStt, FallbackTts } = require('../../build/lib/voice/fallback.js');

function recorder() {
    const lines = [];
    return {
        lines,
        log: {
            info: m => lines.push(`info:${m}`),
            warn: m => lines.push(`warn:${m}`),
            error: m => lines.push(`error:${m}`),
            debug: m => lines.push(`debug:${m}`),
        },
    };
}

const okStt = text => ({ transcribe: async () => text });
const failStt = msg => ({
    transcribe: async () => {
        throw new Error(msg);
    },
});

test('the primary answers and the fallback is never touched', async () => {
    let fallbackCalls = 0;
    const r = recorder();
    const stt = new FallbackStt(
        [
            { name: 'openai', engine: okStt('hello') },
            {
                name: 'vosk',
                engine: {
                    transcribe: async () => {
                        fallbackCalls++;
                        return 'local';
                    },
                },
            },
        ],
        r.log,
    );
    assert.equal(await stt.transcribe(Buffer.alloc(2), 16000, 'de'), 'hello');
    assert.equal(fallbackCalls, 0);
    assert.deepEqual(r.lines, [], 'a healthy primary logs nothing');
});

test('a failing primary hands over, and the hand-over is visible in the log', async () => {
    const r = recorder();
    const stt = new FallbackStt(
        [
            { name: 'openai', engine: failStt('402 quota exceeded') },
            { name: 'vosk', engine: okStt('local result') },
        ],
        r.log,
    );
    assert.equal(await stt.transcribe(Buffer.alloc(2), 16000, 'de'), 'local result');
    assert.match(r.lines.join('\n'), /warn:.*openai failed \(402 quota exceeded\) — trying vosk/);
    assert.match(r.lines.join('\n'), /info:.*answered by the fallback engine \(vosk\)/);
});

test('when both fail the last error surfaces, logged as an error', async () => {
    const r = recorder();
    const stt = new FallbackStt(
        [
            { name: 'openai', engine: failStt('offline') },
            { name: 'vosk', engine: failStt('no model') },
        ],
        r.log,
    );
    await assert.rejects(() => stt.transcribe(Buffer.alloc(2), 16000, 'de'), /no model/);
    assert.match(r.lines.join('\n'), /error:.*vosk failed \(no model\)\./);
});

test('transcribe passes the hints through to whichever engine answers', async () => {
    const seen = [];
    const stt = new FallbackStt(
        [
            { name: 'a', engine: failStt('nope') },
            {
                name: 'b',
                engine: {
                    transcribe: async (pcm, rate, lang, hints) => {
                        seen.push({ rate, lang, hints });
                        return 'ok';
                    },
                },
            },
        ],
        recorder().log,
    );
    await stt.transcribe(Buffer.alloc(2), 16000, 'de', ['Küche']);
    assert.deepEqual(seen, [{ rate: 16000, lang: 'de', hints: ['Küche'] }]);
});

test('prepare prepares every engine and survives one that cannot', async () => {
    const prepared = [];
    const r = recorder();
    const stt = new FallbackStt(
        [
            {
                name: 'openai',
                engine: {
                    transcribe: async () => '',
                    prepare: async () => {
                        prepared.push('openai');
                    },
                },
            },
            {
                name: 'vosk',
                engine: {
                    transcribe: async () => '',
                    prepare: async () => {
                        throw new Error('download failed');
                    },
                },
            },
        ],
        r.log,
    );
    await stt.prepare('de');
    assert.deepEqual(prepared, ['openai'], 'the fallback failing to prepare is not fatal');
    assert.match(r.lines.join('\n'), /warn:.*preparing vosk failed/);
});

test('TTS falls back the same way, and warming only touches the primary', async () => {
    const r = recorder();
    let warmed = 0;
    const tts = new FallbackTts(
        [
            {
                name: 'openai',
                engine: {
                    synthesize: async () => {
                        throw new Error('timeout');
                    },
                    warm: async () => {
                        warmed++;
                        return 2;
                    },
                },
            },
            {
                name: 'piper',
                engine: { synthesize: async () => ({ pcm: Buffer.alloc(10), sampleRate: 22050 }) },
            },
        ],
        r.log,
    );
    const res = await tts.synthesize('Hallo', 'de');
    assert.equal(res.sampleRate, 22050);
    assert.equal(await tts.warm(['Ok.'], 'de'), 2);
    assert.equal(warmed, 1, 'only the primary cache is warmed');
});

test('SSML goes to an engine that can speak it, even if that is the fallback', async () => {
    const r = recorder();
    const calls = [];
    const tts = new FallbackTts(
        [
            { name: 'openai', engine: { synthesize: async t => (calls.push(`text:${t}`), { pcm: Buffer.alloc(1), sampleRate: 24000 }) } },
            {
                name: 'azure',
                engine: {
                    synthesize: async () => ({ pcm: Buffer.alloc(1), sampleRate: 24000 }),
                    synthesizeSsml: async t => (calls.push(`ssml:${t}`), { pcm: Buffer.alloc(2), sampleRate: 24000 }),
                },
            },
        ],
        r.log,
    );
    await tts.synthesizeSsml('<speak>hi</speak>', 'de');
    assert.deepEqual(calls, ['ssml:<speak>hi</speak>'], 'the SSML-capable engine is picked directly');
});

test('with no SSML-capable engine the markup takes the normal path', async () => {
    const calls = [];
    const tts = new FallbackTts(
        [{ name: 'openai', engine: { synthesize: async t => (calls.push(t), { pcm: Buffer.alloc(1), sampleRate: 24000 }) } }],
        recorder().log,
    );
    await tts.synthesizeSsml('<speak>hi</speak>', 'de');
    assert.deepEqual(calls, ['<speak>hi</speak>'], 'handed on as text (the cache layer strips it)');
});
