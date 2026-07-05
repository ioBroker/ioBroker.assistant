'use strict';
// Integration test: UDP voice server (Hannah protocol) — register/heartbeat/audio→reply + announce.
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { VoiceServer } = require('../../build/lib/voice/voiceServer.js');
const { TYPE_CONTROL, TYPE_AUDIO, TYPE_TTS } = require('../../build/lib/voice/protocol.js');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const delay = ms => new Promise(r => setTimeout(r, ms));
const PORT = 17821;
const SAT = 17822;

function ctrl(obj) {
    return Buffer.concat([Buffer.from([TYPE_CONTROL]), Buffer.from(JSON.stringify(obj))]);
}
function audio(buf) {
    return Buffer.concat([Buffer.from([TYPE_AUDIO]), buf]);
}

/** A fake satellite socket that records what the server sends back. */
function fakeSat() {
    const sock = dgram.createSocket('udp4');
    const rec = { registered: false, ackCount: 0, ttsBytes: 0, ttsEnd: null, status: [] };
    sock.on('message', d => {
        if (d[0] === TYPE_TTS) {
            rec.ttsBytes += d.length - 1;
            return;
        }
        const m = JSON.parse(d.subarray(1).toString('utf8'));
        if (m.type === 'registered') rec.registered = m.ok;
        else if (m.type === 'heartbeat_ack') rec.ackCount++;
        else if (m.type === 'tts_end') rec.ttsEnd = m.sample_rate;
        else if (m.type === 'status') rec.status.push(m.state);
    });
    return { sock, rec, send: b => sock.send(b, PORT, '127.0.0.1') };
}

async function withServer(opts, fn) {
    const server = new VoiceServer({
        port: PORT,
        language: 'de',
        stt: { transcribe: async () => 'licht an' },
        tts: { synthesize: async () => ({ pcm: Buffer.alloc(24000, 5), sampleRate: 24000 }) },
        answer: async () => 'Licht ist an',
        log: silentLog,
        ...opts,
    });
    await server.start();
    const sat = fakeSat();
    await new Promise(r => sat.sock.bind(SAT, r));
    try {
        await fn(server, sat);
    } finally {
        sat.sock.close();
        await server.stop();
    }
}

test('register → ACK and heartbeat → heartbeat_ack', async () => {
    await withServer({}, async (server, sat) => {
        sat.send(ctrl({ type: 'register', device: 'wz', room: 'Wohnzimmer', listen_port: SAT }));
        await delay(80);
        assert.equal(sat.rec.registered, true);
        assert.deepEqual(server.devices(), ['wz']);
        sat.send(ctrl({ type: 'heartbeat', device: 'wz' }));
        await delay(80);
        assert.equal(sat.rec.ackCount, 1);
    });
});

test('audio → audio_end runs STT→answer→TTS and streams the reply', async () => {
    await withServer({}, async (_server, sat) => {
        sat.send(ctrl({ type: 'register', device: 'wz', listen_port: SAT }));
        await delay(60);
        for (let i = 0; i < 5; i++) {
            sat.send(audio(Buffer.alloc(3200, i + 1)));
            await delay(5);
        }
        sat.send(ctrl({ type: 'audio_end', device: 'wz' }));
        await delay(250);
        assert.equal(sat.rec.ttsBytes, 24000, 'full reply PCM streamed');
        assert.equal(sat.rec.ttsEnd, 24000, 'tts_end carries the sample rate');
        assert.ok(sat.rec.status.includes('processing'), 'processing status seen');
        assert.ok(sat.rec.status.includes('speaking'), 'speaking status seen');
        assert.equal(sat.rec.status.at(-1), 'idle', 'ends on idle');
    });
});

test('announce plays PCM on a specific device and on all', async () => {
    await withServer({}, async (server, sat) => {
        sat.send(ctrl({ type: 'register', device: 'wz', listen_port: SAT }));
        await delay(60);
        await server.announce('wz', Buffer.alloc(10000, 1), 24000);
        await delay(60);
        assert.equal(sat.rec.ttsBytes, 10000, 'announce to device delivered');
        sat.rec.ttsBytes = 0;
        await server.announce(null, Buffer.alloc(8000, 1), 24000);
        await delay(60);
        assert.equal(sat.rec.ttsBytes, 8000, 'broadcast announce delivered');
    });
});
