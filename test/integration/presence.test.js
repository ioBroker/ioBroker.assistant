'use strict';
// Integration test: presence tracking — value interpretation, arrival/departure, the home flag, the prompt.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    PresenceTracker,
    interpretHome,
    parsePresenceRows,
    buildPresencePrompt,
} = require('../../build/lib/presence.js');

const silentLog = { debug() {}, info() {}, warn() {} };

test('interpretHome understands booleans, the numeric 1 and the usual words', () => {
    assert.equal(interpretHome(true), true);
    assert.equal(interpretHome(false), false);
    assert.equal(interpretHome(1), true);
    assert.equal(interpretHome(0), false);
    assert.equal(interpretHome(2), false, 'only 1 means home for a numeric state');
    assert.equal(interpretHome('home'), true);
    assert.equal(interpretHome('ANWESEND'), true);
    assert.equal(interpretHome('away'), false);
    assert.equal(interpretHome('false'), false);
});

test('interpretHome leaves an unknown value unknown instead of reading it as away', () => {
    assert.equal(interpretHome('on holiday'), null);
    assert.equal(interpretHome(undefined), null);
    assert.equal(interpretHome(null), null);
    assert.equal(interpretHome(''), null);
});

test('an explicit homeValue overrides the defaults and compares loosely', () => {
    assert.equal(interpretHome(3, '3'), true, 'a numeric state where 3 means home');
    assert.equal(interpretHome(1, '3'), false);
    assert.equal(interpretHome('Zuhause', 'zuhause'), true, 'case does not matter');
    assert.equal(interpretHome(false, 'true'), false);
    assert.equal(interpretHome(true, 'true'), true);
});

test('parsePresenceRows trims, defaults the name and kind, and skips empty or duplicate rows', () => {
    const list = parsePresenceRows([
        { id: ' ping.0.phone-denis.alive ', name: ' Denis ' },
        { id: 'residents.0.tom.presence', name: '', kind: 'GUEST' },
        { id: 'ping.0.cat.alive', name: 'Rex', kind: 'pet' },
        { id: 'x.0.y', name: 'Who', kind: 'alien' },
        { id: '' },
        { id: 'ping.0.phone-denis.alive', name: 'Denis again' },
    ]);
    assert.deepEqual(
        list.map(p => [p.id, p.name, p.kind]),
        [
            ['ping.0.phone-denis.alive', 'Denis', 'person'],
            ['residents.0.tom.presence', 'presence', 'guest'],
            ['ping.0.cat.alive', 'Rex', 'pet'],
            ['x.0.y', 'Who', 'person'],
        ],
        'an unnamed entry falls back to the last segment, an unknown kind to person, duplicates are dropped',
    );
});

test('the first value never counts as an arrival, the transition does', () => {
    const events = [];
    const t = new PresenceTracker({
        entries: parsePresenceRows([{ id: 'p.denis', name: 'Denis' }]),
        onArrival: who => events.push(`+${who.name}`),
        onDeparture: who => events.push(`-${who.name}`),
        log: silentLog,
    });
    assert.equal(t.update('p.denis', true), null, 'reading the current value is not an arrival');
    assert.deepEqual(events, []);
    assert.equal(t.anyoneHome(), true);

    assert.equal(t.update('p.denis', true), null, 'the same value again changes nothing');
    assert.equal(t.update('p.denis', false), 'left');
    assert.equal(t.update('p.denis', true), 'arrived');
    assert.deepEqual(events, ['-Denis', '+Denis']);
    assert.equal(t.update('p.unknown', true), null, 'a state nobody configured is ignored');
});

test('a value that stops being understood reports no event and clears the presence', () => {
    const events = [];
    const t = new PresenceTracker({
        entries: parsePresenceRows([{ id: 'p.denis', name: 'Denis' }]),
        onDeparture: who => events.push(who.name),
        log: silentLog,
    });
    t.update('p.denis', true);
    assert.equal(t.update('p.denis', 'on holiday'), null, 'unknown is not a departure');
    assert.deepEqual(events, []);
    assert.equal(t.anyoneHome(), false, 'but it no longer counts as home either');
    assert.deepEqual(t.away(), [], 'and it is not "away" either — we simply do not know');
});

test('pets do not make a house occupied, guests do', () => {
    const t = new PresenceTracker({
        entries: parsePresenceRows([
            { id: 'p.cat', name: 'Rex', kind: 'pet' },
            { id: 'p.tom', name: 'Tom', kind: 'guest' },
        ]),
        log: silentLog,
    });
    t.update('p.cat', true);
    assert.equal(t.anyoneHome(), false, 'the cat will not pass the message on');
    t.update('p.tom', true);
    assert.equal(t.anyoneHome(), true);
    assert.deepEqual(
        t.home().map(p => p.name),
        ['Rex', 'Tom'],
        'home() still lists the pet',
    );
});

test('stateIds reports what to subscribe to, and configured says whether anything is set up', () => {
    const empty = new PresenceTracker({ entries: [], log: silentLog });
    assert.equal(empty.configured, false);
    assert.deepEqual(empty.stateIds(), []);
    assert.equal(empty.anyoneHome(), false, 'nothing configured = nobody known (the caller must not gate on it)');

    const t = new PresenceTracker({ entries: parsePresenceRows([{ id: 'a.b' }, { id: 'c.d' }]), log: silentLog });
    assert.equal(t.configured, true);
    assert.deepEqual(t.stateIds(), ['a.b', 'c.d']);
});

test('onChange fires on every change, for the state mirror', () => {
    const seen = [];
    const t = new PresenceTracker({
        entries: parsePresenceRows([{ id: 'p.denis', name: 'Denis' }]),
        onChange: list => seen.push(list.map(p => p.home)),
        log: silentLog,
    });
    t.update('p.denis', true);
    t.update('p.denis', true); // no change → no callback
    t.update('p.denis', false);
    assert.deepEqual(seen, [[true], [false]]);
});

test('buildPresencePrompt renders one localized line and marks guests and pets', () => {
    const t = new PresenceTracker({
        entries: parsePresenceRows([
            { id: 'p.denis', name: 'Denis' },
            { id: 'p.anna', name: 'Anna' },
            { id: 'p.tom', name: 'Tom', kind: 'guest' },
            { id: 'p.rex', name: 'Rex', kind: 'pet' },
        ]),
        log: silentLog,
    });
    t.update('p.denis', true);
    t.update('p.anna', false);
    t.update('p.tom', true);
    t.update('p.rex', true);

    assert.equal(buildPresencePrompt(t.list(), 'de'), 'Zuhause: Denis, Tom (Gast), Rex (Haustier); nicht zuhause: Anna.');
    assert.equal(buildPresencePrompt(t.list(), 'en'), 'At home: Denis, Tom (guest), Rex (pet); away: Anna.');
    assert.match(buildPresencePrompt(t.list(), 'ru'), /^Дома: Denis, Tom \(гость\)/);
});

test('buildPresencePrompt says nobody is home, but stays empty while nothing is known', () => {
    const t = new PresenceTracker({
        entries: parsePresenceRows([{ id: 'p.denis', name: 'Denis' }]),
        log: silentLog,
    });
    assert.equal(buildPresencePrompt(t.list(), 'de'), '', 'unknown is not a statement');
    t.update('p.denis', false);
    assert.equal(buildPresencePrompt(t.list(), 'de'), 'Niemand ist zuhause; nicht zuhause: Denis.');
    assert.equal(buildPresencePrompt(t.list(), 'en'), 'Nobody is at home; away: Denis.');
});

test('an object value is not presence (and never becomes "[object Object]")', () => {
    assert.equal(interpretHome({ val: true }), null);
    assert.equal(interpretHome([1]), null);
    assert.equal(interpretHome({ val: true }, 'true'), null, 'not even with an explicit home value');
});
