'use strict';
// Integration test: countdown timer engine + NLU timer parsing (roadmap #2).
const test = require('node:test');
const assert = require('node:assert/strict');
const { TimerManager, formatDuration } = require('../../build/lib/timers.js');
const { Nlu, parseDurationSeconds, isStopCommand } = require('../../build/lib/nlu.js');

// ── Duration parsing (de/en/ru) ─────────────────────────────────────────────
test('parseDurationSeconds: units and combos', () => {
    assert.equal(parseDurationSeconds('5 Minuten'), 300);
    assert.equal(parseDurationSeconds('in 10 minutes'), 600);
    assert.equal(parseDurationSeconds('1 Stunde 30 Minuten'), 5400);
    assert.equal(parseDurationSeconds('90 Sekunden'), 90);
    assert.equal(parseDurationSeconds('2 часа'), 7200);
    assert.equal(parseDurationSeconds('5 минут'), 300);
});

test('parseDurationSeconds: number words and fractions', () => {
    assert.equal(parseDurationSeconds('fünf Minuten'), 300);
    assert.equal(parseDurationSeconds('eine halbe Stunde'), 1800);
    assert.equal(parseDurationSeconds('viertelstunde'), 900);
    assert.equal(parseDurationSeconds('anderthalb Stunden'), 5400);
    assert.equal(parseDurationSeconds('half an hour'), 1800);
    assert.equal(parseDurationSeconds('полчаса'), 1800);
});

test('parseDurationSeconds: bare number → minutes only with assumeMinutes', () => {
    assert.equal(parseDurationSeconds('timer 5'), null);
    assert.equal(parseDurationSeconds('timer 5', true), 300);
    assert.equal(parseDurationSeconds('kein zeitwert hier', true), null);
});

// ── NLU timer intents ───────────────────────────────────────────────────────
const nlu = new Nlu(['Küche', 'Wohnzimmer'], []);

test('NLU: set timer with duration + label', () => {
    const r = nlu.parse('stelle einen Timer auf 5 Minuten');
    assert.equal(r.action, 'timerSet');
    assert.equal(r.durationSec, 300);

    const r2 = nlu.parse('erinnere mich in 10 Minuten an die Nudeln');
    assert.equal(r2.action, 'timerSet');
    assert.equal(r2.durationSec, 600);
    assert.equal(r2.label, 'nudeln');
});

test('NLU: set timer picks up the room', () => {
    const r = nlu.parse('Timer 3 Minuten in der Küche');
    assert.equal(r.action, 'timerSet');
    assert.equal(r.durationSec, 180);
    assert.equal(r.room, 'Küche');
});

test('NLU: timer query and cancel', () => {
    assert.equal(nlu.parse('welche Timer laufen noch').action, 'timerQuery');
    assert.equal(nlu.parse('wie lange läuft der Timer noch').action, 'timerQuery');
    assert.equal(nlu.parse('Timer abbrechen').action, 'timerCancel');
    assert.equal(nlu.parse('cancel the timer').action, 'timerCancel');
    assert.equal(nlu.parse('отмени таймер').action, 'timerCancel');
});

test('NLU: english + russian set', () => {
    const en = nlu.parse('set a timer for 2 minutes');
    assert.equal(en.action, 'timerSet');
    assert.equal(en.durationSec, 120);
    const ru = nlu.parse('поставь таймер на 5 минут');
    assert.equal(ru.action, 'timerSet');
    assert.equal(ru.durationSec, 300);
});

test('NLU: "time" alone is not a timer command', () => {
    assert.equal(nlu.parse('what time is it'), null);
});

test('isStopCommand: recognizes stop/quiet words (de/en/ru), not device-off', () => {
    for (const s of ['Stop', 'Halt', 'Aufhören', 'aufhoeren', 'Ruhe', 'genug', 'Schluss', 'abbrechen',
        'stop it', 'cancel', 'enough', 'quiet', 'стоп', 'хватит', 'тихо', 'прекрати']) {
        assert.equal(isStopCommand(s), true, s);
    }
    // "aus" (turn-off) and unrelated text must NOT count as a stop-ring command.
    assert.equal(isStopCommand('mach das Licht aus'), false);
    assert.equal(isStopCommand('wie spät ist es'), false);
});

test('NLU: plurals and German compounds still match', () => {
    assert.equal(nlu.parse('Küchentimer 2 Minuten').action, 'timerSet');
    assert.equal(nlu.parse('list my timers').action, 'timerQuery');
    assert.equal(nlu.parse('cancel all timers').action, 'timerCancel');
});

// ── TimerManager ────────────────────────────────────────────────────────────
function makeManager(nowRef) {
    const fired = [];
    const changes = [];
    const mgr = new TimerManager({
        now: () => nowRef.t,
        manualTick: true,
        onFire: t => fired.push(t),
        onChange: list => changes.push(list),
    });
    return { mgr, fired, changes };
}

test('TimerManager: add, list, fire on tick', () => {
    const nowRef = { t: 1000 };
    const { mgr, fired } = makeManager(nowRef);
    const info = mgr.add({ label: 'pasta', duration: 60 });
    assert.equal(info.fireAt, 1000 + 60000);
    assert.equal(mgr.list().length, 1);

    nowRef.t = 1000 + 59000;
    mgr.tick();
    assert.equal(fired.length, 0); // not yet

    nowRef.t = 1000 + 60000;
    mgr.tick();
    assert.equal(fired.length, 1);
    assert.equal(fired[0].label, 'pasta');
    assert.equal(mgr.list().length, 0); // removed after firing
});

test('TimerManager: cancel and cancelAll', () => {
    const nowRef = { t: 0 };
    const { mgr } = makeManager(nowRef);
    const a = mgr.add({ duration: 60 });
    mgr.add({ duration: 120, room: 'Küche' });
    assert.equal(mgr.cancel(a.id), true);
    assert.equal(mgr.cancel('nope'), false);
    assert.equal(mgr.list().length, 1);
    assert.equal(mgr.cancelAll(), 1);
    assert.equal(mgr.list().length, 0);
});

test('TimerManager: list is sorted soonest-first', () => {
    const nowRef = { t: 0 };
    const { mgr } = makeManager(nowRef);
    mgr.add({ label: 'late', duration: 300 });
    mgr.add({ label: 'soon', duration: 60 });
    assert.equal(mgr.list()[0].label, 'soon');
});

test('TimerManager: restore reschedules future, drops expired', () => {
    const nowRef = { t: 10_000 };
    const { mgr } = makeManager(nowRef);
    const res = mgr.restore([
        { id: 'a', label: 'future', room: '', source: '', createdAt: 0, duration: 60, fireAt: 70_000 },
        { id: 'b', label: 'past', room: '', source: '', createdAt: 0, duration: 60, fireAt: 5_000 },
    ]);
    assert.equal(res.restored, 1);
    assert.equal(res.dropped, 1);
    assert.equal(mgr.list().length, 1);
    assert.equal(mgr.list()[0].id, 'a');
});

// ── formatDuration ──────────────────────────────────────────────────────────
test('formatDuration de/en/ru', () => {
    assert.equal(formatDuration(300, 'de'), '5 Minuten');
    assert.equal(formatDuration(60, 'de'), '1 Minute');
    assert.equal(formatDuration(5400, 'de'), '1 Stunde 30 Minuten');
    assert.equal(formatDuration(90, 'en'), '1 minute 30 seconds');
    assert.equal(formatDuration(3600, 'en'), '1 hour');
    assert.equal(formatDuration(120, 'ru'), '2 минуты');
    assert.equal(formatDuration(300, 'ru'), '5 минут');
    assert.equal(formatDuration(10, 'en'), '10 seconds');
});
