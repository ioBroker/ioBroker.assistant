'use strict';
// Integration test: conversation journal — entry lifecycle, async-context recording, retention, persistence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Journal, transportForSource, snapshot, traceDirFor } = require('../../build/lib/journal.js');

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

test('the trace records each step with its timing, tokens and a snapshot of its data', async () => {
    const j = new Journal({ hours: 24, file: '', log });
    let id;
    await j.run('wie warm ist es', 'chat', {}, async () => {
        id = j.list()[0].id;
        const messages = [{ role: 'user', content: 'x' }];
        j.step({ stage: 'cloud', title: 'Round 1', ms: 5, tokens: { input: 100, output: 7, cacheRead: 90 }, data: { sent: messages } });
        messages.push({ role: 'assistant', content: 'later change' });
        j.step({ stage: 'cloud', title: 'Round 2', tokens: { input: 50, output: 3 } });
        return '21 Grad';
    });
    const steps = await j.trace(id);
    assert.deepEqual(steps.map(s => s.stage), ['request', 'cloud', 'cloud']);
    assert.equal(steps[0].data.question, 'wie warm ist es');
    assert.equal(steps[1].ms, 5);
    assert.ok(steps[1].t <= steps[2].t, 't is the start of a step: its duration is subtracted');
    assert.deepEqual(steps[1].data.sent, [{ role: 'user', content: 'x' }], 'data is copied when recorded');
    assert.deepEqual(j.list()[0].tokens, { input: 150, output: 10, cacheRead: 90 });
});

test('a state call inside an LLM tool is that tool\'s step, a direct one is a step of its own', async () => {
    const j = new Journal({ hours: 24, file: '', log });
    let id;
    await j.run('Licht an', 'chat', {}, async () => {
        id = j.list()[0].id;
        await j.stateCall('get_states', { ids: ['a.0.x'] }, async () => ({ 'a.0.x': 1 }));
        await j.toolCall('set_state', { id: 'a.0.y', value: true }, () =>
            j.stateCall('set_state', { id: 'a.0.y', value: true }, async () => ({ ok: true })),
        );
        await assert.rejects(j.toolCall('get_logs', {}, async () => {
            throw new Error('denied');
        }), /denied/);
        return 'Ok.';
    });
    const steps = await j.trace(id);
    assert.deepEqual(steps.map(s => `${s.stage}:${s.title}`), [
        'request:Request from chat (chat)',
        'state:get_states',
        'tool:Tool set_state',
        'tool:Tool get_logs failed: denied',
    ]);
    assert.deepEqual(steps[1].data.result, { 'a.0.x': 1 });
    assert.equal(steps[3].level, 'error');
    const [entry] = j.list();
    assert.deepEqual(entry.read, ['a.0.x']);
    assert.deepEqual(entry.written, [{ id: 'a.0.y', value: true }]);
    assert.deepEqual(entry.tools.map(t => t.name), ['set_state', 'get_logs']);
    assert.equal(entry.tools[1].error, 'denied');
});

test('a failure ends the trace with the error and its stack', async () => {
    const j = new Journal({ hours: 24, file: '', log });
    const err = Object.assign(new Error('429 rate limited'), { status: 429, error: { type: 'rate_limit' } });
    await assert.rejects(j.run('q', 'chat', {}, async () => {
        throw err;
    }));
    const steps = await j.trace(j.list()[0].id);
    const last = steps.at(-1);
    assert.equal(last.stage, 'error');
    assert.equal(last.data.status, 429);
    assert.deepEqual(last.data.error, { type: 'rate_limit' });
    assert.match(last.data.stack, /429 rate limited/);
});

test('the synthesis of a reply is added to the latest request of its source', async () => {
    const seen = [];
    const j = new Journal({ hours: 24, file: '', log, onChange: e => seen.push(e.ttsMs) });
    await j.run('erste', 'Kitchen', { sttMs: 300, audioMs: 1800 }, async () => 'eins');
    await j.run('zweite', 'Kitchen', {}, async () => 'zwei');
    await j.run('andere', 'Office', {}, async () => 'drei');
    j.spoken('Kitchen', { ms: 420, audioMs: 1234.5, provider: 'azure', voice: 'de-DE-KatjaNeural' });
    j.spoken('Kitchen', { ms: 999, audioMs: 1, provider: 'azure' });
    const [first, second, other] = j.list();
    assert.equal(first.audioMs, 1800);
    assert.equal(first.ttsMs, undefined);
    assert.equal(second.ttsMs, 420, 'the newest one, and only once');
    assert.equal(second.replyAudioMs, 1235);
    assert.equal(other.ttsMs, undefined);
    assert.equal(seen.at(-1), 420, 'published, so the chat updates');
    const steps = await j.trace(second.id);
    assert.equal(steps.at(-1).stage, 'tts');
    assert.match(steps.at(-1).title, /azure \(de-DE-KatjaNeural\), 1\.2 s/);
});

test('long strings are cut and buffers summarised in a snapshot', () => {
    const out = snapshot({ text: 'x'.repeat(100_010), pcm: Buffer.alloc(32000), n: 1n });
    assert.match(out.text, /… \[\+10 chars\]$/);
    assert.equal(out.pcm, '<32000 bytes>');
    assert.equal(out.n, '1');
});

test('traces are kept in files, read back after a restart and deleted with their request', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
    const file = path.join(dir, 'journal.json');
    const j = new Journal({ hours: 24, file, log });
    await j.run('Licht an', 'chat', {}, async () => {
        j.step({ stage: 'nlu', title: 'NLU: on Licht' });
        return 'Ok.';
    });
    const { id } = j.list()[0];
    await j.flush();
    assert.ok(fs.existsSync(path.join(traceDirFor(file), `${id}.json`)));

    const j2 = new Journal({ hours: 24, file, log });
    await j2.load();
    assert.deepEqual((await j2.trace(id)).map(s => s.stage), ['request', 'nlu']);
    assert.equal(await j2.trace('../journal'), null, 'an id is never a path');
    assert.equal(await j2.trace('unknown'), null);

    j2.clear();
    await j2.flush();
    assert.deepEqual(fs.readdirSync(traceDirFor(file)), []);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('only the newest traces stay in memory when there is no file to read the others back from', async () => {
    const j = new Journal({ hours: 24, file: '', log });
    for (let i = 0; i < 205; i++) {
        await j.run(`q${i}`, 'chat', {}, async () => 'a');
    }
    const entries = j.list();
    assert.equal(await j.trace(entries[0].id), null);
    assert.ok(await j.trace(entries.at(-1).id));
});

test('transport is derived from the source', () => {
    assert.equal(transportForSource('chat'), 'chat');
    assert.equal(transportForSource(''), 'state');
    assert.equal(transportForSource('telegram:Max'), 'telegram');
    assert.equal(transportForSource('wyoming'), 'wyoming');
    assert.equal(transportForSource('myScript'), 'script');
});
