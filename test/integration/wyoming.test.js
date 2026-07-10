'use strict';
// Integration test: Wyoming TCP endpoint framing + STT→answer→TTS bridge (fake engines, loopback).
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { WyomingServer } = require('../../build/lib/voice/wyoming.js');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/** Encode a Wyoming event (header line + optional binary payload). */
function encode(type, data, payload) {
    const header = { type };
    if (data !== undefined) {
        header.data = data;
    }
    if (payload) {
        header.payload_length = payload.length;
    }
    const line = Buffer.from(`${JSON.stringify(header)}\n`);
    return payload ? Buffer.concat([line, payload]) : line;
}

/** Collect decoded events from a socket. */
function collector(sock) {
    const events = [];
    let buf = Buffer.alloc(0);
    sock.on('data', d => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
            const nl = buf.indexOf(0x0a);
            if (nl < 0) {
                break;
            }
            const header = JSON.parse(buf.subarray(0, nl).toString('utf8'));
            const plen = header.payload_length || 0;
            if (buf.length < nl + 1 + plen) {
                break;
            }
            const payload = plen ? Buffer.from(buf.subarray(nl + 1, nl + 1 + plen)) : null;
            buf = buf.subarray(nl + 1 + plen);
            events.push({ type: header.type, data: header.data, payload });
        }
    });
    return events;
}

const delay = ms => new Promise(r => setTimeout(r, ms));

async function withServer(opts, fn) {
    const seen = {};
    const server = new WyomingServer({
        port: 17811,
        language: 'de',
        stt: { transcribe: async (pcm, rate) => ((seen.sttBytes = pcm.length), (seen.rate = rate), 'hallo test') },
        tts: { synthesize: async () => ({ pcm: Buffer.alloc(20000, 7), sampleRate: 24000 }) },
        answer: async q => `Antwort: ${q}`,
        log: silentLog,
        ...opts,
    });
    await server.start();
    const sock = net.connect(17811, '127.0.0.1');
    const events = collector(sock);
    await new Promise(r => sock.once('connect', r));
    try {
        await fn(sock, events, seen);
    } finally {
        sock.destroy();
        await server.stop();
    }
}

test('describe → info advertises asr + tts', async () => {
    await withServer({}, async (sock, events) => {
        sock.write(encode('describe'));
        await delay(100);
        const info = events.find(e => e.type === 'info');
        assert.ok(info, 'info event received');
        assert.ok(Array.isArray(info.data.asr) && info.data.asr.length, 'asr advertised');
        assert.ok(Array.isArray(info.data.tts) && info.data.tts.length, 'tts advertised');
    });
});

test('audio-start/chunk/stop → transcript + spoken reply', async () => {
    await withServer({}, async (sock, events, seen) => {
        sock.write(encode('audio-start', { rate: 16000, width: 2, channels: 1 }));
        sock.write(encode('audio-chunk', { rate: 16000, width: 2, channels: 1 }, Buffer.alloc(3200, 3)));
        sock.write(encode('audio-chunk', { rate: 16000, width: 2, channels: 1 }, Buffer.alloc(3200, 3)));
        sock.write(encode('audio-stop'));
        await delay(300);
        assert.equal(seen.sttBytes, 6400, 'STT received both chunks');
        assert.equal(seen.rate, 16000, 'STT got the declared rate');
        const transcript = events.find(e => e.type === 'transcript');
        assert.equal(transcript.data.text, 'hallo test');
        const start = events.find(e => e.type === 'audio-start');
        assert.equal(start.data.rate, 24000, 'reply audio-start carries the TTS rate');
        const ttsBytes = events.filter(e => e.type === 'audio-chunk').reduce((a, e) => a + e.payload.length, 0);
        assert.equal(ttsBytes, 20000, 'full TTS PCM streamed back');
        assert.ok(events.some(e => e.type === 'audio-stop'), 'audio-stop sent');
    });
});

test('synthesize → audio-* (text to speech only)', async () => {
    await withServer({}, async (sock, events) => {
        sock.write(encode('synthesize', { text: 'Hallo' }));
        await delay(200);
        const ttsBytes = events.filter(e => e.type === 'audio-chunk').reduce((a, e) => a + e.payload.length, 0);
        assert.equal(ttsBytes, 20000);
        assert.ok(events.some(e => e.type === 'audio-stop'));
    });
});

test('VAD voice-started/voice-stopped drives the pipeline', async () => {
    await withServer({}, async (sock, events, seen) => {
        sock.write(encode('voice-started', { rate: 16000 }));
        sock.write(encode('audio-chunk', { rate: 16000, width: 2, channels: 1 }, Buffer.alloc(3200, 4)));
        sock.write(encode('voice-stopped'));
        await delay(300);
        assert.equal(seen.sttBytes, 3200, 'buffered audio transcribed on voice-stopped');
        assert.ok(events.some(e => e.type === 'transcript'), 'transcript emitted');
        assert.ok(events.some(e => e.type === 'audio-stop'), 'reply spoken');
    });
});

test('pipeline failure emits an error event', async () => {
    await withServer({ stt: { transcribe: async () => { throw new Error('boom'); } } }, async (sock, events) => {
        sock.write(encode('audio-start', { rate: 16000 }));
        sock.write(encode('audio-chunk', { rate: 16000, width: 2, channels: 1 }, Buffer.alloc(3200, 1)));
        sock.write(encode('audio-stop'));
        await delay(200);
        const err = events.find(e => e.type === 'error');
        assert.ok(err, 'error event sent');
        assert.match(err.data.text, /boom/);
    });
});

test('frame split across TCP writes is reassembled', async () => {
    await withServer({}, async (sock, events, seen) => {
        const frame = encode('audio-chunk', { rate: 16000, width: 2, channels: 1 }, Buffer.alloc(3200, 9));
        sock.write(encode('audio-start', { rate: 16000, width: 2, channels: 1 }));
        // split the chunk frame mid-payload
        sock.write(frame.subarray(0, 20));
        await delay(30);
        sock.write(frame.subarray(20));
        sock.write(encode('audio-stop'));
        await delay(300);
        assert.equal(seen.sttBytes, 3200, 'split frame reassembled correctly');
    });
});
