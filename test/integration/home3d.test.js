'use strict';
// Integration test: "Zeig Unterdeck" for the 3D plan of ioBroker.home3d — the names of home3d.N.places, the rule
// that takes only those names, and the replies.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isShowRequest, parsePlaces, parseShowCommand, showLanguage, showReply, HOUSE_TARGET } = require('../../build/lib/home3d.js');

const PLACES = parsePlaces(
    JSON.stringify({
        floors: { Unterdeck: ['Salon', 'Pantry', 'Bad vorne'], Deck: ['Cockpit'], Дом: ['Кухня', 'Гостиная'] },
        devices: [
            { name: 'Diesel', room: 'Salon' },
            { name: 'Salon', room: 'Salon' },
        ],
    }),
);

test('home3d: the names of the places', () => {
    // 3 floors, 6 rooms, 2 devices (the device "Salon" beside the room of that name)
    assert.equal(PLACES.length, 11);
    assert.deepEqual(PLACES[0], { name: 'Unterdeck', kind: 'floor' });
    assert.ok(PLACES.some(p => p.name === 'Diesel' && p.kind === 'device'));
    assert.deepEqual(parsePlaces('not json'), []);
    assert.deepEqual(parsePlaces(null), []);
});

test('home3d: only a sentence that starts with "show" is looked at', () => {
    assert.equal(isShowRequest('Zeige Unterdeck'), true);
    assert.equal(isShowRequest('bitte zeig mir das Bad vorne'), true);
    assert.equal(isShowRequest('покажи кухню'), true);
    assert.equal(isShowRequest('Schalte das Licht an'), false);
});

test('home3d: a floor, a room, a device, the house', () => {
    assert.deepEqual(parseShowCommand('Zeige Unterdeck', PLACES), { target: 'Unterdeck', kind: 'floor' });
    assert.deepEqual(parseShowCommand('zeig mir das Bad vorne', PLACES), { target: 'Bad vorne', kind: 'room' });
    assert.deepEqual(parseShowCommand('Zeig den Diesel an', PLACES), { target: 'Diesel', kind: 'device' });
    assert.deepEqual(parseShowCommand('show the pantry in 3D', PLACES), { target: 'Pantry', kind: 'room' });
    // a room wins over a device of the same name
    assert.deepEqual(parseShowCommand('zeig den Salon', PLACES), { target: 'Salon', kind: 'room' });
    // Russian endings
    assert.deepEqual(parseShowCommand('покажи кухню', PLACES), { target: 'Кухня', kind: 'room' });
    assert.deepEqual(parseShowCommand('покажи мне гостиную', PLACES), { target: 'Гостиная', kind: 'room' });
    // heard with a typo
    assert.deepEqual(parseShowCommand('zeige Unterdek', PLACES), { target: 'Unterdeck', kind: 'floor' });
    assert.deepEqual(parseShowCommand('zeig das ganze Haus', PLACES), { target: HOUSE_TARGET, kind: 'house' });
});

test('home3d: everything else goes on to the other tiers', () => {
    assert.equal(parseShowCommand('zeig das Video von Sailing OceanAir', PLACES), null);
    assert.equal(parseShowCommand('zeig mir die Temperatur im Salon', PLACES), null);
    assert.equal(parseShowCommand('Zeige Unterdeck', []), null);
    assert.equal(parseShowCommand('Schalte den Salon an', PLACES), null);
    assert.equal(parseShowCommand('zeig', PLACES), null);
});

test('home3d: the answer in the language of the verb', () => {
    assert.equal(showLanguage('Zeige Unterdeck', 'ru'), 'de');
    assert.equal(showLanguage('please show the galley', 'de'), 'en');
    assert.equal(showLanguage('покажи кухню', 'de'), 'ru');
    assert.equal(showLanguage('Licht an', 'ru'), 'ru');
});

test('home3d: the replies', () => {
    assert.equal(showReply('de', 'Unterdeck', 'Unterdeck'), 'Ich zeige Unterdeck.');
    assert.equal(showReply('en', 'Pantry', 'Pantry'), 'Showing Pantry.');
    assert.equal(showReply('ru', 'Кухня', 'Кухня'), 'Показываю: Кухня.');
    assert.match(showReply('de', null, 'Unterdeck'), /Keine offene 3D-Ansicht/);
});
