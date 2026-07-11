'use strict';
// Integration test: alarm engine (fixed clock time) + NLU clock/weekday parsing (roadmap #2).
const test = require('node:test');
const assert = require('node:assert/strict');
const { AlarmManager, computeNextFire, formatClock, formatWeekdays } = require('../../build/lib/alarms.js');
const { Nlu, parseClockTime, parseWeekdays } = require('../../build/lib/nlu.js');

// ── Clock-time parsing (de/en/ru) ───────────────────────────────────────────
test('parseClockTime: numeric and "Uhr"', () => {
    assert.deepEqual(parseClockTime('7:30'), { hour: 7, minute: 30 });
    assert.deepEqual(parseClockTime('7 Uhr'), { hour: 7, minute: 0 });
    assert.deepEqual(parseClockTime('7 Uhr 45'), { hour: 7, minute: 45 });
    assert.deepEqual(parseClockTime('at 6'), { hour: 6, minute: 0 });
    assert.deepEqual(parseClockTime('в 8 часов'), { hour: 8, minute: 0 });
});

test('parseClockTime: German spoken forms', () => {
    assert.deepEqual(parseClockTime('halb acht'), { hour: 7, minute: 30 });
    assert.deepEqual(parseClockTime('viertel nach sieben'), { hour: 7, minute: 15 });
    assert.deepEqual(parseClockTime('viertel vor acht'), { hour: 7, minute: 45 });
    assert.deepEqual(parseClockTime('dreiviertel acht'), { hour: 7, minute: 45 });
});

test('parseClockTime: English spoken forms + am/pm', () => {
    assert.deepEqual(parseClockTime('half past seven'), { hour: 7, minute: 30 });
    assert.deepEqual(parseClockTime('quarter past six'), { hour: 6, minute: 15 });
    assert.deepEqual(parseClockTime('quarter to eight'), { hour: 7, minute: 45 });
    assert.deepEqual(parseClockTime('7 pm'), { hour: 19, minute: 0 });
});

test('parseClockTime: no time → null', () => {
    assert.equal(parseClockTime('mach das Licht an'), null);
});

test('parseWeekdays: named, ranges, single', () => {
    assert.deepEqual(parseWeekdays('jeden Tag'), [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(parseWeekdays('wochentags'), [1, 2, 3, 4, 5]);
    assert.deepEqual(parseWeekdays('am Wochenende'), [0, 6]);
    assert.deepEqual(parseWeekdays('jeden Montag'), [1]);
    assert.deepEqual(parseWeekdays('every Monday and Friday'), [1, 5]);
    assert.deepEqual(parseWeekdays('keine Angabe'), []);
});

// ── NLU alarm intents ───────────────────────────────────────────────────────
const nlu = new Nlu(['Schlafzimmer'], []);

test('NLU: set alarm at a clock time', () => {
    const r = nlu.parse('weck mich um 7 Uhr');
    assert.equal(r.action, 'alarmSet');
    assert.equal(r.hour, 7);
    assert.equal(r.minute, 0);

    const r2 = nlu.parse('stelle einen Wecker auf halb acht');
    assert.equal(r2.action, 'alarmSet');
    assert.equal(r2.hour, 7);
    assert.equal(r2.minute, 30);
});

test('NLU: recurring alarm with weekdays', () => {
    const r = nlu.parse('Wecker jeden Montag um 6:30');
    assert.equal(r.action, 'alarmSet');
    assert.equal(r.hour, 6);
    assert.equal(r.minute, 30);
    assert.deepEqual(r.weekdays, [1]);
});

test('NLU: alarm query and cancel', () => {
    assert.equal(nlu.parse('welche Wecker sind gestellt').action, 'alarmQuery');
    assert.equal(nlu.parse('Wecker löschen').action, 'alarmCancel');
    assert.equal(nlu.parse('delete the alarm').action, 'alarmCancel');
});

test('NLU: alarm plurals and German compounds still match', () => {
    assert.equal(nlu.parse('list my alarms').action, 'alarmQuery');
    assert.equal(nlu.parse('Eierwecker').action, 'alarmQuery');
});

test('NLU: "weck mich in 5 Minuten" is a timer, not an alarm', () => {
    const r = nlu.parse('weck mich in 5 Minuten');
    assert.equal(r.action, 'timerSet');
    assert.equal(r.durationSec, 300);
});

test('NLU: ambiguous clock-vs-duration cases', () => {
    // Russian "7 часов" = 7 o'clock (alarm), not 7 hours (timer).
    assert.equal(nlu.parse('разбуди меня в 7 часов').action, 'alarmSet');
    // German "Timer um 5 Minuten" must stay a countdown, not become 5 o'clock.
    const t = nlu.parse('Timer um 5 Minuten');
    assert.equal(t.action, 'timerSet');
    assert.equal(t.durationSec, 300);
    // "Wecker auf 8" (bare hour in the alarm domain) → 08:00.
    const a = nlu.parse('Wecker auf 8');
    assert.equal(a.action, 'alarmSet');
    assert.equal(a.hour, 8);
});

test('NLU: english + russian alarm set', () => {
    const en = nlu.parse('set an alarm for 6:15');
    assert.equal(en.action, 'alarmSet');
    assert.equal(en.hour, 6);
    assert.equal(en.minute, 15);
    const ru = nlu.parse('разбуди меня в 7 часов');
    assert.equal(ru.action, 'alarmSet');
    assert.equal(ru.hour, 7);
});

// ── computeNextFire ─────────────────────────────────────────────────────────
test('computeNextFire: one-shot today vs tomorrow', () => {
    // Monday 2024-01-01 10:00 local.
    const base = new Date(2024, 0, 1, 10, 0, 0, 0).getTime();
    const later = computeNextFire(11, 0, [], base); // 11:00 same day
    assert.equal(new Date(later).getHours(), 11);
    assert.equal(new Date(later).getDate(), 1);
    const nextDay = computeNextFire(9, 0, [], base); // 09:00 already passed → tomorrow
    assert.equal(new Date(nextDay).getDate(), 2);
});

test('computeNextFire: recurring picks the right weekday', () => {
    const base = new Date(2024, 0, 1, 10, 0, 0, 0).getTime(); // Monday
    const wed = computeNextFire(8, 0, [3], base); // next Wednesday 08:00
    assert.equal(new Date(wed).getDay(), 3);
    assert.equal(new Date(wed).getDate(), 3);
});

// ── AlarmManager ────────────────────────────────────────────────────────────
function makeManager(nowRef) {
    const fired = [];
    const changes = [];
    const mgr = new AlarmManager({
        now: () => nowRef.t,
        manualTick: true,
        onFire: a => fired.push(a),
        onChange: list => changes.push(list),
    });
    return { mgr, fired };
}

test('AlarmManager: one-shot fires once and is removed', () => {
    const nowRef = { t: new Date(2024, 0, 1, 10, 0, 0, 0).getTime() };
    const { mgr, fired } = makeManager(nowRef);
    const a = mgr.add({ hour: 10, minute: 30, label: 'wake' });
    assert.equal(mgr.list().length, 1);
    nowRef.t = a.nextFireAt;
    mgr.tick();
    assert.equal(fired.length, 1);
    assert.equal(mgr.list().length, 0); // one-shot removed
});

test('AlarmManager: recurring stays and reschedules', () => {
    const nowRef = { t: new Date(2024, 0, 1, 10, 0, 0, 0).getTime() }; // Monday
    const { mgr, fired } = makeManager(nowRef);
    const a = mgr.add({ hour: 10, minute: 30, weekdays: [1] }); // every Monday
    const firstFire = a.nextFireAt;
    nowRef.t = firstFire;
    mgr.tick();
    assert.equal(fired.length, 1);
    assert.equal(mgr.list().length, 1); // still there
    assert.ok(mgr.list()[0].nextFireAt > firstFire); // rescheduled to next week
});

test('AlarmManager: enable/disable and cancel', () => {
    const nowRef = { t: new Date(2024, 0, 1, 10, 0, 0, 0).getTime() };
    const { mgr } = makeManager(nowRef);
    const a = mgr.add({ hour: 11, minute: 0 });
    assert.ok(a.nextFireAt > 0);
    mgr.setEnabled(a.id, false);
    assert.equal(mgr.get(a.id).enabled, false);
    assert.equal(mgr.get(a.id).nextFireAt, 0);
    mgr.setEnabled(a.id, true);
    assert.ok(mgr.get(a.id).nextFireAt > 0);
    assert.equal(mgr.cancel(a.id), true);
    assert.equal(mgr.list().length, 0);
});

test('AlarmManager: restore keeps disabled, drops missed one-shot', () => {
    const nowRef = { t: 100_000 };
    const { mgr } = makeManager(nowRef);
    const res = mgr.restore([
        { id: 'x', label: 'off', room: '', source: '', hour: 7, minute: 0, weekdays: [], enabled: false, createdAt: 0, nextFireAt: 0 },
        { id: 'y', label: 'missed', room: '', source: '', hour: 7, minute: 0, weekdays: [], enabled: true, createdAt: 0, nextFireAt: 50_000 },
        { id: 'z', label: 'weekly', room: '', source: '', hour: 7, minute: 0, weekdays: [1], enabled: true, createdAt: 0, nextFireAt: 0 },
    ]);
    assert.equal(res.restored, 2); // disabled kept + recurring rescheduled
    assert.equal(res.dropped, 1); // missed one-shot
    assert.ok(mgr.get('z').nextFireAt > nowRef.t);
});

// ── formatters ──────────────────────────────────────────────────────────────
test('formatClock / formatWeekdays', () => {
    assert.equal(formatClock(7, 5), '07:05');
    assert.equal(formatWeekdays([], 'de'), '');
    assert.equal(formatWeekdays([0, 1, 2, 3, 4, 5, 6], 'de'), 'täglich');
    assert.equal(formatWeekdays([1, 2, 3, 4, 5], 'en'), 'on weekdays');
    assert.equal(formatWeekdays([0, 6], 'de'), 'am Wochenende');
    assert.equal(formatWeekdays([1], 'de'), 'Montag');
});
