'use strict';
// Integration test: the shared TTS layer — disk cache, length limit, SSML routing, pruning.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    CachedTts,
    isSsml,
    stripSsml,
    truncateForTts,
    MAX_TTS_CHARS,
} = require('../../build/lib/voice/ttsCache.js');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/** A fake engine that counts calls and returns recognisable audio. */
function fakeEngine(extra = {}) {
    const calls = { text: [], ssml: [] };
    return {
        calls,
        engine: {
            synthesize: async text => {
                calls.text.push(text);
                return { pcm: Buffer.alloc(320, 7), sampleRate: 24000 };
            },
            ...extra,
        },
    };
}

function tmpDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttscache-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('isSsml / stripSsml recognise and flatten markup', () => {
    assert.equal(isSsml('<speak>hi</speak>'), true);
    assert.equal(isSsml('  <speak version="1.0">hi</speak>'), true);
    assert.equal(isSsml('speak up'), false);
    assert.equal(isSsml('<speaker>'), false, 'a different tag is not SSML');
    assert.equal(stripSsml('<speak>Dinner <break time="500ms"/> is ready</speak>'), 'Dinner is ready');
});

test('truncateForTts cuts at the last sentence end, else at a word, and leaves short text alone', () => {
    assert.equal(truncateForTts('Short answer.'), 'Short answer.');
    const long = `${'a'.repeat(150)}. ${'b'.repeat(150)}. ${'c'.repeat(300)}`;
    const cut = truncateForTts(long, 400);
    assert.ok(cut.length <= 400);
    assert.ok(cut.endsWith('.'), 'cut at a sentence end');
    const noSentence = 'word '.repeat(200);
    const cut2 = truncateForTts(noSentence, 100);
    assert.ok(cut2.endsWith('…'), 'no sentence end → ellipsis');
    assert.ok(cut2.length <= 102);
    const ssml = `<speak>${'x'.repeat(500)}</speak>`;
    assert.equal(truncateForTts(ssml), ssml, 'SSML is never cut — that would break the markup');
    assert.equal(MAX_TTS_CHARS, 400);
});

test('a repeated short text comes from disk instead of the engine', async t => {
    const dir = tmpDir(t);
    const { engine, calls } = fakeEngine();
    const tts = new CachedTts(engine, { dir, log: silentLog });

    const first = await tts.synthesize('Ok.', 'de');
    const second = await tts.synthesize('Ok.', 'de');
    assert.deepEqual(calls.text, ['Ok.'], 'synthesised once');
    assert.equal(second.sampleRate, 24000, 'the sample rate survives the cache');
    assert.deepEqual(second.pcm, first.pcm);
    assert.equal(tts.has('Ok.', 'de'), true);

    // A new wrapper on the same directory still finds it (that is the point of a disk cache).
    const again = new CachedTts(fakeEngine().engine, { dir, log: silentLog });
    assert.equal((await again.synthesize('Ok.', 'de')).pcm.length, 320);
});

test('the language is part of the key', async t => {
    const dir = tmpDir(t);
    const { engine, calls } = fakeEngine();
    const tts = new CachedTts(engine, { dir, log: silentLog });
    await tts.synthesize('Ok.', 'de');
    await tts.synthesize('Ok.', 'en');
    assert.equal(calls.text.length, 2, 'same words, other language → synthesised again');
});

test('a long answer is cut and not cached', async t => {
    const dir = tmpDir(t);
    const { engine, calls } = fakeEngine();
    const tts = new CachedTts(engine, { dir, log: silentLog, maxCacheChars: 20 });
    const long = 'This is a long one-off answer that nobody will ever ask for twice.';
    await tts.synthesize(long, 'en');
    await tts.synthesize(long, 'en');
    assert.equal(calls.text.length, 2, 'not worth caching → synthesised every time');
    assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.pcm')), [], 'nothing written');
});

test('SSML goes to the engine that can speak it, and is flattened for one that cannot', async t => {
    const dir = tmpDir(t);
    const plain = fakeEngine();
    const plainTts = new CachedTts(plain.engine, { dir, log: silentLog });
    await plainTts.synthesize('<speak>Dinner <break time="1s"/> is ready</speak>', 'en');
    assert.deepEqual(plain.calls.text, ['Dinner is ready'], 'tags stripped, not read out');

    const dir2 = tmpDir(t);
    const capable = fakeEngine({
        synthesizeSsml: async ssml => {
            capable.calls.ssml.push(ssml);
            return { pcm: Buffer.alloc(100, 1), sampleRate: 16000 };
        },
    });
    const ssmlTts = new CachedTts(capable.engine, { dir: dir2, log: silentLog });
    const res = await ssmlTts.synthesize('<speak>Dinner</speak>', 'en');
    assert.deepEqual(capable.calls.ssml, ['<speak>Dinner</speak>'], 'handed over untouched');
    assert.deepEqual(capable.calls.text, []);
    assert.equal(res.sampleRate, 16000);
});

test('warm pre-synthesises what is missing and skips what is there', async t => {
    const dir = tmpDir(t);
    const { engine, calls } = fakeEngine();
    const tts = new CachedTts(engine, { dir, log: silentLog });
    await tts.synthesize('Ok.', 'de');
    calls.text.length = 0;

    const added = await tts.warm(['Ok.', 'Erledigt.', '  ', 'Alles klar.'], 'de');
    assert.equal(added, 2, 'only the two missing ones');
    assert.deepEqual(calls.text, ['Erledigt.', 'Alles klar.']);
});

test('warm gives up as soon as the engine fails, instead of hammering it', async t => {
    const dir = tmpDir(t);
    let calls = 0;
    const tts = new CachedTts(
        {
            synthesize: async () => {
                calls++;
                throw new Error('no api key');
            },
        },
        { dir, log: silentLog },
    );
    assert.equal(await tts.warm(['a', 'b', 'c'], 'de'), 0);
    assert.equal(calls, 1);
});

test('the cache stays within its budget, dropping the least recently used entry', async t => {
    const dir = tmpDir(t);
    const { engine } = fakeEngine();
    // Each entry is 320 bytes of PCM plus the 4-byte rate header.
    const tts = new CachedTts(engine, { dir, log: silentLog, maxBytes: 800 });
    await tts.synthesize('one', 'de');
    await tts.synthesize('two', 'de');
    await new Promise(r => setTimeout(r, 15));
    await tts.synthesize('one', 'de'); // touches "one", so "two" is now the oldest
    await tts.synthesize('three', 'de');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.pcm'));
    assert.equal(files.length, 2, 'pruned back under the budget');
    assert.equal(tts.has('one', 'de'), true, 'the recently used entry survived');
    assert.equal(tts.has('two', 'de'), false, 'the least recently used one went');
});

test('a broken cache directory never stops the assistant from speaking', async t => {
    const dir = tmpDir(t);
    // A file where the directory should be: every cache operation must fail softly.
    const blocked = path.join(dir, 'blocked');
    fs.writeFileSync(blocked, 'not a directory');
    const { engine, calls } = fakeEngine();
    const tts = new CachedTts(engine, { dir: blocked, log: silentLog });
    const res = await tts.synthesize('Ok.', 'de');
    assert.equal(res.pcm.length, 320, 'still spoken');
    assert.deepEqual(calls.text, ['Ok.']);
});

test('a corrupt entry is ignored rather than played at the wrong pitch', async t => {
    const dir = tmpDir(t);
    const { engine, calls } = fakeEngine();
    const tts = new CachedTts(engine, { dir, log: silentLog });
    await tts.synthesize('Ok.', 'de');
    const file = path.join(dir, fs.readdirSync(dir).find(f => f.endsWith('.pcm')));
    fs.writeFileSync(file, Buffer.from([1, 2, 3])); // too short / nonsense rate
    const res = await tts.synthesize('Ok.', 'de');
    assert.equal(calls.text.length, 2, 'synthesised again');
    assert.equal(res.sampleRate, 24000);
});
