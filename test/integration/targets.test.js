'use strict';
// Integration test: named announcement targets — groups of rooms and people.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    splitMembers,
    parseTargetRows,
    findTarget,
    isBroadcast,
    describeTargets,
} = require('../../build/lib/targets.js');

test('splitMembers takes a comma or semicolon list, and an array as-is', () => {
    assert.deepEqual(splitMembers('kueche, bad_oben'), ['kueche', 'bad_oben']);
    assert.deepEqual(splitMembers('kueche;bad_oben ;'), ['kueche', 'bad_oben']);
    assert.deepEqual(splitMembers(['a', ' b ']), ['a', 'b']);
    assert.deepEqual(splitMembers(''), []);
    assert.deepEqual(splitMembers(undefined), []);
});

test('parseTargetRows keeps named rows with members and defaults the kind to group', () => {
    const list = parseTargetRows([
        { name: ' Obergeschoss ', members: 'bad_oben, schlafzimmer' },
        { name: 'Denis', members: 'buero', kind: 'PERSON' },
        { name: 'Nobody', members: '   ' },
        { name: '', members: 'kueche' },
        { name: 'denis', members: 'wohnzimmer' },
    ]);
    assert.deepEqual(
        list.map(g => [g.name, g.kind, g.members]),
        [
            ['Obergeschoss', 'group', ['bad_oben', 'schlafzimmer']],
            ['Denis', 'person', ['buero']],
        ],
        'empty rows are skipped and a duplicate name cannot shadow the first definition',
    );
});

test('findTarget ignores case and surrounding space', () => {
    const groups = parseTargetRows([{ name: 'Denis', members: 'buero', kind: 'person' }]);
    assert.equal(findTarget('denis', groups)?.name, 'Denis');
    assert.equal(findTarget('  DENIS  ', groups)?.name, 'Denis');
    assert.equal(findTarget('anna', groups), null);
    assert.equal(findTarget('', groups), null);
});

test('isBroadcast covers the empty name and "all"', () => {
    assert.equal(isBroadcast(''), true);
    assert.equal(isBroadcast(null), true);
    assert.equal(isBroadcast(undefined), true);
    assert.equal(isBroadcast(' All '), true);
    assert.equal(isBroadcast('kueche'), false);
});

test('describeTargets names people and groups separately for the LLM, and is empty without any', () => {
    const groups = parseTargetRows([
        { name: 'Obergeschoss', members: 'bad_oben' },
        { name: 'Denis', members: 'buero', kind: 'person' },
        { name: 'Anna', members: 'schlafzimmer', kind: 'person' },
    ]);
    assert.equal(describeTargets(groups), 'people: Denis, Anna; groups: Obergeschoss');
    assert.equal(describeTargets([]), '');
    assert.equal(describeTargets(parseTargetRows([{ name: 'Oben', members: 'a' }])), 'groups: Oben');
});
