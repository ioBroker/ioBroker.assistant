'use strict';
// Integration test: diagnosis recordings of dropped satellite captures (WAV + JSON, pruned to the newest N).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    CaptureStore,
    CAPTURE_DIR,
    captureBaseName,
    levelProfile,
} = require('../../build/lib/voice/captures.js');

/** In-memory stand-in for the adapter's file storage. */
function memoryFiles() {
    const files = new Map();
    return {
        files,
        write: async (path, data) => {
            files.set(path, data);
        },
        list: async dir =>
            [...files.keys()].filter(p => p.startsWith(`${dir}/`)).map(p => p.slice(dir.length + 1)),
        remove: async path => {
            files.delete(path);
        },
    };
}

/** `ms` of 16 kHz PCM at a constant amplitude. */
function tone(ms, amplitude) {
    const samples = (16000 * ms) / 1000;
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        buf.writeInt16LE(i % 2 ? amplitude : -amplitude, i * 2);
    }
    return buf;
}

function capture(extra = {}) {
    return {
        device: '3RSPK-A8E29151F889',
        room: 'Salon',
        wakeWord: 'okay_nabu',
        reason: 'no-speech',
        pcm: Buffer.concat([tone(300, 1000), tone(200, 0)]),
        sampleRate: 16000,
        vad: { peak: 1000, analysedPeak: 0, noiseFloor: 0, startLevel: 250, endLevel: 150 },
        ...extra,
    };
}

test('levelProfile gives the RMS per 100 ms', () => {
    assert.deepEqual(levelProfile(Buffer.concat([tone(300, 1000), tone(200, 0)]), 16000), [1000, 1000, 1000, 0, 0]);
    assert.deepEqual(levelProfile(Buffer.alloc(0), 16000), []);
});

test('captureBaseName sorts by time and keeps the device name file-safe', () => {
    const a = captureBaseName(new Date(2026, 10, 3, 8, 33, 36, 7), 'Handy Alex/1', 'empty-stt');
    assert.equal(a, '2026-11-03_08-33-36-007_Handy_Alex_1_empty-stt');
    const b = captureBaseName(new Date(2026, 10, 3, 10, 0, 0, 0), 'a', 'silence');
    assert.ok(a < b, 'names sort chronologically');
});

test('a recording is stored as WAV plus JSON with what the detector saw', async () => {
    const mem = memoryFiles();
    const store = new CaptureStore(mem);
    const path = await store.save(capture(), new Date(2026, 10, 3, 0, 3, 24, 0));

    assert.equal(path, `${CAPTURE_DIR}/2026-11-03_00-03-24-000_3RSPK-A8E29151F889_no-speech.wav`);
    const wav = mem.files.get(path);
    assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
    assert.equal(wav.readUInt32LE(24), 16000, 'sample rate in the WAV header');
    assert.equal(wav.length, 44 + 16000, '0.5 s of 16-bit audio after the header');

    const info = JSON.parse(mem.files.get(path.replace(/\.wav$/, '.json')));
    assert.equal(info.reason, 'no-speech');
    assert.equal(info.wakeWord, 'okay_nabu');
    assert.equal(info.room, 'Salon');
    assert.equal(info.seconds, 0.5);
    assert.equal(info.vad.startLevel, 250);
    assert.deepEqual(info.levels, [1000, 1000, 1000, 0, 0]);
    assert.equal(info.levelStepMs, 100);
});

test('a follow-up recording says so instead of an empty wake word', async () => {
    const mem = memoryFiles();
    const path = await new CaptureStore(mem).save(capture({ wakeWord: '' }));
    assert.equal(JSON.parse(mem.files.get(path.replace(/\.wav$/, '.json'))).wakeWord, '(follow-up)');
});

test('only the newest recordings are kept, WAV and JSON together', async () => {
    const mem = memoryFiles();
    const store = new CaptureStore(mem, 3);
    const paths = [];
    for (let i = 0; i < 5; i++) {
        paths.push(await store.save(capture(), new Date(2026, 10, 3, 1, 0, i)));
    }
    const left = [...mem.files.keys()].sort();
    assert.equal(left.length, 6, '3 recordings × (wav + json)');
    for (const old of paths.slice(0, 2)) {
        assert.ok(!mem.files.has(old), `${old} should be gone`);
        assert.ok(!mem.files.has(old.replace(/\.wav$/, '.json')));
    }
    for (const kept of paths.slice(2)) {
        assert.ok(mem.files.has(kept));
    }
});

test('saves started together run one after another and all survive', async () => {
    const mem = memoryFiles();
    const store = new CaptureStore(mem, 10);
    await Promise.all([0, 1, 2].map(i => store.save(capture({ device: `d${i}` }), new Date(2026, 10, 3, 2, 0, i))));
    assert.equal(mem.files.size, 6);
});

test('a failing write rejects that save but does not block the next one', async () => {
    const mem = memoryFiles();
    let fail = true;
    const files = {
        ...mem,
        write: async (path, data) => {
            if (fail) {
                fail = false;
                throw new Error('disk full');
            }
            mem.files.set(path, data);
        },
    };
    const store = new CaptureStore(files);
    await assert.rejects(store.save(capture(), new Date(2026, 10, 3, 3, 0, 0)), /disk full/);
    const path = await store.save(capture(), new Date(2026, 10, 3, 3, 0, 1));
    assert.ok(mem.files.has(path));
});
