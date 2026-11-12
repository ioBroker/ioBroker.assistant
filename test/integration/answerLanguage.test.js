'use strict';
// The language an answer is spoken in: what pi-agent reports for it, else what its letters tell, else the voice
// language; and the Piper voice of the settings only for its own language.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scriptLanguage, speechLanguage } = require('../../build/lib/voice/lang');
const { PiperTts } = require('../../build/lib/voice/piper');
const { PiAgentHarness } = require('../../build/lib/piAgent');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

test('scriptLanguage: Cyrillic, Ukrainian letters and Chinese; Latin tells nothing', () => {
    assert.equal(scriptLanguage('Свет в гостиной включён.'), 'ru');
    assert.equal(scriptLanguage('Світло у вітальні ввімкнено.'), 'uk');
    assert.equal(scriptLanguage('客厅的灯已打开。'), 'zh');
    assert.equal(scriptLanguage('Das Licht ist an.'), '');
    // a German answer with one Russian name stays German
    assert.equal(scriptLanguage('Die Lampe „Торшер“ im Wohnzimmer ist jetzt eingeschaltet.'), '');
});

test('speechLanguage: the language pi-agent reported wins, then the letters, then the voice language', () => {
    assert.equal(speechLanguage('Свет включён.', 'de'), 'ru');
    assert.equal(speechLanguage('Das Licht ist an.', 'de'), 'de');
    assert.equal(speechLanguage('The light is on.', 'de', 'en'), 'en');
    assert.equal(speechLanguage('Свет включён.', 'de', 'ru'), 'ru');
    // the reported language is the voice language: its own form (with region) stays
    assert.equal(speechLanguage('Das Licht ist an.', 'de-DE', 'de'), 'de-DE');
    assert.equal(speechLanguage('Свет включён.', 'ru'), 'ru');
    // nonsense in the report is ignored
    assert.equal(speechLanguage('Свет включён.', 'de', 'Russian please'), 'ru');
});

test('Piper: the chosen voice only for its own language, the default voice for others', () => {
    const tts = new PiperTts('/tmp', 'de_DE-thorsten-medium', silentLog);
    assert.equal(tts.voiceFor('de'), 'de_DE-thorsten-medium');
    assert.equal(tts.voiceFor('de-DE'), 'de_DE-thorsten-medium');
    assert.equal(tts.voiceFor('ru'), 'ru_RU-irina-medium');
    assert.equal(tts.voiceFor('en'), 'en_US-lessac-medium');
    // a language without a default voice keeps the chosen one
    assert.equal(tts.voiceFor('xx'), 'de_DE-thorsten-medium');
    assert.equal(new PiperTts('/tmp', '', silentLog).voiceFor('ru'), 'ru_RU-irina-medium');
});

test('PiAgentHarness remembers the language pi-agent reports for an answer', async () => {
    const replies = [
        { answer: ' Свет включён. ', language: 'RU' },
        { answer: 'Ok.' },
        { answer: 'x', language: '../' },
    ];
    const host = {
        async getForeignStateAsync() {
            return { val: true };
        },
        async sendToAsync() {
            return replies.shift();
        },
    };
    const harness = new PiAgentHarness(host, 'pi-agent.0');
    const ask = text => harness.ask({ text, conversation: 'Gast', instructions: '', language: 'de' });
    assert.equal(await ask('Включи свет'), 'Свет включён.');
    assert.equal(harness.languageOf('Свет включён.'), 'ru');
    assert.equal(await ask('und?'), 'Ok.');
    assert.equal(harness.languageOf('Ok.'), '', 'an older pi-agent reports nothing');
    await ask('y');
    assert.equal(harness.languageOf('x'), '', 'an invalid code is ignored');
});
