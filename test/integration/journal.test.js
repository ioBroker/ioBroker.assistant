'use strict';
// Integration test: conversation journal — entry lifecycle, async-context recording, retention, persistence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Journal, transportForSource } = require('../../build/lib/journal.js');

const log = { debug() {}, info() {}, warn() {}, error() {} };

test('a request is published when it starts and when it is answered', async () => {
    const seen = [];
    const j = new Journal({ hours: 24, file: '', log, onChange: e => seen.push({ ...e, tools: [...e.tools] }) });
    const answer = await j.run('Licht an', 'Kitchen', { transport: 'esphome', satellite: 'Kitchen', wakeWord: 'okay_nabu', sttMs: 420 }, async () => {
        j.note({ tier: 'nlu', detail: 'on' });
        j.stateAccess('set_state', { id: 'hm.0.light.STATE', value: true });
        return 'Ok.';
    });
    assert.equal(answer, 'Ok.');
    assert.equal(seen[0].done, false);
    assert.equal(seen[0].question, 'Licht an');
    const [entry] = j.list();
    assert.equal(entry.done, true);
    assert.equal(entry.answer, 'Ok.');
    assert.equal(entry.tier, 'nlu');
    assert.equal(entry.wakeWord, 'okay_nabu');
    assert.equal(entry.satellite, 'Kitchen');
    assert.equal(entry.sttMs, 420);
    assert.deepEqual(entry.written, [{ id: 'hm.0.light.STATE', value: true }]);
    assert.equal(typeof entry.ms, 'number');
});

test('tools and state reads go to the entry of their own call chain, even when interleaved', async () => {
    const j = new Journal({ hours: 24, file: '', log });
    const delay = ms => new Promise(r => setTimeout(r, ms));
    await Promise.all([
        j.run('a', 'chat', {}, async () => {
            await delay(10);
            j.stateAccess('get_states', { ids: ['x.0.a', 'x.0.a'] });
            j.tool('get_states', { ids: ['x.0.a'] }, 5, { ok: true });
            return 'A';
        }),
        j.run('b', 'telegram:max', {}, async () => {
            j.stateAccess('set_states', { states: [{ id: 'x.0.b', value: 1 }] });
            await delay(5);
            return 'B';
        }),
    ]);
    const [a, b] = j.list();
    assert.deepEqual(a.read, ['x.0.a']);
    assert.equal(a.tools.length, 1);
    assert.equal(a.tools[0].result, '{"ok":true}');
    assert.equal(a.transport, 'chat');
    assert.deepEqual(b.written, [{ id: 'x.0.b', value: 1 }]);
    assert.equal(b.tools.length, 0);
    assert.equal(b.transport, 'telegram');
});

test('outside of a request nothing is recorded', () => {
    const j = new Journal({ hours: 24, file: '', log });
    j.note({ tier: 'cloud' });
    j.stateAccess('set_state', { id: 'x', value: 1 });
    assert.equal(j.list().length, 0);
});

test('a failing request keeps its error and rethrows', async () => {
    const j = new Journal({ hours: 24, file: '', log });
    await assert.rejects(j.run('q', 'chat', {}, async () => {
        throw new Error('boom');
    }), /boom/);
    assert.equal(j.list()[0].error, 'boom');
    assert.equal(j.list()[0].done, true);
});

test('hours = 0 records nothing but still answers', async () => {
    const j = new Journal({ hours: 0, file: '', log });
    assert.equal(await j.run('q', 'chat', {}, async () => 'x'), 'x');
    assert.equal(j.list().length, 0);
});

test('entries survive a restart, an unfinished one is marked as interrupted, old ones are dropped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
    const file = path.join(dir, 'journal.json');
    const old = { id: 'o', ts: Date.now() - 25 * 3600_000, done: true, source: '', transport: 'state', question: 'alt', tools: [], read: [], written: [] };
    const open = { id: 'p', ts: Date.now() - 1000, done: false, source: 'chat', transport: 'chat', question: 'offen', tools: [], read: [], written: [] };
    fs.writeFileSync(file, JSON.stringify([old, open]));
    const j = new Journal({ hours: 24, file, log });
    await j.load();
    const list = j.list();
    assert.deepEqual(list.map(e => e.id), ['p']);
    assert.equal(list[0].error, 'interrupted');

    await j.run('neu', 'chat', {}, async () => 'ja');
    await j.flush();
    const j2 = new Journal({ hours: 24, file, log });
    await j2.load();
    assert.deepEqual(j2.list().map(e => e.question), ['offen', 'neu']);
    assert.deepEqual(j2.list(list[0].ts).map(e => e.question), ['neu']);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('transport is derived from the source', () => {
    assert.equal(transportForSource('chat'), 'chat');
    assert.equal(transportForSource(''), 'state');
    assert.equal(transportForSource('telegram:Max'), 'telegram');
    assert.equal(transportForSource('wyoming'), 'wyoming');
    assert.equal(transportForSource('myScript'), 'script');
});
