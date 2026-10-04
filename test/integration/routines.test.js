'use strict';
// Integration test: routines — a phrase that runs a list of actions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhrase, splitPhrases, parseRoutineRows, matchRoutine } = require('../../build/lib/routines.js');

test('normalizePhrase folds case, umlauts and punctuation', () => {
    assert.equal(normalizePhrase('Gute Nacht!'), 'gute nacht');
    assert.equal(normalizePhrase('  Büro   ABschalten . '), 'buero abschalten');
    assert.equal(normalizePhrase('Straße'), 'strasse');
    assert.equal(normalizePhrase('Фильм-вечер'), 'фильм вечер');
    assert.equal(normalizePhrase(undefined), '');
    assert.equal(normalizePhrase(42), '');
});

test('splitPhrases takes lines, commas or an array', () => {
    assert.deepEqual(splitPhrases('Gute Nacht\nSchlafen gehen'), ['gute nacht', 'schlafen gehen']);
    assert.deepEqual(splitPhrases('a, b; c'), ['a', 'b', 'c']);
    assert.deepEqual(splitPhrases(['Gute Nacht']), ['gute nacht']);
    assert.deepEqual(splitPhrases(''), []);
});

test('parseRoutineRows parses the action JSON and skips what cannot work', () => {
    const warnings = [];
    const list = parseRoutineRows(
        [
            { name: 'Night', phrases: 'Gute Nacht', actions: '[{"setState":{"id":"x.light","value":false}}]', reply: 'Gute Nacht!' },
            { name: 'Broken', phrases: 'kaputt', actions: '[{' },
            { name: 'Empty', phrases: 'leer' },
            { name: 'NoPhrase', actions: '[{"say":"hi"}]' },
            { name: 'ReplyOnly', phrases: 'danke', reply: 'Gern!' },
            { name: 'Structured', phrases: 'kino', actions: [{ setState: { id: 'x.blind', value: 0 } }] },
        ],
        { warn: m => warnings.push(m) },
    );
    assert.deepEqual(
        list.map(r => r.name),
        ['Night', 'ReplyOnly', 'Structured'],
    );
    assert.deepEqual(list[0].actions, [{ setState: { id: 'x.light', value: false } }]);
    assert.deepEqual(list[0].phrases, ['gute nacht']);
    assert.equal(warnings.length, 2);
    assert.match(warnings.join(' '), /not valid JSON/);
    assert.match(warnings.join(' '), /nothing to do/);
});

test('a phrase anywhere in the utterance triggers the routine', () => {
    const routines = parseRoutineRows([{ name: 'Night', phrases: 'Gute Nacht', actions: '[{"say":"x"}]' }]);
    assert.equal(matchRoutine('Gute Nacht', routines)?.name, 'Night');
    assert.equal(matchRoutine('mach mal gute nacht bitte', routines)?.name, 'Night');
    assert.equal(matchRoutine('GUTE NACHT!', routines)?.name, 'Night');
    assert.equal(matchRoutine('wie wird die nacht', routines), null);
    assert.equal(matchRoutine('', routines), null);
});

test('only whole words match, so a routine cannot hijack a longer word', () => {
    const routines = parseRoutineRows([{ name: 'Light', phrases: 'licht', actions: '[{"say":"x"}]' }]);
    assert.equal(matchRoutine('licht', routines)?.name, 'Light');
    assert.equal(matchRoutine('wie heiss ist der lichtschalter', routines), null);
    assert.equal(matchRoutine('das licht bitte', routines)?.name, 'Light');
});

test('the longest matching phrase wins, whatever the table order', () => {
    const routines = parseRoutineRows([
        { name: 'General', phrases: 'gute nacht', actions: '[{"say":"a"}]' },
        { name: 'Specific', phrases: 'gute nacht alle', actions: '[{"say":"b"}]' },
    ]);
    assert.equal(matchRoutine('gute nacht alle', routines)?.name, 'Specific');
    assert.equal(matchRoutine('gute nacht', routines)?.name, 'General');

    const reversed = parseRoutineRows([
        { name: 'Specific', phrases: 'gute nacht alle', actions: '[{"say":"b"}]' },
        { name: 'General', phrases: 'gute nacht', actions: '[{"say":"a"}]' },
    ]);
    assert.equal(matchRoutine('gute nacht alle', reversed)?.name, 'Specific');
});

test('umlauts match whether spoken or typed', () => {
    const routines = parseRoutineRows([{ name: 'Office', phrases: 'Büro aus', actions: '[{"say":"x"}]' }]);
    assert.equal(matchRoutine('buero aus', routines)?.name, 'Office');
    assert.equal(matchRoutine('Büro aus', routines)?.name, 'Office');
});
