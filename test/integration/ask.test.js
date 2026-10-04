'use strict';
// Integration test: pending questions (askUser) — arming per source, answer routing, timeout, re-arming.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PendingQuestions, ANY_SOURCE } = require('../../build/lib/ask.js');

test('the armed source answers the question', async () => {
    const p = new PendingQuestions();
    const waiting = p.ask(['kitchen'], 'Fenster schließen?', 1000);
    assert.equal(p.has('kitchen'), true);
    assert.equal(p.question('kitchen'), 'Fenster schließen?');
    assert.equal(p.deliver('kitchen', 'ja bitte'), true);
    assert.equal(await waiting, 'ja bitte');
    // Consumed: the next utterance from that source goes back to the normal pipeline.
    assert.equal(p.has('kitchen'), false);
    assert.equal(p.deliver('kitchen', 'nochmal'), false);
});

test('another source is not touched by a targeted question', async () => {
    const p = new PendingQuestions();
    const waiting = p.ask(['kitchen'], 'Fenster schließen?', 1000);
    assert.equal(p.has('living'), false);
    assert.equal(p.deliver('living', 'ja'), false);
    assert.equal(p.deliver('kitchen', 'nein'), true);
    assert.equal(await waiting, 'nein');
});

test('a broadcast question is answered by any source', async () => {
    const p = new PendingQuestions();
    const waiting = p.ask([], 'Wer ist da?', 1000);
    assert.deepEqual(
        p.list().map(e => e.keys),
        [[ANY_SOURCE]],
    );
    assert.equal(p.has('whoever'), true);
    assert.equal(p.deliver('whoever', 'ich'), true);
    assert.equal(await waiting, 'ich');
});

test('one question can be armed for several sources, first answer wins', async () => {
    const p = new PendingQuestions();
    const waiting = p.ask(['kitchen', 'living'], 'Licht aus?', 1000);
    assert.equal(p.list().length, 1); // one question, two keys
    assert.equal(p.deliver('living', 'ja'), true);
    assert.equal(await waiting, 'ja');
    assert.equal(p.has('kitchen'), false); // the other key is released too
});

test('blank text is never an answer', async () => {
    const p = new PendingQuestions();
    const waiting = p.ask(['kitchen'], 'Noch da?', 60);
    assert.equal(p.deliver('kitchen', '   '), false);
    assert.equal(p.has('kitchen'), true);
    assert.equal(await waiting, null); // times out instead
});

test('resolves with null on timeout', async () => {
    const p = new PendingQuestions();
    const t0 = Date.now();
    assert.equal(await p.ask(['kitchen'], 'Noch da?', 40), null);
    assert.ok(Date.now() - t0 >= 35);
    assert.equal(p.has('kitchen'), false);
});

test('the default timeout applies when none is given', async () => {
    const p = new PendingQuestions(40);
    assert.equal(await p.ask(['kitchen'], 'Noch da?'), null);
});

test('a newer question takes the source over from the older one', async () => {
    const p = new PendingQuestions();
    const first = p.ask(['kitchen'], 'Erste Frage?', 1000);
    const second = p.ask(['kitchen'], 'Zweite Frage?', 1000);
    assert.equal(await first, null); // cancelled, never blocks the pipeline
    assert.equal(p.question('kitchen'), 'Zweite Frage?');
    assert.equal(p.deliver('kitchen', 'ja'), true);
    assert.equal(await second, 'ja');
});

test('cancel and cancelAll release their callers', async () => {
    const p = new PendingQuestions();
    const one = p.ask(['kitchen'], 'A?', 1000);
    assert.equal(p.cancel('kitchen'), true);
    assert.equal(await one, null);
    assert.equal(p.cancel('kitchen'), false); // nothing left to cancel

    const two = p.ask(['kitchen'], 'B?', 1000);
    const three = p.ask([ANY_SOURCE], 'C?', 1000);
    p.cancelAll();
    assert.equal(await two, null);
    assert.equal(await three, null);
    assert.deepEqual(p.list(), []);
});
