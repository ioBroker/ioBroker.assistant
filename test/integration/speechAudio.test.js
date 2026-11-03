'use strict';

// Audio for speech recognition: cut to the speech, quiet speech amplified (src/lib/voice/speechAudio.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareForStt, PRE_ROLL_MS, TAIL_MS, MAX_GAIN, TARGET_PEAK } = require('../../build/lib/voice/speechAudio.js');
const { rms } = require('../../build/lib/voice/vad.js');

const RATE = 16000;

/** A sine of `ms` at peak `amplitude` (RMS = amplitude / √2). */
function tone(ms, amplitude, freq = 180) {
    const n = Math.round((RATE * ms) / 1000);
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
        buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / RATE) * amplitude), i * 2);
    }
    return buf;
}

/** Room noise of `ms` at about the given RMS. */
function noise(ms, level) {
    const n = Math.round((RATE * ms) / 1000);
    const buf = Buffer.alloc(n * 2);
    const a = level * Math.sqrt(3);
    for (let i = 0; i < n; i++) {
        buf.writeInt16LE(Math.round((Math.random() * 2 - 1) * a), i * 2);
    }
    return buf;
}

const lengthMs = pcm => pcm.length / 2 / (RATE / 1000);

test('a follow-up answer loses the beep and the silence around it, and quiet speech is amplified', () => {
    // The shape of the real capture: device beep, a second of digital silence, quiet speech, the closing silence.
    const recording = Buffer.concat([tone(250, 4000, 300), noise(1000, 8), tone(1500, 600), noise(1200, 8)]);
    const speech = prepareForStt(recording, RATE, { startMs: 1250, endLevel: 150 });

    assert.equal(speech.fromMs, 1250 - PRE_ROLL_MS, 'starts a little before the detected speech');
    assert.ok(Math.abs(speech.toMs - (2750 + TAIL_MS)) <= 30, `ends a little after the last sound (${speech.toMs})`);
    assert.equal(lengthMs(speech.pcm), speech.toMs - speech.fromMs, 'the audio is exactly the reported cut');
    assert.equal(speech.gain, MAX_GAIN, 'peak 600 is far below the target, so the gain is capped');
    const middle = speech.pcm.subarray((PRE_ROLL_MS + 500) * 32, (PRE_ROLL_MS + 1000) * 32);
    assert.ok(Math.abs(rms(middle) - (600 * MAX_GAIN) / Math.SQRT2) < 50, `speech is louder now (${rms(middle)})`);
});

test('a quiet last syllable after a short gap stays in', () => {
    const recording = Buffer.concat([noise(700, 8), tone(1000, 600), noise(300, 8), tone(200, 100), noise(1200, 8)]);
    const speech = prepareForStt(recording, RATE, { startMs: 700, endLevel: 150 });
    // The syllable (RMS 71) is below the silence threshold 150 but above 40 % of it.
    assert.ok(speech.toMs >= 2200 + TAIL_MS - 30, `the syllable ending at 2.2 s is kept (${speech.toMs})`);
});

test('in a noisy room the tail is kept as it is', () => {
    const recording = Buffer.concat([noise(500, 200), tone(1000, 2000), noise(1500, 200)]);
    const speech = prepareForStt(recording, RATE, { startMs: 500, endLevel: 300 });
    assert.equal(speech.toMs, 3000, 'noise above 40 % of the silence threshold counts as sound');
    assert.equal(speech.fromMs, 100);
});

test('loud speech goes through unchanged', () => {
    const recording = Buffer.concat([noise(600, 10), tone(800, 20000), noise(1000, 10)]);
    const speech = prepareForStt(recording, RATE, { startMs: 600, endLevel: 150 });
    assert.equal(speech.gain, 1);
    assert.ok(speech.pcm.equals(recording.subarray(speech.fromMs * 32, speech.toMs * 32)), 'samples untouched');
});

test('a gain never pushes samples past full scale', () => {
    // One loud click among quiet speech: the peak decides the gain, nothing clips.
    const recording = Buffer.concat([tone(500, 300), tone(5, 3000), tone(500, 300)]);
    const speech = prepareForStt(recording, RATE, { startMs: 0, endLevel: 150 });
    assert.ok(Math.abs(speech.gain - TARGET_PEAK / 3000) < 0.01, `gain from the click (${speech.gain})`);
    let peak = 0;
    for (let i = 0; i < speech.pcm.length; i += 2) {
        peak = Math.max(peak, Math.abs(speech.pcm.readInt16LE(i)));
    }
    assert.ok(peak <= TARGET_PEAK + 1, `peak ${peak}`);
});

test('without a detected start the recording keeps its beginning, and a cut never gets too short', () => {
    const recording = Buffer.concat([tone(300, 600), noise(1000, 8)]);
    assert.equal(prepareForStt(recording, RATE, { endLevel: 150 }).fromMs, 0);
    const late = prepareForStt(recording, RATE, { startMs: 1250, endLevel: 150 });
    assert.ok(late.toMs - late.fromMs >= 600, `at least 600 ms (${late.fromMs}–${late.toMs})`);
});
