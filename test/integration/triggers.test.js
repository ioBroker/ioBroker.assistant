'use strict';
// Integration test: proactive triggers — transitions, also/unless, cooldown, delay/cancelWhen, time triggers.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    TriggerEngine,
    parseDelay,
    parseTimeOfDay,
    effectiveActions,
    referencedStates,
    valueMatches,
    validate,
    parseTriggerRows,
} = require('../../build/lib/triggers.js');

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

/** Engine on a mocked clock with no real timers; `states` backs getState, `fired` records executions. */
function engine(defs, states = {}) {
    const clock = { ms: Date.parse('2026-10-04T12:00:00') };
    const fired = [];
    const changes = [];
    const e = new TriggerEngine({
        getState: async id => states[id],
        execute: def => {
            fired.push(def.id);
        },
        onChange: status => changes.push(status),
        log: silentLog,
        now: () => clock.ms,
        manualTick: true,
    });
    e.load(defs);
    return { e, fired, changes, clock, states };
}

// ── helpers ─────────────────────────────────────────────────────────────────

test('parseDelay understands units, plain seconds and nonsense', () => {
    assert.equal(parseDelay('90s'), 90);
    assert.equal(parseDelay('30m'), 1800);
    assert.equal(parseDelay('5h'), 18000);
    assert.equal(parseDelay('2d'), 172800);
    assert.equal(parseDelay('45'), 45);
    assert.equal(parseDelay(120), 120);
    assert.equal(parseDelay(undefined), 0);
    assert.equal(parseDelay(''), 0);
    assert.equal(parseDelay('soon'), -1);
});

test('parseTimeOfDay accepts HH:MM only', () => {
    assert.deepEqual(parseTimeOfDay('23:00'), { hour: 23, minute: 0 });
    assert.deepEqual(parseTimeOfDay('7:05'), { hour: 7, minute: 5 });
    assert.equal(parseTimeOfDay('24:00'), null);
    assert.equal(parseTimeOfDay('7'), null);
    assert.equal(parseTimeOfDay(undefined), null);
});

test('the say/room shorthand folds into one action; a list wins and inherits the room', () => {
    assert.deepEqual(effectiveActions({ id: 'a', when: {}, say: 'Hallo', room: 'Küche' }), [
        { say: 'Hallo', room: 'Küche' },
    ]);
    assert.deepEqual(effectiveActions({ id: 'a', when: {}, say: 'ignored', room: 'Küche', actions: [{ say: 'X' }] }), [
        { say: 'X', room: 'Küche' },
    ]);
    assert.deepEqual(effectiveActions({ id: 'a', when: {} }), []);
});

test('referencedStates covers when, also, unless, groups and cancelWhen', () => {
    const ids = referencedStates({
        id: 't',
        when: [
            { state: 'a.0.x', value: true, also: { op: 'or', conditions: [{ state: 'a.0.y', above: 1 }] } },
            { time: '23:00', unless: { state: 'a.0.z', value: true } },
        ],
        cancelWhen: { state: 'a.0.c', value: false },
        say: 'hi',
    });
    assert.deepEqual(ids.sort(), ['a.0.c', 'a.0.x', 'a.0.y', 'a.0.z']);
});

test('valueMatches: exact value, thresholds, loose types, no filter', () => {
    assert.equal(valueMatches({ value: true }, true), true);
    assert.equal(valueMatches({ value: true }, 'true'), true, 'a string state matches a boolean config');
    assert.equal(valueMatches({ value: 20 }, '20'), true);
    assert.equal(valueMatches({ value: true }, false), false);
    assert.equal(valueMatches({ above: 12 }, 15), true);
    assert.equal(valueMatches({ above: 12 }, 12), false);
    assert.equal(valueMatches({ below: 12 }, 5), true);
    assert.equal(valueMatches({ below: 12 }, 'warm'), false, 'non-numeric never passes a threshold');
    assert.equal(valueMatches({}, 'anything'), true, 'no filter = any change');
    assert.equal(valueMatches({ value: true }, undefined), false);
});

// ── state triggers ──────────────────────────────────────────────────────────

test('fires on the transition into the condition, not on a repeated value', async () => {
    const { e, fired } = engine([{ id: 't1', when: { state: 'w.open', value: true }, say: 'Fenster offen', cooldownSec: 0 }]);
    await e.onStateChange('w.open', false);
    assert.deepEqual(fired, [], 'false does not match');
    await e.onStateChange('w.open', true);
    assert.deepEqual(fired, ['t1']);
    await e.onStateChange('w.open', true);
    assert.deepEqual(fired, ['t1'], 'the same value again is not a transition');
    await e.onStateChange('w.open', false);
    await e.onStateChange('w.open', true);
    assert.deepEqual(fired, ['t1', 't1'], 'a real transition fires again');
});

test('any of several when alternatives is enough (OR)', async () => {
    const { e, fired } = engine([
        { id: 't', when: [{ state: 'a', value: true }, { state: 'b', above: 10 }], say: 'x', cooldownSec: 0 },
    ]);
    await e.onStateChange('b', 11);
    await e.onStateChange('a', true);
    assert.deepEqual(fired, ['t', 't']);
});

test('also must hold — including an OR group — and an unknown state blocks it', async () => {
    const { e, fired } = engine(
        [
            {
                id: 'cold',
                when: { state: 'w.open', value: true, also: { state: 'temp', below: 12 } },
                say: 'kalt',
                cooldownSec: 0,
            },
        ],
        { temp: 20 },
    );
    await e.onStateChange('w.open', true);
    assert.deepEqual(fired, [], 'too warm');

    const warm = engine(
        [
            {
                id: 'cold',
                when: { state: 'w.open', value: true, also: { state: 'temp', below: 12 } },
                say: 'kalt',
                cooldownSec: 0,
            },
        ],
        { temp: 5 },
    );
    await warm.e.onStateChange('w.open', true);
    assert.deepEqual(warm.fired, ['cold']);

    const group = engine(
        [
            {
                id: 'g',
                when: {
                    state: 'w.open',
                    value: true,
                    also: { op: 'or', conditions: [{ state: 'temp', below: 12 }, { state: 'rain', value: true }] },
                },
                say: 'x',
                cooldownSec: 0,
            },
        ],
        { temp: 20, rain: true },
    );
    await group.e.onStateChange('w.open', true);
    assert.deepEqual(group.fired, ['g'], 'the OR branch that holds is enough');

    const unknown = engine([
        { id: 'u', when: { state: 'w.open', value: true, also: { state: 'nope', value: true } }, say: 'x' },
    ]);
    await unknown.e.onStateChange('w.open', true);
    assert.deepEqual(unknown.fired, [], 'an unreadable also-state blocks');
});

test('unless blocks while it holds; an unknown state does not block', async () => {
    const away = engine(
        [{ id: 't', when: { state: 'w.open', value: true, unless: { state: 'away', value: true } }, say: 'x' }],
        { away: true },
    );
    await away.e.onStateChange('w.open', true);
    assert.deepEqual(away.fired, [], 'blocked while away');

    const home = engine(
        [{ id: 't', when: { state: 'w.open', value: true, unless: { state: 'away', value: true } }, say: 'x' }],
        { away: false },
    );
    await home.e.onStateChange('w.open', true);
    assert.deepEqual(home.fired, ['t']);

    const unknown = engine([
        { id: 't', when: { state: 'w.open', value: true, unless: { state: 'nope', value: true } }, say: 'x' },
    ]);
    await unknown.e.onStateChange('w.open', true);
    assert.deepEqual(unknown.fired, ['t'], 'an unreadable unless-state must not block');
});

test('the cooldown suppresses the next firing until it has passed', async () => {
    const { e, fired, clock } = engine([
        { id: 't', when: { state: 'x', value: true }, say: 'x', cooldownSec: 60 },
    ]);
    await e.onStateChange('x', true);
    await e.onStateChange('x', false);
    await e.onStateChange('x', true);
    assert.deepEqual(fired, ['t'], 'second transition is inside the cooldown');
    clock.ms += 61_000;
    await e.onStateChange('x', false);
    await e.onStateChange('x', true);
    assert.deepEqual(fired, ['t', 't']);
});

// ── delay / cancelWhen ──────────────────────────────────────────────────────

test('a delayed trigger runs only after the wait, and cancelWhen aborts it', async () => {
    const { e, fired, clock } = engine([
        {
            id: 'fryer',
            when: { state: 'fryer.on', value: true },
            delay: '5h',
            cancelWhen: { state: 'fryer.on', value: false },
            say: 'noch an',
            cooldownSec: 0,
        },
    ]);
    await e.onStateChange('fryer.on', true);
    assert.deepEqual(fired, [], 'nothing yet');
    assert.ok(e.list()[0].pendingUntil > clock.ms, 'the pending delay is visible in the status');

    // Switched off in time → the pending action is dropped.
    await e.onStateChange('fryer.on', false);
    assert.equal(e.list()[0].pendingUntil, 0);
    clock.ms += 6 * 3600 * 1000;
    await e.tick();
    assert.deepEqual(fired, [], 'cancelled, so it never runs');

    // On again and left alone → it fires when the delay is over.
    await e.onStateChange('fryer.on', true);
    clock.ms += 5 * 3600 * 1000;
    await e.tick();
    assert.deepEqual(fired, ['fryer']);
});

test('a running delay is not re-armed by further transitions', async () => {
    const { e, fired, clock } = engine([
        { id: 't', when: { state: 'x', value: true }, delay: '60s', say: 'x', cooldownSec: 0 },
    ]);
    await e.onStateChange('x', true);
    await e.onStateChange('x', false);
    await e.onStateChange('x', true);
    clock.ms += 61_000;
    await e.tick();
    assert.deepEqual(fired, ['t'], 'exactly one run');
});

// ── time triggers ───────────────────────────────────────────────────────────

test('a time trigger schedules the next occurrence and re-arms after firing', async () => {
    const { e, fired, clock } = engine([{ id: 'doors', when: { time: '23:00' }, say: 'Türen', cooldownSec: 0 }]);
    const first = e.list()[0].nextFireAt;
    assert.equal(new Date(first).getHours(), 23);
    assert.ok(first > clock.ms);

    clock.ms = first;
    await e.tick();
    assert.deepEqual(fired, ['doors']);
    const next = e.list()[0].nextFireAt;
    assert.ok(next > first, 're-armed for the following day');
    assert.equal(Math.round((next - first) / 3600000), 24);
});

test('a time trigger honours its weekdays and its unless', async () => {
    // 2026-10-04 is a Sunday (day 0); allow Monday only → the next fire is the next day.
    const { e, clock } = engine([{ id: 'wd', when: { time: '08:00', days: [1] }, say: 'x' }]);
    const at = e.list()[0].nextFireAt;
    assert.equal(new Date(at).getDay(), 1);
    assert.ok(at > clock.ms);

    const blocked = engine([{ id: 'b', when: { time: '23:00', unless: { state: 'away', value: true } }, say: 'x' }], {
        away: true,
    });
    blocked.clock.ms = blocked.e.list()[0].nextFireAt;
    await blocked.e.tick();
    assert.deepEqual(blocked.fired, [], 'blocked by unless');
    assert.ok(blocked.e.list()[0].nextFireAt > blocked.clock.ms, 'still scheduled for the next day');
});

// ── lifecycle ───────────────────────────────────────────────────────────────

test('stateIds reports what the host has to subscribe to', () => {
    const { e } = engine([
        { id: 'a', when: { state: 'x', value: true }, say: 'x' },
        { id: 'b', when: { time: '10:00', also: { state: 'y', value: 1 } }, say: 'y' },
    ]);
    assert.deepEqual(e.stateIds().sort(), ['x', 'y']);
});

test('disabled triggers neither fire nor stay scheduled', async () => {
    const { e, fired } = engine([
        { id: 't', when: { state: 'x', value: true }, say: 'x', cooldownSec: 0 },
        { id: 'timed', when: { time: '23:00' }, say: 'x' },
    ]);
    assert.equal(e.setEnabled('t', false), true);
    assert.equal(e.setEnabled('timed', false), true);
    assert.equal(e.setEnabled('nope', false), false);
    await e.onStateChange('x', true);
    assert.deepEqual(fired, []);
    assert.equal(e.list().find(s => s.id === 'timed').nextFireAt, 0);

    e.setEnabled('t', true);
    await e.onStateChange('x', false);
    await e.onStateChange('x', true);
    assert.deepEqual(fired, ['t']);
});

test('a trigger disabled by config is loaded but not armed, and enabled: false survives a reload', async () => {
    const { e, fired } = engine([{ id: 't', when: { state: 'x', value: true }, say: 'x', enabled: false }]);
    await e.onStateChange('x', true);
    assert.deepEqual(fired, []);
    assert.equal(e.list()[0].enabled, false);

    // A config reload keeps the live flag (and the cooldown) of a trigger that is still there.
    e.load([{ id: 't', when: { state: 'x', value: true }, say: 'x' }]);
    assert.equal(e.list()[0].enabled, false, 'the live flag wins over the config default');
});

test('a reload keeps the cooldown, so it cannot be used to fire again at once', async () => {
    const def = { id: 't', when: { state: 'x', value: true }, say: 'x', cooldownSec: 600 };
    const { e, fired } = engine([def]);
    await e.onStateChange('x', true);
    assert.deepEqual(fired, ['t']);
    e.load([def]);
    await e.onStateChange('x', false);
    await e.onStateChange('x', true);
    assert.deepEqual(fired, ['t'], 'still in cooldown after the reload');
});

test('restore brings back the persisted enabled flag and last-fired time', async () => {
    const { e, fired } = engine([{ id: 't', when: { state: 'x', value: true }, say: 'x', cooldownSec: 600 }]);
    e.restore([{ id: 't', enabled: false, lastFired: 0 }]);
    assert.equal(e.list()[0].enabled, false);
    await e.onStateChange('x', true);
    assert.deepEqual(fired, []);
});

test('fireNow ignores cooldown and delay', async () => {
    const { e, fired } = engine([
        { id: 't', when: { state: 'x', value: true }, delay: '5h', say: 'x', cooldownSec: 3600 },
    ]);
    assert.equal(await e.fireNow('t'), true);
    assert.deepEqual(fired, ['t'], 'ran straight away despite the delay');
    assert.equal(await e.fireNow('nope'), false);
});

test('a failing execute does not stop other triggers or the schedule', async () => {
    const calls = [];
    const e = new TriggerEngine({
        getState: async () => undefined,
        execute: def => {
            calls.push(def.id);
            throw new Error('boom');
        },
        log: silentLog,
        manualTick: true,
    });
    e.load([
        { id: 'a', when: { state: 'x', value: true }, say: 'x', cooldownSec: 0 },
        { id: 'b', when: { state: 'x', value: true }, say: 'x', cooldownSec: 0 },
    ]);
    await e.onStateChange('x', true);
    assert.deepEqual(calls, ['a', 'b'], 'the second trigger still ran');
});

test('dispose stops everything', async () => {
    const { e, fired } = engine([{ id: 't', when: { state: 'x', value: true }, say: 'x', cooldownSec: 0 }]);
    e.dispose();
    await e.onStateChange('x', true);
    assert.deepEqual(fired, []);
    assert.deepEqual(e.list(), []);
});

// ── validation ──────────────────────────────────────────────────────────────

test('validate rejects what cannot work and accepts what can', () => {
    assert.equal(validate({ id: 't', when: { state: 'x', value: true }, say: 'hi' }), '');
    assert.equal(validate({ id: 't', when: { time: '07:30' }, actions: [{ setState: { id: 'a', value: 1 } }] }), '');
    assert.equal(
        validate({ id: 't', when: { state: 'x' }, ask: 'Wirklich?', onResponse: [{ match: 'yes', say: 'ok' }] }),
        '',
    );
    assert.match(validate(undefined), /not an object/);
    assert.match(validate({ when: { state: 'x' }, say: 'hi' }), /missing id/);
    assert.match(validate({ id: 't', when: [], say: 'hi' }), /missing "when"/);
    assert.match(validate({ id: 't', when: { time: '7' }, say: 'hi' }), /invalid time/);
    assert.match(validate({ id: 't', when: { value: true }, say: 'hi' }), /needs either a state or a time/);
    assert.match(validate({ id: 't', when: { state: 'x' }, delay: 'bald', say: 'hi' }), /invalid delay/);
    assert.match(validate({ id: 't', when: { state: 'x' } }), /nothing to do/);
    assert.match(validate({ id: 't', when: { state: 'x' }, ask: 'Wirklich?' }), /needs onResponse/);
});

test('invalid and duplicate definitions are skipped, the rest still load', () => {
    const warnings = [];
    const e = new TriggerEngine({
        getState: async () => undefined,
        execute: () => {},
        log: { ...silentLog, warn: m => warnings.push(m) },
        manualTick: true,
    });
    e.load([
        { id: 'good', when: { state: 'x', value: true }, say: 'x' },
        { id: 'good', when: { state: 'y', value: true }, say: 'y' },
        { id: 'bad', when: { state: 'z' } },
    ]);
    assert.deepEqual(
        e.list().map(t => t.id),
        ['good'],
    );
    assert.equal(warnings.length, 2);
    assert.match(warnings.join(' '), /duplicate id/);
});

// ── settings-table rows ─────────────────────────────────────────────────────

test('parseTriggerRows parses the JSON columns and keeps empty cells at their defaults', () => {
    const warnings = [];
    const [t] = parseTriggerRows(
        [
            {
                id: ' fryer ',
                name: 'Friteuse',
                when: '{"state":"x.on","value":true}',
                ask: 'Ausschalten?',
                onResponse: '[{"match":"agreement","setState":{"id":"x.on","value":false}}]',
                actions: '',
                delay: '5h',
                cooldownSec: '',
            },
        ],
        { warn: m => warnings.push(m) },
    );
    assert.equal(t.id, 'fryer', 'the id is trimmed');
    assert.deepEqual(t.when, { state: 'x.on', value: true });
    assert.deepEqual(t.onResponse, [{ match: 'agreement', setState: { id: 'x.on', value: false } }]);
    assert.equal(t.actions, undefined);
    assert.equal(t.delay, '5h');
    assert.equal(t.cooldownSec, undefined, 'an empty cooldown cell means "use the default", not 0');
    assert.equal(t.rephrase, false);
    assert.deepEqual(warnings, []);
    assert.equal(validate(t), '');
});

test('parseTriggerRows reports invalid JSON once per field and drops just that field', () => {
    const warnings = [];
    const [t] = parseTriggerRows([{ id: 't', when: '{"state":', say: 'hi' }], { warn: m => warnings.push(m) });
    assert.equal(t.when, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /when is not valid JSON/);
    assert.match(validate(t), /missing "when"/, 'and the engine then refuses the trigger');
});

test('parseTriggerRows passes structured values through, skips empty rows and applies the rephrase default', () => {
    const rows = [
        { id: '' },
        { id: 'a', when: { state: 'x', value: true }, say: 'hi', cooldownSec: 0 },
        { id: 'b', when: { time: '07:00' }, say: 'hi', rephrase: false },
    ];
    const list = parseTriggerRows(rows, { rephraseDefault: true });
    assert.deepEqual(
        list.map(t => t.id),
        ['a', 'b'],
    );
    assert.deepEqual(list[0].when, { state: 'x', value: true });
    assert.equal(list[0].cooldownSec, 0, 'an explicit 0 really means no cooldown');
    assert.equal(list[0].rephrase, true, 'the global default applies');
    assert.equal(list[1].rephrase, false, 'a per-trigger value wins over the default');
});

test('prime remembers current values, so a repeated report after a restart is no transition', async () => {
    const states = { 'w.open': true };
    const { e, fired } = engine([{ id: 't', when: { state: 'w.open', value: true }, say: 'x', cooldownSec: 0 }], states);
    await e.prime();
    await e.onStateChange('w.open', true);
    assert.deepEqual(fired, [], 'the window was already open — nothing changed');
    await e.onStateChange('w.open', false);
    await e.onStateChange('w.open', true);
    assert.deepEqual(fired, ['t'], 'a real transition still fires');
});

test('prime leaves an unreadable state unknown, so its first value counts', async () => {
    const { e, fired } = engine([{ id: 't', when: { state: 'w.open', value: true }, say: 'x', cooldownSec: 0 }], {});
    await e.prime();
    await e.onStateChange('w.open', true);
    assert.deepEqual(fired, ['t']);
});
