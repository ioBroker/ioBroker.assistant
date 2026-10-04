'use strict';
// Integration test: the confirmation beep.
const test = require('node:test');
const assert = require('node:assert/strict');
const { confirmationTone } = require('../../build/lib/voice/tone.js');

test('the tone is mono 16-bit PCM of the requested length', () => {
    const { pcm, sampleRate } = confirmationTone();
    assert.equal(sampleRate, 24000);
    assert.equal(pcm.length, 2 * Math.round(24000 * 0.3), '16 bit per sample, 300 ms');
    assert.equal(pcm.length % 2, 0);
});

test('it starts quietly, peaks early and decays — no click, no drone', () => {
    const { pcm } = confirmationTone();
    const at = ms => Math.abs(pcm.readInt16LE(Math.round((24000 * ms) / 1000) * 2));
    assert.equal(pcm.readInt16LE(0), 0, 'starts at zero (a hard start would click)');
    const peak = Math.max(at(10), at(11), at(12));
    assert.ok(peak > 3000, `audible after the attack (peak ${peak})`);
    const late = Math.max(...Array.from({ length: 20 }, (_, i) => at(280 + i)));
    assert.ok(late < peak / 4, `faded out by the end (${late} vs ${peak})`);
});

test('options change it, and the result is deterministic', () => {
    const a = confirmationTone({ duration: 0.1, sampleRate: 16000, freq: 880, volume: 0.2 });
    const b = confirmationTone({ duration: 0.1, sampleRate: 16000, freq: 880, volume: 0.2 });
    assert.equal(a.sampleRate, 16000);
    assert.equal(a.pcm.length, 2 * 1600);
    assert.deepEqual(a.pcm, b.pcm, 'same options → same bytes');

    const loud = confirmationTone({ volume: 1 });
    const quiet = confirmationTone({ volume: 0.1 });
    const peak = buf => Math.max(...Array.from({ length: 500 }, (_, i) => Math.abs(buf.readInt16LE(i * 2))));
    assert.ok(peak(loud.pcm) > peak(quiet.pcm) * 5);
});

test('extreme options are clamped instead of producing garbage', () => {
    assert.equal(confirmationTone({ duration: 0 }).pcm.length, 2 * Math.round(24000 * 0.05), 'minimum length');
    const over = confirmationTone({ volume: 5 });
    const peak = Math.max(...Array.from({ length: 1000 }, (_, i) => Math.abs(over.pcm.readInt16LE(i * 2))));
    assert.ok(peak <= 32767, 'never clips past the 16-bit range');
});
