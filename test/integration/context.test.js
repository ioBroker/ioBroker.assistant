'use strict';
// Integration test: short-term conversation memory (per-source buffer, cap, TTL).
const test = require('node:test');
const assert = require('node:assert/strict');
const { ConversationStore } = require('../../build/lib/context.js');

test('records turns per source and preserves order', () => {
    const s = new ConversationStore(6, 60000);
    s.add('chat', 'Licht an', 'Ok');
    s.add('chat', 'und Küche', 'Küche an');
    const turns = s.get('chat');
    assert.equal(turns.length, 4);
    assert.deepEqual(turns.map(t => t.role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(turns[0].content, 'Licht an');
});

test('sources are isolated', () => {
    const s = new ConversationStore();
    s.add('chat', 'a', 'A');
    s.add('telegram:Max', 'b', 'B');
    assert.equal(s.get('chat').length, 2);
    assert.equal(s.get('telegram:Max').length, 2);
    assert.equal(s.get('unknown').length, 0);
});

test('caps at maxTurns, dropping the oldest', () => {
    const s = new ConversationStore(4, 60000);
    s.add('x', 'q1', 'a1');
    s.add('x', 'q2', 'a2');
    s.add('x', 'q3', 'a3'); // 6 messages → capped to 4
    const turns = s.get('x');
    assert.equal(turns.length, 4);
    assert.equal(turns[0].content, 'q2'); // q1/a1 dropped
});

test('expires after the TTL', async () => {
    const s = new ConversationStore(6, 40);
    s.add('x', 'q', 'a');
    assert.equal(s.get('x').length, 2);
    await new Promise(r => setTimeout(r, 60));
    assert.equal(s.get('x').length, 0);
});

test('empty question or answer is not recorded; clear() resets', () => {
    const s = new ConversationStore();
    s.add('x', '', 'A');
    s.add('x', 'Q', '');
    assert.equal(s.get('x').length, 0);
    s.add('x', 'Q', 'A');
    assert.equal(s.get('x').length, 2);
    s.clear('x');
    assert.equal(s.get('x').length, 0);
});
