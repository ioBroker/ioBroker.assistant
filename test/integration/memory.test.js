'use strict';
// Integration test: long-term memory store (roadmap #6).
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore, buildMemoryPrompt } = require('../../build/lib/memory.js');

function makeStore(opts = {}) {
    let t = 1000;
    const changes = [];
    const store = new MemoryStore({
        now: () => (t += 1000),
        onChange: list => changes.push(list),
        ...opts,
    });
    return { store, changes };
}

test('add, list (newest first), get', () => {
    const { store } = makeStore();
    const a = store.add({ text: 'The daughter is named Lena' });
    const b = store.add({ text: 'The car is a blue VW' });
    assert.equal(store.size(), 2);
    assert.equal(store.list()[0].id, b.id); // newest-updated first
    assert.equal(store.get(a.id).text, 'The daughter is named Lena');
});

test('empty text is ignored', () => {
    const { store } = makeStore();
    assert.equal(store.add({ text: '   ' }), null);
    assert.equal(store.size(), 0);
});

test('dedup by key updates in place', () => {
    const { store } = makeStore();
    const a = store.add({ text: 'Daughter: Lena', key: 'daughter' });
    const b = store.add({ text: 'Daughter: Lena Marie', key: 'daughter' });
    assert.equal(a.id, b.id);
    assert.equal(store.size(), 1);
    assert.equal(store.get(a.id).text, 'Daughter: Lena Marie');
});

test('dedup by identical text (no key)', () => {
    const { store } = makeStore();
    store.add({ text: 'WiFi password is 1234' });
    store.add({ text: 'wifi password is 1234' }); // case-insensitive
    assert.equal(store.size(), 1);
});

test('forget by id and by key', () => {
    const { store } = makeStore();
    const a = store.add({ text: 'fact A', key: 'a' });
    store.add({ text: 'fact B', key: 'b' });
    assert.equal(store.forget('b'), 1); // by key
    assert.equal(store.forget(a.id), 1); // by id
    assert.equal(store.size(), 0);
    assert.equal(store.forget('missing'), 0);
});

test('update text; empty update removes', () => {
    const { store } = makeStore();
    const a = store.add({ text: 'old' });
    assert.equal(store.update(a.id, 'new'), true);
    assert.equal(store.get(a.id).text, 'new');
    assert.equal(store.update(a.id, '  '), true); // empties → removed
    assert.equal(store.size(), 0);
});

test('cap drops the oldest', () => {
    const { store } = makeStore({ maxEntries: 3 });
    const ids = ['a', 'b', 'c', 'd'].map(k => store.add({ text: k, key: k }).id);
    assert.equal(store.size(), 3);
    assert.equal(store.get(ids[0]), undefined); // oldest 'a' dropped
    assert.ok(store.get(ids[3])); // newest 'd' kept
});

test('text is truncated to maxTextLength', () => {
    const { store } = makeStore({ maxTextLength: 10 });
    const e = store.add({ text: 'x'.repeat(50) });
    assert.equal(e.text.length, 10);
});

test('clear removes everything', () => {
    const { store } = makeStore();
    store.add({ text: 'a' });
    store.add({ text: 'b' });
    assert.equal(store.clear(), 2);
    assert.equal(store.size(), 0);
});

test('restore round-trips the persisted list', () => {
    const { store } = makeStore();
    store.add({ text: 'keep me', key: 'k' });
    const json = JSON.parse(JSON.stringify(store.list()));
    const { store: store2 } = makeStore();
    assert.equal(store2.restore(json), 1);
    assert.equal(store2.list()[0].text, 'keep me');
    assert.equal(store2.restore([{ bad: true }, null]), 0); // invalid entries skipped
});

test('buildMemoryPrompt: header + facts, or empty', () => {
    assert.equal(buildMemoryPrompt([], 'en'), '');
    const list = [
        { id: '1', text: 'Daughter is Lena', key: '', source: '', createdAt: 0, updatedAt: 2 },
        { id: '2', text: 'Car is blue', key: '', source: '', createdAt: 0, updatedAt: 1 },
    ];
    const en = buildMemoryPrompt(list, 'en');
    assert.match(en, /Known facts/);
    assert.match(en, /- Daughter is Lena/);
    assert.match(en, /- Car is blue/);
    assert.match(buildMemoryPrompt(list, 'de'), /Bekannte Fakten/);
    assert.match(buildMemoryPrompt(list, 'ru'), /Известные факты/);
});

test('buildMemoryPrompt respects the character budget', () => {
    const list = Array.from({ length: 100 }, (_, i) => ({
        id: String(i),
        text: 'fact number ' + i,
        key: '',
        source: '',
        createdAt: 0,
        updatedAt: i,
    }));
    const out = buildMemoryPrompt(list, 'en', 120);
    assert.ok(out.length <= 140); // header + a couple of lines, not all 100
});
