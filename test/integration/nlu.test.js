'use strict';
// Integration test: rule-based NLU (device command parsing) — the offline fast-path.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Nlu, normalize, splitCommands } = require('../../build/lib/nlu.js');

const light = {
    name: 'Licht',
    room: 'Wohnzimmer',
    type: 'light',
    controls: { power: 'x.p' },
    writable: { power: true },
    types: { power: 'boolean' },
};
const blind = {
    name: 'Rollo',
    room: 'Schlafzimmer',
    type: 'blind',
    controls: { level: 'x.l' },
    writable: { level: true },
    types: { level: 'number' },
};
const temp = {
    name: 'Temperatur',
    room: 'Wohnzimmer',
    type: 'temperature',
    controls: { actual: 'x.t' },
    writable: { actual: false },
    types: { actual: 'number' },
};
const nlu = new Nlu(['Wohnzimmer', 'Schlafzimmer'], [light, blind, temp]);

test('turn on / off', () => {
    const on = nlu.parse('Licht im Wohnzimmer an');
    assert.equal(on.action, 'on');
    assert.equal(on.value, true);
    assert.equal(on.stateId, 'x.p');
    assert.equal(nlu.parse('Licht aus').action, 'off');
});

test('set level (%)', () => {
    const r = nlu.parse('Rollo auf 50 Prozent');
    assert.equal(r.action, 'level');
    assert.equal(r.value, 50);
    assert.equal(r.stateId, 'x.l');
});

test('status query (?)', () => {
    const r = nlu.parse('Temperatur im Wohnzimmer?');
    assert.equal(r.action, 'query');
    assert.equal(r.device.name, 'Temperatur');
});

test('no device → null (falls through to the LLM)', () => {
    assert.equal(nlu.parse('erzähl mir einen Witz'), null);
    assert.equal(nlu.parse('Kaffeemaschine anschalten'), null);
});

// ── Time / date queries (device-independent, answered from the host clock) ───
test('time query (de/en/ru)', () => {
    assert.equal(nlu.parse('wie spät ist es').action, 'timeQuery');
    assert.equal(nlu.parse('wie viel Uhr ist es?').action, 'timeQuery');
    assert.equal(nlu.parse('what time is it').action, 'timeQuery');
    assert.equal(nlu.parse("what's the time?").action, 'timeQuery');
    assert.equal(nlu.parse('который час').action, 'timeQuery');
    assert.equal(nlu.parse('сколько сейчас времени').action, 'timeQuery');
});

test('date query (de/en/ru)', () => {
    assert.equal(nlu.parse('welcher Tag ist heute?').action, 'dateQuery');
    assert.equal(nlu.parse('welches Datum haben wir').action, 'dateQuery');
    assert.equal(nlu.parse('what day is it').action, 'dateQuery');
    assert.equal(nlu.parse("what's the date today").action, 'dateQuery');
    assert.equal(nlu.parse('какое сегодня число').action, 'dateQuery');
    assert.equal(nlu.parse('какой сегодня день').action, 'dateQuery');
});

test('time/date query does not steal timer/alarm or device phrases', () => {
    // A clock phrase carrying a timer/alarm keyword stays a schedule intent.
    assert.equal(nlu.parse('weck mich um 7 Uhr').action, 'alarmSet');
    assert.equal(nlu.parse('Timer auf 5 Minuten').action, 'timerSet');
    // "сейчас"/"today"/"monday" must not false-match "час"/"day".
    assert.equal(nlu.parse('Licht im Wohnzimmer an').action, 'on');
    // A device status question is still a device query, not a time query.
    assert.equal(nlu.parse('Temperatur im Wohnzimmer?').action, 'query');
});

// ── Synonym dictionary (alias rewriting before matching) ─────────────────────
test('alias dictionary rewrites synonyms to canonical terms', () => {
    const withAlias = new Nlu(
        ['Wohnzimmer', 'Schlafzimmer'],
        [light, blind, temp],
        [
            { from: 'Beleuchtung', to: 'Licht' },
            { from: 'Jalousie', to: 'Rollo' },
        ],
    );
    // "Beleuchtung" → "Licht" → resolves to the light device
    const on = withAlias.parse('Beleuchtung im Wohnzimmer an');
    assert.equal(on.action, 'on');
    assert.equal(on.stateId, 'x.p');
    // multi-token command still works and a second alias maps the blind
    const lvl = withAlias.parse('Jalousie auf 40 Prozent');
    assert.equal(lvl.action, 'level');
    assert.equal(lvl.stateId, 'x.l');
    assert.equal(lvl.value, 40);
    // without the dictionary, the synonym does not resolve → falls through to the LLM
    assert.equal(nlu.parse('Beleuchtung im Wohnzimmer an'), null);
});

test('alias matches whole words only, not substrings', () => {
    // "auf" → "zu" must not corrupt words that merely contain the alias as a substring ("Aufnahme").
    const n = new Nlu(['Wohnzimmer'], [light], [{ from: 'xyz', to: 'licht' }]);
    // "xyz" as a standalone word is rewritten …
    assert.equal(n.parse('xyz im Wohnzimmer an').action, 'on');
    // … but embedded in another token it is left alone (no device match → null)
    assert.equal(n.parse('xyzabc im Wohnzimmer an'), null);
});

test('normalize lowercases, expands German umlauts and Russian ё', () => {
    assert.equal(normalize('Schöne Grüße'), 'schoene gruesse');
    assert.equal(normalize('WOHNZIMMER'), 'wohnzimmer');
    assert.equal(normalize('Ёлка'), 'елка');
});

// ── Russian (Cyrillic + inflection via stemming) ────────────────────────────
test('Russian: turn on/off with inflected device name', () => {
    const ru = new Nlu(
        ['Кухня', 'Кокпит'],
        [
            {
                name: 'Подсветка кокпита',
                room: 'Кокпит',
                type: 'light',
                controls: { power: 'a.set' },
                writable: { power: true },
                types: { power: 'boolean' },
            },
            {
                name: 'Холодильник',
                room: 'Кухня',
                type: 'temperature',
                controls: { actual: 'k.act' },
                writable: { actual: false },
                types: { actual: 'number' },
            },
        ],
    );
    // "подсветку кокпита" (accusative) must match "Подсветка кокпита" (nominative)
    const off = ru.parse('выключи подсветку кокпита');
    assert.equal(off.action, 'off');
    assert.equal(off.stateId, 'a.set');
    // "в холодильнике" (prepositional) must match "Холодильник"
    const q = ru.parse('какая температура в холодильнике');
    assert.equal(q.action, 'query');
    assert.equal(q.device.name, 'Холодильник');
});

// ── Regression: never control a metering state for on/off ────────────────────
test('on/off prefers the boolean switch, never a CONSUMPTION/metering state', () => {
    const metered = new Nlu(
        ['Kueche'],
        [
            {
                name: 'Licht',
                room: 'Kueche',
                type: 'dimmer',
                controls: { power: 'k.Licht.SET', level: 'k.Licht.ON_SET', consumption: 'k.Licht.CONSUMPTION' },
                writable: { power: true, level: true, consumption: true },
                types: { power: 'boolean', level: 'number', consumption: 'number' },
            },
        ],
    );
    const on = metered.parse('licht in kueche an');
    assert.equal(on.action, 'on');
    assert.equal(on.stateId, 'k.Licht.SET'); // the boolean switch, not CONSUMPTION
    const lvl = metered.parse('licht in kueche auf 30 prozent');
    assert.equal(lvl.stateId, 'k.Licht.ON_SET'); // numeric control for level
});

test('metering-only device: fallback still skips CONSUMPTION', () => {
    const trap = new Nlu(
        ['Kueche'],
        [
            {
                name: 'Lampe',
                room: 'Kueche',
                type: 'socket',
                controls: { consumption: 'z.CONSUMPTION', main: 'z.SET' },
                writable: { consumption: true, main: true },
                types: { consumption: 'number', main: 'boolean' },
            },
        ],
    );
    assert.equal(trap.parse('lampe in kueche an').stateId, 'z.SET');
});

// ── Dimmer with a separate on/off switch (role-based) ───────────────────────
test('on/off picks the boolean switch even under a non-standard control key (ON_SET)', () => {
    // SET is the level (0–100), ON_SET is the boolean switch — the reported real-world case.
    const dimmer = {
        name: 'Küchenlicht',
        room: 'Küche',
        type: 'dimmer',
        controls: { level: 'k.SET', on: 'k.ON_SET' },
        writable: { level: true, on: true },
        types: { level: 'number', on: 'boolean' },
        roles: { level: 'level.dimmer', on: 'switch.light' },
    };
    const nlu = new Nlu(['Küche'], [dimmer]);
    const on = nlu.parse('Küchenlicht anschalten');
    assert.equal(on.action, 'on');
    assert.equal(on.stateId, 'k.ON_SET'); // the boolean, NOT the 0–100 level
    assert.equal(on.value, true);
    assert.equal(nlu.parse('Küchenlicht ausschalten').stateId, 'k.ON_SET');
    assert.equal(nlu.parse('Küchenlicht ausschalten').value, false);
});

test('level command also flips the on/off switch (30% → level 30 + switch on)', () => {
    const dimmer = {
        name: 'Küchenlicht',
        room: 'Küche',
        type: 'dimmer',
        controls: { level: 'k.SET', on: 'k.ON_SET' },
        writable: { level: true, on: true },
        types: { level: 'number', on: 'boolean' },
        roles: { level: 'level.dimmer', on: 'switch.light' },
    };
    const nlu = new Nlu(['Küche'], [dimmer]);
    const r = nlu.parse('Küchenlicht auf 30 Prozent');
    assert.equal(r.action, 'level');
    assert.equal(r.stateId, 'k.SET');
    assert.equal(r.value, 30);
    assert.deepEqual(r.also, { stateId: 'k.ON_SET', value: true }); // switch on
    const zero = nlu.parse('Küchenlicht auf 0 Prozent');
    assert.deepEqual(zero.also, { stateId: 'k.ON_SET', value: false }); // 0% → switch off
});

test('level on a dimmer WITHOUT a switch → no secondary write', () => {
    const dimmer = {
        name: 'Lager Licht',
        room: 'Lager',
        type: 'dimmer',
        controls: { level: 'l.SET' },
        writable: { level: true },
        types: { level: 'number' },
        roles: { level: 'level.dimmer' },
    };
    const r = new Nlu(['Lager'], [dimmer]).parse('Lager Licht auf 40 Prozent');
    assert.equal(r.value, 40);
    assert.equal(r.also, undefined);
});

test('on/off on a dimmer without a boolean switch → full/zero level, not true/false', () => {
    const dimmer = {
        name: 'Lampe',
        room: 'Salon',
        type: 'dimmer',
        controls: { level: 's.SET' },
        writable: { level: true },
        types: { level: 'number' },
        roles: { level: 'level.dimmer' },
    };
    const nlu = new Nlu(['Salon'], [dimmer]);
    const on = nlu.parse('Lampe in Salon an');
    assert.equal(on.stateId, 's.SET');
    assert.equal(on.value, 100); // NOT boolean true (→ would be ~1% on a 0–100 state)
    assert.equal(nlu.parse('Lampe in Salon aus').value, 0);
});

// ── Color ───────────────────────────────────────────────────────────────────
test('set color on a color-capable device', () => {
    const rgb = new Nlu(
        ['Salon'],
        [
            {
                name: 'Lampe',
                room: 'Salon',
                type: 'rgb',
                controls: { rgb: 'r.RGB', power: 'r.ON' },
                writable: { rgb: true, power: true },
                types: { rgb: 'string', power: 'boolean' },
            },
        ],
    );
    const r = rgb.parse('lampe in salon blau');
    assert.equal(r.action, 'color');
    assert.equal(r.value, '#0000FF');
    assert.equal(r.stateId, 'r.RGB');
});

// ── Aggregate query: "which windows are open?" (de/en/ru) ───────────────────
test('aggregate: which windows are open (de/en/ru)', () => {
    const win = (name, room) => ({
        name,
        room,
        type: 'window',
        controls: { actual: `w.${name}` },
        writable: { actual: false },
        types: { actual: 'boolean' },
    });
    const nluW = new Nlu(
        ['Küche', 'Bad'],
        [
            win('Fenster', 'Küche'),
            win('Fenster', 'Bad'),
            {
                name: 'Licht',
                room: 'Küche',
                type: 'light',
                controls: { power: 'p' },
                writable: { power: true },
                types: { power: 'boolean' },
            },
        ],
    );
    for (const q of ['welche Fenster sind offen', 'which windows are open?', 'какие окна открыты']) {
        const r = nluW.parse(q);
        assert.equal(r && r.action, 'listByState', q);
        assert.equal(r.category, 'window');
        assert.equal(r.devices.length, 2); // both windows, not the light
    }
});

test('aggregate: windows restricted to a room', () => {
    const win = (name, room) => ({
        name,
        room,
        type: 'window',
        controls: { actual: `w.${name}.${room}` },
        writable: { actual: false },
        types: { actual: 'boolean' },
    });
    const nluW = new Nlu(['Küche', 'Bad'], [win('Fenster', 'Küche'), win('Fenster', 'Bad')]);
    const r = nluW.parse('ist ein Fenster im Bad offen');
    assert.equal(r.action, 'listByState');
    assert.equal(r.devices.length, 1);
    assert.equal(r.devices[0].room, 'Bad');
});

test('no window devices → aggregate falls through to LLM', () => {
    const nluNo = new Nlu(
        ['Küche'],
        [
            {
                name: 'Licht',
                room: 'Küche',
                type: 'light',
                controls: { power: 'p' },
                writable: { power: true },
                types: { power: 'boolean' },
            },
        ],
    );
    assert.equal(nluNo.parse('welche Fenster sind offen'), null);
});

// ── Status query control selection (on/off vs value; never a metering state) ─
test('on/off query reads the switch, not a CONSUMPTION metering state', () => {
    const light = {
        name: 'Licht',
        room: 'Kueche',
        type: 'dimmer',
        controls: { power: 'k.SET', level: 'k.ON_SET', actual: 'k.ACTUAL', consumption: 'k.CONSUMPTION' },
        writable: { power: true, level: true, actual: false, consumption: true },
        types: { power: 'boolean', level: 'number', actual: 'boolean', consumption: 'number' },
    };
    const nlu = new Nlu(['Kueche'], [light]);
    const de = nlu.parse('ist das Licht in Kueche an?');
    assert.equal(de.action, 'query');
    assert.equal(de.stateId, 'k.SET'); // boolean switch, not k.CONSUMPTION
    const ru = new Nlu(['Kueche'], [{ ...light, name: 'Свет' }]).parse('включен ли свет в kueche?');
    assert.equal(ru.action, 'query');
    assert.equal(ru.stateId, 'k.SET');
});

test('value query reads the actual value, not a metering state', () => {
    const fridge = {
        name: 'Kuehlschrank',
        room: 'Kueche',
        type: 'temperature',
        controls: { actual: 't.ACTUAL', consumption: 't.CONSUMPTION' },
        writable: { actual: false, consumption: true },
        types: { actual: 'number', consumption: 'number' },
    };
    const r = new Nlu(['Kueche'], [fridge]).parse('welche Temperatur hat der Kuehlschrank?');
    assert.equal(r.stateId, 't.ACTUAL');
});

test('a question containing "an" queries, never turns on', () => {
    const light = {
        name: 'Licht',
        room: 'Kueche',
        type: 'light',
        controls: { power: 'p' },
        writable: { power: true },
        types: { power: 'boolean' },
    };
    const nlu = new Nlu(['Kueche'], [light]);
    assert.equal(nlu.parse('ist das Licht in Kueche an?').action, 'query');
    assert.equal(nlu.parse('Licht in Kueche an').action, 'on'); // command still works
});

// ── Combined commands: several commands in one utterance, or one verb for several devices ───

const lamp = {
    name: 'Lampe',
    room: 'Wohnzimmer',
    type: 'light',
    controls: { power: 'x.l2' },
    writable: { power: true },
    types: { power: 'boolean' },
};
const music = {
    name: 'Musik',
    room: 'Wohnzimmer',
    type: 'media',
    controls: { power: 'x.m' },
    writable: { power: true },
    types: { power: 'boolean' },
};
const combo = new Nlu(['Wohnzimmer', 'Schlafzimmer'], [light, lamp, blind, temp, music]);
/** Compact view of a parse result: "action stateId[=value]" per intent. */
const shape = list => list.map(i => `${i.action} ${i.stateId}${i.value === undefined ? '' : '=' + i.value}`);

test('combined: two different commands joined by "und"', () => {
    assert.deepEqual(shape(combo.parseAll('Schalte das Licht an und setze das Rollo auf 50 Prozent')), [
        'on x.p=true',
        'level x.l=50',
    ]);
});

test('combined: one verb, several devices ("Schalte A und B an")', () => {
    assert.deepEqual(shape(combo.parseAll('Schalte das Licht und die Lampe an')), ['on x.p=true', 'on x.l2=true']);
    // …and with the verb up front, the trailing segment naming only a device inherits it.
    assert.deepEqual(shape(combo.parseAll('Schalte Licht an und Lampe')), ['on x.p=true', 'on x.l2=true']);
});

test('combined: opposite actions stay independent', () => {
    assert.deepEqual(shape(combo.parseAll('Schalte das Licht aus und die Lampe an')), [
        'off x.p=false',
        'on x.l2=true',
    ]);
});

test('combined: comma-separated list of three commands', () => {
    assert.deepEqual(shape(combo.parseAll('Licht an, Lampe an und Rollo auf 50 Prozent')), [
        'on x.p=true',
        'on x.l2=true',
        'level x.l=50',
    ]);
});

test('combined: a segment with its own unknown verb never inherits the action', () => {
    // "die Musik lauter" is not a rule the NLU knows — it must not become "turn the music on".
    const r = combo.parseAll('Mach das Licht an und die Musik lauter');
    assert.deepEqual(shape(r), ['on x.p=true']);
    assert.ok(!r.some(i => i.stateId === 'x.m'));
});

test('combined: query distributes over both devices', () => {
    const r = combo.parseAll('Ist das Licht an und die Lampe?');
    assert.deepEqual(
        r.map(i => i.action),
        ['query', 'query'],
    );
    assert.deepEqual(
        r.map(i => i.stateId),
        ['x.p', 'x.l2'],
    );
});

test('combined: timer plus a device command', () => {
    const r = combo.parseAll('Stelle einen Timer auf 5 Minuten und schalte das Licht aus');
    assert.equal(r.length, 2);
    assert.equal(r[0].action, 'timerSet');
    assert.equal(r[0].durationSec, 300);
    assert.equal(r[1].action, 'off');
    assert.equal(r[1].stateId, 'x.p');
});

test('combined: "und" inside one command is not a separator', () => {
    // A duration ("1 Stunde und 30 Minuten") and a decimal comma must survive the split unharmed.
    const timer = combo.parseAll('Timer auf 1 Stunde und 30 Minuten');
    assert.equal(timer.length, 1);
    assert.equal(timer[0].durationSec, 5400);
    assert.equal(combo.parseAll('Rollo auf 50,5 Prozent').length, 1);
    // A single command still parses exactly as before.
    assert.deepEqual(shape(combo.parseAll('Licht an')), ['on x.p=true']);
    assert.deepEqual(combo.parseAll('erzähl mir einen Witz'), []);
});

test('combined: English and Russian', () => {
    const en = new Nlu(
        ['Living room'],
        [
            {
                name: 'Light',
                room: 'Living room',
                type: 'light',
                controls: { power: 'e.p' },
                writable: { power: true },
                types: { power: 'boolean' },
            },
            {
                name: 'Blind',
                room: 'Living room',
                type: 'blind',
                controls: { level: 'e.l' },
                writable: { level: true },
                types: { level: 'number' },
            },
        ],
    );
    assert.deepEqual(shape(en.parseAll('Turn on the light and set the blind to 30 percent')), [
        'on e.p=true',
        'level e.l=30',
    ]);

    const ru = new Nlu(
        ['Гостиная'],
        [
            {
                name: 'Свет',
                room: 'Гостиная',
                type: 'light',
                controls: { power: 'r.p' },
                writable: { power: true },
                types: { power: 'boolean' },
            },
            {
                name: 'Лампа',
                room: 'Гостиная',
                type: 'light',
                controls: { power: 'r.l' },
                writable: { power: true },
                types: { power: 'boolean' },
            },
        ],
    );
    assert.deepEqual(shape(ru.parseAll('Включи свет и лампу')), ['on r.p=true', 'on r.l=true']);
    assert.deepEqual(shape(ru.parseAll('Включи свет и выключи лампу')), ['on r.p=true', 'off r.l=false']);
});

test('splitCommands: conjunctions and punctuation, but not decimals', () => {
    assert.deepEqual(splitCommands('Licht an und Rollo zu'), ['Licht an', 'Rollo zu']);
    assert.deepEqual(splitCommands('A an, B aus; C an'), ['A an', 'B aus', 'C an']);
    assert.deepEqual(splitCommands('turn A on and then B off'), ['turn A on', 'B off']);
    assert.deepEqual(splitCommands('Licht an und dann Rollo zu'), ['Licht an', 'Rollo zu']);
    assert.deepEqual(splitCommands('включи A и B'), ['включи A', 'B']);
    assert.deepEqual(splitCommands('Rollo auf 50,5 Prozent'), ['Rollo auf 50,5 Prozent']);
    assert.deepEqual(splitCommands('Licht an'), ['Licht an']);
});
