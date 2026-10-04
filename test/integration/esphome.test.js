'use strict';
// Integration test: ESPHome voice satellites — wire framing, end-of-speech detection, the media
// server, and the whole wake→STT→answer→TTS pipeline against a fake device over loopback TCP.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const { pb, encode, decode, registrySize } = require('../../build/lib/voice/esphomeProto.js');
const { SpeechDetector, rms } = require('../../build/lib/voice/vad.js');
const { MediaServer } = require('../../build/lib/voice/mediaServer.js');
const { EsphomeSatellites } = require('../../build/lib/voice/esphome.js');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

// ── wire framing ────────────────────────────────────────────────────────────

test('registry covers the VoiceAssistant message ids the satellite uses', () => {
    // The whole point of not using the library's own id table: it stops before these.
    for (const name of [
        'SubscribeVoiceAssistantRequest',
        'VoiceAssistantRequest',
        'VoiceAssistantResponse',
        'VoiceAssistantEventResponse',
        'VoiceAssistantAudio',
        'VoiceAssistantAnnounceRequest',
        'VoiceAssistantAnnounceFinished',
        'VoiceAssistantConfigurationRequest',
        'VoiceAssistantConfigurationResponse',
    ]) {
        const message = new pb[name]();
        assert.doesNotThrow(() => encode(message), `${name} has no wire id`);
    }
    assert.ok(registrySize > 120, `registry looks short: ${registrySize}`);
});

test('encode/decode round-trips a message', () => {
    const hello = new pb.HelloRequest();
    hello.setClientInfo('ioBroker.assistant');
    hello.setApiVersionMajor(1);
    hello.setApiVersionMinor(10);

    const { frames, rest } = decode(encode(hello));
    assert.equal(rest.length, 0);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].name, 'HelloRequest');
    assert.equal(frames[0].message.getClientInfo(), 'ioBroker.assistant');
});

test('decode keeps a partial frame in the tail and resumes on the next chunk', () => {
    const audio = new pb.VoiceAssistantAudio();
    audio.setData(Buffer.alloc(64, 7));
    const full = encode(audio);

    const first = decode(full.subarray(0, 10));
    assert.equal(first.frames.length, 0);
    assert.equal(first.rest.length, 10);

    const second = decode(Buffer.concat([first.rest, full.subarray(10)]));
    assert.equal(second.frames.length, 1);
    assert.equal(second.rest.length, 0);
    assert.equal(Buffer.from(second.frames[0].message.getData_asU8()).length, 64);
});

test('an unknown message id is skipped by its length instead of stalling the stream', () => {
    // A frame with id 250 (nothing we know), followed by a real one. 250 needs a two-byte varint.
    const unknown = Buffer.from([0, 3, 0xfa, 0x01, 1, 2, 3]);
    const ping = encode(new pb.PingRequest());

    const { frames, rest } = decode(Buffer.concat([unknown, ping]));
    assert.equal(rest.length, 0, 'the stream must not stall on an unknown id');
    assert.equal(frames.length, 2);
    assert.equal(frames[0].name, null);
    assert.equal(frames[1].name, 'PingRequest');
});

test('an encrypted device is reported as such rather than as garbage', () => {
    assert.throws(() => decode(Buffer.from([1, 0, 0])), /encrypted/);
});

// ── end-of-speech detection ─────────────────────────────────────────────────

/** One 30 ms frame at 16 kHz: loud noise when talking, near-silence otherwise. */
function micFrame(talking) {
    const buf = Buffer.alloc(480 * 2);
    for (let i = 0; i < 480; i++) {
        buf.writeInt16LE(Math.round((Math.random() * 2 - 1) * (talking ? 6000 : 50)), i * 2);
    }
    return buf;
}

test('rms separates speech from room noise', () => {
    assert.ok(rms(micFrame(true)) > 700);
    assert.ok(rms(micFrame(false)) < 400);
});

test('SpeechDetector ends the utterance after the configured silence', () => {
    const detector = new SpeechDetector({ silenceMs: 300, maxMs: 10000 });
    let verdict = null;
    for (let i = 0; i < 20 && !verdict; i++) {
        verdict = detector.push(micFrame(true));
    }
    assert.equal(verdict, null, 'must not end while speech continues');
    assert.ok(detector.sawSpeech);

    for (let i = 0; i < 20 && !verdict; i++) {
        verdict = detector.push(micFrame(false));
    }
    assert.equal(verdict, 'speech-end');
});

test('SpeechDetector gives up at maxMs when the room never falls quiet', () => {
    const detector = new SpeechDetector({ silenceMs: 100000, maxMs: 300 });
    let verdict = null;
    for (let i = 0; i < 20 && !verdict; i++) {
        verdict = detector.push(micFrame(true));
    }
    assert.equal(verdict, 'timeout');
});

test('pure silence never counts as speech', () => {
    const detector = new SpeechDetector({ silenceMs: 100 });
    for (let i = 0; i < 20; i++) {
        detector.push(micFrame(false));
    }
    assert.equal(detector.sawSpeech, false);
});

// ── adaptive gate (levels taken from a real ThirdReality capture) ───────────

/** One 30 ms frame at 16 kHz with a given RMS, so thresholds can be exercised exactly. */
function frameAt(targetRms) {
    const buf = Buffer.alloc(480 * 2);
    // Uniform noise in ±a has RMS a/√3.
    const a = targetRms * Math.sqrt(3);
    for (let i = 0; i < 480; i++) {
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((Math.random() * 2 - 1) * a))), i * 2);
    }
    return buf;
}

const CHIRP_RMS = 16000; // the device's wake acknowledgement, heard on its own mic
const SPEECH_RMS = 420; // measured speech level on the same device
const ROOM_RMS = 15; // between words

test('skipMs keeps the wake chirp from counting as speech', () => {
    const detector = new SpeechDetector({ skipMs: 300, adaptive: true, silenceMs: 100000 });
    for (let i = 0; i < 10; i++) {
        detector.push(frameAt(CHIRP_RMS)); // 10 × 30 ms = exactly the skipped lead-in
    }
    assert.equal(detector.sawSpeech, false, 'the chirp alone must not look like speech');
    for (let i = 0; i < 20; i++) {
        detector.push(frameAt(ROOM_RMS));
    }
    assert.equal(detector.sawSpeech, false, 'a wake word with no speech after it stays empty');
});

test('adaptive gate hears speech that the fixed thresholds would miss', () => {
    // The old gate, fed the voice alone: this is what it can actually hear.
    const fixed = new SpeechDetector({ silenceMs: 100000 });
    // The old gate, fed the whole stream: the chirp is the only thing that ever reached 700.
    const fixedWithChirp = new SpeechDetector({ silenceMs: 100000 });
    const adaptive = new SpeechDetector({ skipMs: 300, adaptive: true, silenceMs: 100000 });
    for (const d of [fixedWithChirp, adaptive]) {
        for (let i = 0; i < 10; i++) {
            d.push(frameAt(CHIRP_RMS));
        }
    }
    for (const d of [fixed, fixedWithChirp, adaptive]) {
        for (let i = 0; i < 10; i++) {
            d.push(frameAt(ROOM_RMS));
        }
    }
    // The threshold that decides is the one in force when the speech arrives, so check it here.
    assert.ok(
        adaptive.startLevel < SPEECH_RMS,
        `gate must sit below the measured speech level, was ${adaptive.startLevel}`,
    );
    for (const d of [fixed, fixedWithChirp, adaptive]) {
        for (let i = 0; i < 20; i++) {
            d.push(frameAt(SPEECH_RMS));
        }
    }
    // This is the regression, in two halves: RMS 420 never crosses the fixed 700 …
    assert.equal(fixed.sawSpeech, false, 'fixed thresholds cannot hear speech at this level');
    // … so under the old gate the flag was set by the device's chirp and by nothing else, which made
    // "did anyone actually speak?" unanswerable.
    assert.ok(fixedWithChirp.sawSpeech, 'the old gate was satisfied by the chirp alone');
    assert.ok(adaptive.sawSpeech, 'adaptive gate must detect RMS 420 speech over a quiet room');
    assert.ok(adaptive.endLevel <= adaptive.startLevel, 'hysteresis must be preserved');
    assert.ok(
        adaptive.noiseFloor < ROOM_RMS * 4,
        `noise floor must stay at room level, not follow the voice, got ${adaptive.noiseFloor}`,
    );
});

test('a long utterance does not raise the gate into its own speech', () => {
    // Sustained speech must not pull the floor (and with it endLevel) up to its own level.
    const detector = new SpeechDetector({ skipMs: 300, adaptive: true, silenceMs: 300, maxMs: 600000 });
    for (let i = 0; i < 10; i++) {
        detector.push(frameAt(CHIRP_RMS));
    }
    for (let i = 0; i < 10; i++) {
        detector.push(frameAt(ROOM_RMS));
    }
    let verdict = null;
    for (let i = 0; i < 600 && !verdict; i++) {
        verdict = detector.push(frameAt(SPEECH_RMS)); // 18 s of uninterrupted speech
    }
    assert.equal(verdict, null, 'must not cut off a speaker who simply keeps talking');
    assert.ok(detector.endLevel < SPEECH_RMS, `endLevel drifted up to ${detector.endLevel}`);
});

test('adaptive gate still ends the utterance on silence', () => {
    const detector = new SpeechDetector({ skipMs: 300, adaptive: true, silenceMs: 300, maxMs: 60000 });
    for (let i = 0; i < 10; i++) {
        detector.push(frameAt(CHIRP_RMS));
    }
    let verdict = null;
    for (let i = 0; i < 10 && !verdict; i++) {
        verdict = detector.push(frameAt(ROOM_RMS));
    }
    for (let i = 0; i < 20 && !verdict; i++) {
        verdict = detector.push(frameAt(SPEECH_RMS));
    }
    assert.equal(verdict, null, 'must not end while speech continues');
    for (let i = 0; i < 20 && !verdict; i++) {
        verdict = detector.push(frameAt(ROOM_RMS));
    }
    assert.equal(verdict, 'speech-end');
});

test('a speaker who starts immediately cannot become the noise floor', () => {
    // No pause between chirp and speech: an average over a calibration window would treat the voice
    // itself as room noise and never open the gate again.
    const detector = new SpeechDetector({ skipMs: 300, adaptive: true, silenceMs: 100000 });
    for (let i = 0; i < 10; i++) {
        detector.push(frameAt(CHIRP_RMS));
    }
    for (let i = 0; i < 30; i++) {
        detector.push(frameAt(SPEECH_RMS));
    }
    assert.ok(detector.sawSpeech, 'speech straight after the chirp must still register');
});

// ── media server ────────────────────────────────────────────────────────────

function fetch(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        }).on('error', reject);
    });
}

test('media server serves a published clip and 404s an expired one', async () => {
    const media = new MediaServer({ port: 0, log: silentLog });
    await media.start();
    const port = media.port;
    try {
        const path = media.publish(Buffer.from('audio-bytes'), 'audio/wav', 5000);
        const ok = await fetch(`http://127.0.0.1:${port}${path}`);
        assert.equal(ok.status, 200);
        assert.equal(ok.body.toString(), 'audio-bytes');

        const gone = media.publish(Buffer.from('short-lived'), 'audio/wav', -1);
        assert.equal((await fetch(`http://127.0.0.1:${port}${gone}`)).status, 404);
        assert.equal((await fetch(`http://127.0.0.1:${port}/media/nope.wav`)).status, 404);
    } finally {
        await media.stop();
    }
});

// ── the whole pipeline against a fake device ────────────────────────────────

/**
 * Minimal stand-in for `linux-voice-assistant-cpp`: answers the handshake, fires a wake word, and —
 * like the real firmware — keeps streaming microphone audio until the server sends STT_VAD_END.
 */
function fakeDevice({ speechMs = 600, chirpMs = 600, wakeWords = ['okay_nabu'] }) {
    const state = {
        events: [],
        fetched: [],
        streamedMs: 0,
        stoppedBy: null,
        // The firmware owns the wake-word selection and persists it; mirror that here.
        activeWakeWords: [...wakeWords],
        setConfigCalls: [],
        commands: [],
        timerEvents: [],
        announces: [],
    };

    const server = net.createServer(socket => {
        let buf = Buffer.alloc(0);
        let pump = null;
        let elapsed = 0;
        const send = m => socket.write(encode(m));

        const stop = why => {
            if (pump) {
                clearInterval(pump);
                pump = null;
                state.streamedMs = elapsed;
                state.stoppedBy ??= why;
            }
        };

        /** The three wake words the fake firmware ships, mirroring the real message shape. */
        const sendWakeWordConfig = () => {
            const reply = new pb.VoiceAssistantConfigurationResponse();
            reply.setAvailableWakeWordsList(
                [
                    ['okay_nabu', 'Okay Nabu', ['en', 'de']],
                    ['hey_jarvis', 'Hey Jarvis', ['en']],
                    ['alexa', 'Alexa', ['en']],
                ].map(([id, phrase, langs]) => {
                    const w = new pb.VoiceAssistantWakeWord();
                    w.setId(id);
                    w.setWakeWord(phrase);
                    w.setTrainedLanguagesList(langs);
                    return w;
                }),
            );
            reply.setActiveWakeWordsList(state.activeWakeWords);
            reply.setMaxActiveWakeWords(2);
            send(reply);
        };

        /** Entities mirroring the shape of a real voice speaker: a switch, a number and a select. */
        const ENTITIES = [
            { kind: 'switch', key: 1, objectId: 'thinking_sound', name: 'Thinking Sound' },
            { kind: 'number', key: 7, objectId: 'mic_gain', name: 'Mic Gain', min: 0, max: 31, step: 1 },
            {
                kind: 'select',
                key: 8,
                objectId: 'mic_noise',
                name: 'Noise Suppression',
                options: ['Off', 'Low', 'Medium', 'High', 'Max'],
            },
        ];
        const sendSwitchState = (key, value) => {
            const m = new pb.SwitchStateResponse();
            m.setKey(key);
            m.setState(value);
            send(m);
        };
        const sendNumberState = (key, value) => {
            const m = new pb.NumberStateResponse();
            m.setKey(key);
            m.setState(value);
            m.setMissingState(false);
            send(m);
        };
        const sendSelectState = (key, value) => {
            const m = new pb.SelectStateResponse();
            m.setKey(key);
            m.setState(value);
            m.setMissingState(false);
            send(m);
        };
        const sendSensors = () => {
            // A voice box also reports about its room: a measurement, a detection and a status text.
            const temp = new pb.ListEntitiesSensorResponse();
            temp.setObjectId('temperature');
            temp.setKey(31);
            temp.setName('Temperature');
            temp.setUnitOfMeasurement('°C');
            temp.setAccuracyDecimals(1);
            send(temp);
            const detected = new pb.ListEntitiesBinarySensorResponse();
            detected.setObjectId('occupancy');
            detected.setKey(32);
            detected.setName('Occupancy');
            send(detected);
            const status = new pb.ListEntitiesTextSensorResponse();
            status.setObjectId('wifi_bssid');
            status.setKey(33);
            status.setName('BSSID');
            send(status);
        };
        const sendSensorStates = () => {
            const t = new pb.SensorStateResponse();
            t.setKey(31);
            t.setState(21.5);
            t.setMissingState(false);
            send(t);
            const o = new pb.BinarySensorStateResponse();
            o.setKey(32);
            o.setState(true);
            o.setMissingState(false);
            send(o);
            const b = new pb.TextSensorStateResponse();
            b.setKey(33);
            b.setState('a4:2b:b0:11:22:33');
            b.setMissingState(false);
            send(b);
            // A reading the device does not have yet: `missing_state` must not arrive as 0.
            const missing = new pb.SensorStateResponse();
            missing.setKey(31);
            missing.setState(0);
            missing.setMissingState(true);
            send(missing);
        };
        const sendEntities = () => {
            sendSensors();
            for (const e of ENTITIES) {
                if (e.kind === 'switch') {
                    const m = new pb.ListEntitiesSwitchResponse();
                    m.setObjectId(e.objectId);
                    m.setKey(e.key);
                    m.setName(e.name);
                    m.setEntityCategory(1);
                    send(m);
                } else if (e.kind === 'number') {
                    const m = new pb.ListEntitiesNumberResponse();
                    m.setObjectId(e.objectId);
                    m.setKey(e.key);
                    m.setName(e.name);
                    m.setEntityCategory(1);
                    m.setMinValue(e.min);
                    m.setMaxValue(e.max);
                    m.setStep(e.step);
                    send(m);
                } else {
                    const m = new pb.ListEntitiesSelectResponse();
                    m.setObjectId(e.objectId);
                    m.setKey(e.key);
                    m.setName(e.name);
                    m.setEntityCategory(1);
                    m.setOptionsList(e.options);
                    send(m);
                }
            }
            send(new pb.ListEntitiesDoneResponse());
            // Like the real device: the current values follow the announcements.
            sendSwitchState(1, false);
            sendNumberState(7, 10);
            sendSelectState(8, 'Medium');
            sendSensorStates();
        };

        const handle = (name, message) => {
            if (name === 'HelloRequest') {
                const reply = new pb.HelloResponse();
                reply.setApiVersionMajor(1);
                reply.setApiVersionMinor(10);
                reply.setServerInfo('fake-lva');
                reply.setName('fake-speaker');
                send(reply);
            } else if (name === 'AuthenticationRequest') {
                const reply = new pb.AuthenticationResponse();
                reply.setInvalidPassword(false);
                send(reply);
            } else if (name === 'DeviceInfoRequest') {
                const reply = new pb.DeviceInfoResponse();
                reply.setName('fake-speaker');
                reply.setModel('fake');
                send(reply);
            } else if (name === 'SubscribeVoiceAssistantRequest') {
                setTimeout(() => {
                    const wake = new pb.VoiceAssistantRequest();
                    wake.setStart(true);
                    wake.setWakeWordPhrase('okay nabu');
                    send(wake);
                }, 50);
            } else if (name === 'ListEntitiesRequest') {
                sendEntities();
            } else if (name === 'SwitchCommandRequest') {
                state.commands.push({ kind: 'switch', key: message.getKey(), value: message.getState() });
                sendSwitchState(message.getKey(), message.getState());
            } else if (name === 'NumberCommandRequest') {
                state.commands.push({ kind: 'number', key: message.getKey(), value: message.getState() });
                sendNumberState(message.getKey(), message.getState());
            } else if (name === 'SelectCommandRequest') {
                state.commands.push({ kind: 'select', key: message.getKey(), value: message.getState() });
                sendSelectState(message.getKey(), message.getState());
            } else if (name === 'VoiceAssistantTimerEventResponse') {
                state.timerEvents.push({
                    type: message.getEventType(),
                    id: message.getTimerId(),
                    name: message.getName(),
                    total: message.getTotalSeconds(),
                    left: message.getSecondsLeft(),
                    active: message.getIsActive(),
                });
            } else if (name === 'VoiceAssistantConfigurationRequest') {
                sendWakeWordConfig();
            } else if (name === 'VoiceAssistantSetConfiguration') {
                // The real device silently keeps whatever it was given and echoes it on the next read.
                state.setConfigCalls.push(message.getActiveWakeWordsList());
                state.activeWakeWords = message.getActiveWakeWordsList();
            } else if (name === 'VoiceAssistantResponse') {
                pump = setInterval(() => {
                    const audio = new pb.VoiceAssistantAudio();
                    // Like the real firmware: the wake acknowledgement chirp comes back in through
                    // the device's own microphone first, then whatever the speaker says.
                    audio.setData(elapsed < chirpMs ? micFrame(true) : micFrame(elapsed < chirpMs + speechMs));
                    send(audio);
                    elapsed += 30;
                    if (elapsed > 10000) {
                        stop('runaway'); // the server never stopped us — that is a bug worth failing on
                    }
                }, 5);
            } else if (name === 'VoiceAssistantEventResponse') {
                const type = message.getEventType();
                const data = Object.fromEntries(message.getDataList().map(d => [d.getName(), d.getValue()]));
                state.events.push({ type, data });
                if (type === 12 || type === 4) {
                    stop(`event ${type}`);
                }
                if (type === 8 && data.url) {
                    void fetch(data.url).then(r => {
                        state.fetched.push(r);
                        const done = new pb.VoiceAssistantAnnounceFinished();
                        done.setSuccess(true);
                        send(done);
                    });
                }
            } else if (name === 'VoiceAssistantAnnounceRequest') {
                // start_conversation is how a question re-opens the mic — record it like the firmware would.
                state.announces.push({
                    mediaId: message.getMediaId(),
                    startConversation: message.getStartConversation(),
                });
                void fetch(message.getMediaId()).then(r => {
                    state.fetched.push(r);
                    const done = new pb.VoiceAssistantAnnounceFinished();
                    done.setSuccess(true);
                    send(done);
                });
            } else if (name === 'PingRequest') {
                send(new pb.PingResponse());
            }
        };

        socket.on('data', d => {
            buf = Buffer.concat([buf, d]);
            const { frames, rest } = decode(buf);
            buf = rest;
            for (const frame of frames) {
                if (frame.name && frame.message) {
                    handle(frame.name, frame.message);
                }
            }
        });
        socket.on('close', () => stop('closed'));
        socket.on('error', () => stop('error'));
    });

    state.listen = () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    state.close = () => new Promise(resolve => server.close(() => resolve()));
    return state;
}

test('wake word → captured audio → STT → answer → TTS url the device fetches', async t => {
    const device = fakeDevice({ speechMs: 600 });
    const port = await device.listen();
    const media = new MediaServer({ port: 0, log: silentLog });
    await media.start();

    const seen = { pcmBytes: 0, question: null, room: null, statuses: [] };
    const satellites = new EsphomeSatellites({
        devices: [{ ip: '127.0.0.1', port, room: 'Wohnzimmer' }],
        language: 'de',
        stt: {
            transcribe: async pcm => {
                seen.pcmBytes = pcm.length;
                return 'wie spät ist es';
            },
        },
        tts: { synthesize: async () => ({ pcm: Buffer.alloc(3200), sampleRate: 16000 }) },
        answer: async (question, ctx) => {
            seen.question = question;
            seen.room = ctx.room;
            return 'Es ist zwölf Uhr';
        },
        media,
        silenceMs: 300,
        log: silentLog,
        onStatus: (_device, _room, status) => seen.statuses.push(status),
        expectsFollowUp: () => false,
    });

    t.after(async () => {
        await satellites.stop();
        await media.stop();
        await device.close();
    });

    await satellites.start();
    await new Promise(resolve => setTimeout(resolve, 3000));

    assert.deepEqual(satellites.devices(), ['fake-speaker'], 'device should be connected by name');
    assert.notEqual(device.stoppedBy, 'runaway', 'the server must stop the mic stream itself');
    assert.ok(device.streamedMs > 0, 'the device should have streamed audio');
    assert.ok(seen.pcmBytes > 0, 'STT should have received the captured audio');
    assert.equal(seen.question, 'wie spät ist es');
    assert.equal(seen.room, 'Wohnzimmer');

    const types = device.events.map(e => e.type);
    for (const [label, type] of [
        ['RUN_START', 1],
        ['STT_START', 3],
        ['STT_VAD_END', 12],
        ['STT_END', 4],
        ['TTS_END', 8],
        ['RUN_END', 2],
    ]) {
        assert.ok(types.includes(type), `missing ${label} event`);
    }
    assert.ok(types.indexOf(12) < types.indexOf(8), 'the mic must be stopped before the reply is sent');

    const ttsEnd = device.events.find(e => e.type === 8);
    assert.match(ttsEnd.data.url, /^http:\/\/127\.0\.0\.1:\d+\/media\/[0-9a-f]+\.wav$/);
    assert.equal(device.fetched.at(-1)?.status, 200, 'the device must be able to fetch the reply');
    assert.equal(device.fetched.at(-1).body.subarray(0, 4).toString(), 'RIFF', 'the reply must be served as a WAV');

    for (const status of ['idle', 'listening', 'processing', 'speaking']) {
        assert.ok(seen.statuses.includes(status), `missing status ${status}`);
    }
});

test('announce reaches a connected satellite as a media url', async t => {
    const device = fakeDevice({ speechMs: 0 });
    const port = await device.listen();
    const media = new MediaServer({ port: 0, log: silentLog });
    await media.start();

    const satellites = new EsphomeSatellites({
        devices: [{ ip: '127.0.0.1', port, room: 'Küche' }],
        language: 'de',
        stt: { transcribe: async () => '' },
        tts: { synthesize: async () => ({ pcm: Buffer.alloc(1600), sampleRate: 16000 }) },
        answer: async () => '',
        media,
        silenceMs: 300,
        log: silentLog,
    });

    t.after(async () => {
        await satellites.stop();
        await media.stop();
        await device.close();
    });

    await satellites.start();
    await new Promise(resolve => setTimeout(resolve, 1500));

    const delivered = await satellites.announce(null, Buffer.alloc(1600), 16000);
    assert.equal(delivered, 1);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(device.fetched.at(-1)?.status, 200);

    assert.equal(device.announces.at(-1).startConversation, false, 'a plain announcement must not open the mic');

    // A question: same path, but the device is asked to listen afterwards (askUser).
    assert.equal(await satellites.announce(null, Buffer.alloc(1600), 16000, true), 1);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(device.announces.at(-1).startConversation, true, 'a question must open the mic');

    assert.equal(await satellites.announce('does-not-exist', Buffer.alloc(16), 16000), 0);
});

// ── wake words ──────────────────────────────────────────────────────────────

/** Bring up a satellite against a fake device and wait until the handshake reported its wake words. */
async function connectedSatellite(t, opts = {}) {
    const device = fakeDevice({ speechMs: 0, ...opts });
    const port = await device.listen();
    const media = new MediaServer({ port: 0, log: silentLog });
    await media.start();
    const reported = [];
    const satellites = new EsphomeSatellites({
        devices: [{ ip: '127.0.0.1', port, room: 'Küche' }],
        language: 'de',
        stt: { transcribe: async () => '' },
        tts: { synthesize: async () => ({ pcm: Buffer.alloc(0), sampleRate: 16000 }) },
        answer: async () => '',
        media,
        silenceMs: 300,
        log: silentLog,
        onWakeWords: (d, room, cfg) => reported.push(cfg),
    });
    t.after(async () => {
        await satellites.stop();
        await media.stop();
        await device.close();
    });
    await satellites.start();
    await new Promise(resolve => setTimeout(resolve, 1200));
    return { device, satellites, reported, name: satellites.devices()[0] };
}

test('wake word configuration is reported on connect', async t => {
    const { reported, satellites, name } = await connectedSatellite(t);
    assert.ok(reported.length >= 1, 'the handshake must report the wake words');
    const cfg = reported[0];
    assert.deepEqual(cfg.active, ['okay_nabu']);
    assert.equal(cfg.max, 2);
    assert.deepEqual(
        cfg.available.map(w => w.id),
        ['okay_nabu', 'hey_jarvis', 'alexa'],
    );
    assert.deepEqual(cfg.available.find(w => w.id === 'okay_nabu').languages, ['en', 'de']);
    assert.deepEqual(satellites.wakeWords(name).active, ['okay_nabu']);
});

test('setting wake words reaches the device and is read back from it', async t => {
    const { device, satellites, reported, name } = await connectedSatellite(t);

    assert.equal(satellites.setWakeWords(name, ['okay_nabu', 'hey_jarvis']), true);
    await new Promise(resolve => setTimeout(resolve, 400));

    assert.deepEqual(device.setConfigCalls.at(-1), ['okay_nabu', 'hey_jarvis'], 'device must receive the ids');
    assert.deepEqual(reported.at(-1).active, ['okay_nabu', 'hey_jarvis'], 'and echo them back to us');
    assert.deepEqual(satellites.wakeWords(name).active, ['okay_nabu', 'hey_jarvis']);
});

test('unknown wake words are dropped rather than sent to the device', async t => {
    const { device, satellites, name } = await connectedSatellite(t);

    satellites.setWakeWords(name, ['okay_nabu', 'not_a_wake_word']);
    await new Promise(resolve => setTimeout(resolve, 400));

    assert.deepEqual(device.setConfigCalls.at(-1), ['okay_nabu'], 'only the known id may be sent');
});

test('more wake words than the device allows are trimmed to its limit', async t => {
    const { device, satellites, name } = await connectedSatellite(t);

    satellites.setWakeWords(name, ['okay_nabu', 'hey_jarvis', 'alexa']); // max is 2
    await new Promise(resolve => setTimeout(resolve, 400));

    assert.equal(device.setConfigCalls.at(-1).length, 2);
    assert.deepEqual(device.setConfigCalls.at(-1), ['okay_nabu', 'hey_jarvis']);
});

test('setting wake words on an unknown satellite reports failure', async t => {
    const { satellites } = await connectedSatellite(t);
    assert.equal(satellites.setWakeWords('no-such-device', ['alexa']), false);
    assert.equal(satellites.wakeWords('no-such-device'), null);
});

// ── device settings (entities) ──────────────────────────────────────────────

test('the device settings a satellite exposes are discovered', async t => {
    const { satellites, name } = await connectedSatellite(t);
    const entities = satellites.entities(name);

    assert.deepEqual(
        entities.map(e => e.objectId),
        ['temperature', 'occupancy', 'wifi_bssid', 'thinking_sound', 'mic_gain', 'mic_noise'],
    );
    const gain = entities.find(e => e.objectId === 'mic_gain');
    assert.equal(gain.kind, 'number');
    assert.equal(gain.min, 0);
    assert.equal(gain.max, 31);
    assert.equal(gain.value, 10, 'the value the device pushed after announcing must be picked up');

    const noise = entities.find(e => e.objectId === 'mic_noise');
    assert.deepEqual(noise.options, ['Off', 'Low', 'Medium', 'High', 'Max']);
    assert.equal(noise.value, 'Medium');
    assert.equal(entities.find(e => e.objectId === 'thinking_sound').value, false);
});

test('a satellite also reports what it measures about its room, read-only', async t => {
    const { satellites, name } = await connectedSatellite(t);
    const entities = satellites.entities(name);

    const temp = entities.find(e => e.objectId === 'temperature');
    assert.equal(temp.kind, 'sensor');
    assert.equal(temp.writable, false);
    assert.equal(temp.unit, '°C');
    assert.equal(temp.decimals, 1);
    // The device sent 21.5 and then a `missing_state` update: the last reading must survive, because
    // "no reading yet" is not the same as 0 degrees.
    assert.equal(temp.value, 21.5);

    const occupancy = entities.find(e => e.objectId === 'occupancy');
    assert.equal(occupancy.kind, 'binarySensor');
    assert.equal(occupancy.writable, false);
    assert.equal(occupancy.value, true);

    const bssid = entities.find(e => e.objectId === 'wifi_bssid');
    assert.equal(bssid.kind, 'textSensor');
    assert.equal(bssid.writable, false);
    assert.equal(bssid.value, 'a4:2b:b0:11:22:33');

    // Read-only means read-only: a write attempt is refused rather than silently sent.
    assert.equal(satellites.setEntity(name, 'temperature', 25), false);
});

test('a setting is written to the device and the reported value comes back', async t => {
    const { device, satellites, name } = await connectedSatellite(t);

    assert.equal(satellites.setEntity(name, 'mic_gain', 20), true);
    assert.equal(satellites.setEntity(name, 'thinking_sound', true), true);
    assert.equal(satellites.setEntity(name, 'mic_noise', 'High'), true);
    await new Promise(resolve => setTimeout(resolve, 400));

    assert.deepEqual(
        device.commands.map(c => [c.kind, c.value]),
        [
            ['number', 20],
            ['switch', true],
            ['select', 'High'],
        ],
    );
    const now = id => satellites.entities(name).find(e => e.objectId === id).value;
    assert.equal(now('mic_gain'), 20);
    assert.equal(now('thinking_sound'), true);
    assert.equal(now('mic_noise'), 'High');
});

test('out-of-range numbers are clamped to what the device allows', async t => {
    const { device, satellites, name } = await connectedSatellite(t);

    satellites.setEntity(name, 'mic_gain', 9999); // max is 31
    satellites.setEntity(name, 'mic_gain', -5); // min is 0
    await new Promise(resolve => setTimeout(resolve, 400));

    assert.deepEqual(
        device.commands.map(c => c.value),
        [31, 0],
    );
});

test('a select takes its own options in any case and rejects anything else', async t => {
    const { device, satellites, name } = await connectedSatellite(t);

    assert.equal(satellites.setEntity(name, 'mic_noise', 'hIgH'), true, 'case must not matter');
    assert.equal(satellites.setEntity(name, 'mic_noise', 'Bogus'), false);
    assert.equal(satellites.setEntity(name, 'no_such_control', 1), false);
    await new Promise(resolve => setTimeout(resolve, 300));

    assert.equal(device.commands.length, 1, 'only the valid write may reach the device');
    assert.equal(device.commands[0].value, 'High', 'and it must be sent with the device spelling');
});

test('timers are mirrored to the satellite as started / updated / cancelled', async t => {
    const { device, satellites, name } = await connectedSatellite(t);

    const timer = { type: 'started', id: 't1', name: 'Nudeln', totalSeconds: 600, secondsLeft: 600, active: true };
    assert.equal(satellites.timerEvent(null, timer), 1, 'a broadcast must reach the connected device');
    assert.equal(satellites.timerEvent(name, { ...timer, type: 'updated', secondsLeft: 540 }), 1);
    assert.equal(satellites.timerEvent(name, { ...timer, type: 'cancelled', secondsLeft: 0, active: false }), 1);
    await new Promise(resolve => setTimeout(resolve, 400));

    assert.deepEqual(
        device.timerEvents.map(e => [e.type, e.left, e.active]),
        [
            [0, 600, true], // started
            [1, 540, true], // updated
            [2, 0, false], // cancelled
        ],
    );
    assert.equal(device.timerEvents[0].name, 'Nudeln');
    assert.equal(device.timerEvents[0].total, 600);
    assert.equal(satellites.timerEvent('no-such-device', timer), 0);
});
