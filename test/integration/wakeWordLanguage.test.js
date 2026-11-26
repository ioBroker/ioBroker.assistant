'use strict';
// Speech recognition in the language of the wake word (wakeWordLanguage.ts): the table of the settings, matched by
// phrase or id.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    wakeWordKey,
    wakeWordLookupKey,
    parseWakeWordLanguages,
    wakeWordLanguage,
    describeWakeWordLanguages,
    parseWakeWordProfiles,
    wakeWordPurpose,
} = require('../../build/lib/voice/wakeWordLanguage');
const { activeWakeWordLimit } = require('../../build/lib/voice/esphome');

test('activeWakeWordLimit: the ESPHome firmware on an ESP32 reports 1 but runs two, other devices keep theirs', () => {
    assert.equal(activeWakeWordLimit(1, 'Espressif'), 2);
    assert.equal(activeWakeWordLimit(1, ''), 1, 'device info not known');
    assert.equal(activeWakeWordLimit(1, 'Raspberry Pi'), 1, 'ESPHome on another chip: no microWakeWord');
    assert.equal(activeWakeWordLimit(1, 'ThirdReality'), 1, 'another firmware may mean it');
    assert.equal(activeWakeWordLimit(2, 'Espressif'), 2);
    assert.equal(activeWakeWordLimit(0, 'Espressif'), 0, 'no microWakeWord');
});

test('wakeWordKey: case, spaces and separators do not matter', () => {
    assert.equal(wakeWordKey('Hey Bro'), 'heybro');
    assert.equal(wakeWordKey('hey_bro'), 'heybro');
    assert.equal(wakeWordKey(' Hey-Bro! '), 'heybro');
    assert.equal(wakeWordKey('Алиса'), 'алиса');
    assert.equal(wakeWordKey(''), '');
});

test('parseWakeWordLanguages: valid rows only, the first row of a wake word wins', () => {
    const map = parseWakeWordLanguages([
        { wakeWord: 'Alisa', language: 'ru' },
        { wakeWord: 'Hey Bro', language: 'DE ' },
        { wakeWord: 'hey_bro', language: 'en' },
        { wakeWord: '', language: 'de' },
        { wakeWord: 'Jarvis', language: '' },
        { wakeWord: 'Nabu', language: 'deutsch' },
        { wakeWord: 'Xiao', language: 'zh-cn' },
        null,
    ]);
    assert.deepEqual(
        [...map],
        [
            ['alisa', 'ru'],
            ['heybro', 'de'],
            ['xiao', 'zh-cn'],
        ],
    );
    assert.equal(describeWakeWordLanguages(map), 'alisa → ru, heybro → de, xiao → zh-cn');
    // a table stored as an object (older admin) and no table at all
    assert.deepEqual([...parseWakeWordLanguages({ 0: { wakeWord: 'Alisa', language: 'ru' } })], [['alisa', 'ru']]);
    assert.equal(parseWakeWordLanguages(undefined).size, 0);
});

test('wakeWordLanguage: by phrase, by id through the wake words of the device, else nothing', () => {
    const available = [
        { id: 'hey_bro', phrase: 'Hey Bro' },
        { id: 'alisa_ru', phrase: 'Alisa' },
        { id: 'okay_nabu', phrase: 'Okay Nabu' },
    ];
    const byPhrase = parseWakeWordLanguages([{ wakeWord: 'alisa', language: 'ru' }]);
    assert.equal(wakeWordLanguage(byPhrase, 'Alisa'), 'ru');
    // the table names the id, the device reports the phrase
    const byId = parseWakeWordLanguages([{ wakeWord: 'alisa_ru', language: 'ru' }]);
    assert.equal(wakeWordLanguage(byId, 'Alisa', available), 'ru');
    assert.equal(wakeWordLanguage(byId, 'Alisa'), '', 'without the list the id is unknown');
    // not in the table, no phrase, no table
    assert.equal(wakeWordLanguage(byPhrase, 'Okay Nabu', available), '');
    assert.equal(wakeWordLanguage(byPhrase, '', available), '');
    assert.equal(wakeWordLanguage(new Map(), 'Alisa', available), '');
});

test('wakeWordLanguage: a trained model matches its word, whatever its date, hash or id', () => {
    // the shipped ioBroker model reports the phrase "261103_iobroker", its id carries the hash too
    assert.equal(wakeWordLookupKey('261103_iobroker'), 'iobroker');
    assert.equal(wakeWordLookupKey('261103_iobroker_2ae6f3f7'), 'iobroker');
    assert.equal(wakeWordLookupKey('20261117-091512-4c1d-microwakeword-iobroker'), 'iobroker');
    assert.equal(wakeWordLookupKey('Hey Bro'), 'heybro');
    // other letters stay whole: "Hey Алиса" is not "Hey Бро"
    assert.equal(wakeWordLookupKey('Алиса'), 'алиса');
    assert.notEqual(wakeWordLookupKey('Hey Алиса'), wakeWordLookupKey('Hey Бро'));
    // only noise: the plain key
    assert.equal(wakeWordLookupKey('2026'), '2026');

    const byWord = parseWakeWordLanguages([{ wakeWord: 'ioBroker', language: 'de' }]);
    assert.equal(wakeWordLanguage(byWord, '261103_iobroker'), 'de', 'the row names the word only');
    assert.equal(wakeWordLanguage(byWord, '261117_iobroker'), 'de', 'a newer training of it');
    const byVersion = parseWakeWordLanguages([{ wakeWord: '261103_iobroker_2ae6f3f7', language: 'de' }]);
    assert.equal(wakeWordLanguage(byVersion, '261117_iobroker'), 'de', 'a row with an id covers newer versions');
    assert.equal(wakeWordLanguage(byWord, 'Okay Nabu'), '');
    assert.equal(describeWakeWordLanguages(byVersion), 'iobroker → de');
});

test('parseWakeWordProfiles: a row for free questions needs no language, the languages leave it out', () => {
    const rows = [
        { wakeWord: 'Alisa', language: 'ru', purpose: '' },
        { wakeWord: 'Hey Bro', language: '', purpose: 'chat' },
        { wakeWord: 'Jarvis', language: 'en', purpose: 'chat' },
        { wakeWord: 'Nothing', language: '', purpose: '' },
        { wakeWord: 'Odd', language: 'de', purpose: 'whatever' },
    ];
    const profiles = parseWakeWordProfiles(rows);
    assert.deepEqual(
        [...profiles],
        [
            ['alisa', { language: 'ru', purpose: 'home' }],
            ['heybro', { language: '', purpose: 'chat' }],
            ['jarvis', { language: 'en', purpose: 'chat' }],
            ['odd', { language: 'de', purpose: 'home' }],
        ],
        'a row that says nothing is left out, an unknown purpose is the house',
    );
    assert.deepEqual(
        [...parseWakeWordLanguages(rows)],
        [
            ['alisa', 'ru'],
            ['jarvis', 'en'],
            ['odd', 'de'],
        ],
    );
    assert.deepEqual(
        [...parseWakeWordLanguages(profiles)],
        [
            ['alisa', 'ru'],
            ['jarvis', 'en'],
            ['odd', 'de'],
        ],
    );
    assert.equal(
        describeWakeWordLanguages(profiles),
        'alisa → ru, heybro → free questions only, jarvis → en, free questions only, odd → de',
    );
});

test('wakeWordPurpose: by phrase or id, the house without a row', () => {
    const profiles = parseWakeWordProfiles([{ wakeWord: 'hey_bro', purpose: 'chat' }]);
    assert.equal(wakeWordPurpose(profiles, 'Hey Bro'), 'chat');
    assert.equal(wakeWordPurpose(profiles, '261103_hey_bro_2ae6f3f7'), 'chat', 'a trained model, by its base name');
    assert.equal(wakeWordPurpose(profiles, 'Alisa'), 'home');
    assert.equal(wakeWordPurpose(profiles, ''), 'home');
    assert.equal(wakeWordPurpose(new Map(), 'Hey Bro'), 'home');
    // the device reports the phrase, the table names the id
    const byId = parseWakeWordProfiles([{ wakeWord: 'bro_v2', purpose: 'chat' }]);
    assert.equal(wakeWordPurpose(byId, 'Hey Brother', [{ id: 'bro_v2', phrase: 'Hey Brother' }]), 'chat');
});
