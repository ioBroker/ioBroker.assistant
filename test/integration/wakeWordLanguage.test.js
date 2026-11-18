'use strict';
// Speech recognition in the language of the wake word (wakeWordLanguage.ts): the table of the settings, matched by
// phrase or id.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    wakeWordKey,
    parseWakeWordLanguages,
    wakeWordLanguage,
    describeWakeWordLanguages,
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
