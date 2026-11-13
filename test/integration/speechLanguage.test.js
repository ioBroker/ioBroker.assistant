'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    scriptLanguage,
    speechLanguage,
    voiceFitsLanguage,
    parseVoiceTable,
    LanguageTts,
    VoicePerLanguage,
} = require('../../build/lib/voice/speechLanguage');
const { AwsTts } = require('../../build/lib/voice/aws');
const { createTtsEngine } = require('../../build/lib/voice/engines');

const log = { debug() {}, info() {}, warn() {}, error() {} };

/** A TTS engine that records the language it was asked for. */
function fakeEngine(name) {
    const calls = [];
    return {
        calls,
        async synthesize(text, lang) {
            calls.push({ name, text, lang });
            return { pcm: Buffer.alloc(2), sampleRate: 16000 };
        },
        async prepare(lang) {
            calls.push({ name, prepare: lang });
        },
    };
}

test('scriptLanguage: Cyrillic, Ukrainian, Greek, Chinese, Japanese; Latin and short texts say nothing', () => {
    assert.equal(scriptLanguage('Свет в гостиной включён.'), 'ru');
    assert.equal(scriptLanguage('Світло у вітальні увімкнено.'), 'uk');
    assert.equal(scriptLanguage('Το φως είναι αναμμένο.'), 'el');
    assert.equal(scriptLanguage('客厅的灯开着。'), 'zh');
    assert.equal(scriptLanguage('リビングの電気がついています。'), 'ja');
    assert.equal(scriptLanguage('Das Licht ist an.'), '');
    assert.equal(scriptLanguage('OK'), '');
    assert.equal(scriptLanguage('21 °C'), '');
});

test('speechLanguage: a Russian answer on a German satellite is spoken in Russian', () => {
    // the field report: pi-agent answered in Russian, the German voice spelled "kyrillisch a, kyrillisch b …"
    assert.equal(speechLanguage('В гостиной 21 градус, свет выключен.', 'de'), 'ru');
    // a German device name in a Russian sentence does not change that
    assert.equal(speechLanguage('Лампа «Wohnzimmer» сейчас выключена.', 'de'), 'ru');
    // the letters fit: the configured language stays
    assert.equal(speechLanguage('Das Licht ist an.', 'de'), 'de');
    assert.equal(speechLanguage('Свет включён.', 'ru'), 'ru');
    assert.equal(speechLanguage('Світло увімкнено.', 'ru'), 'uk');
    // too few letters: nothing to tell
    assert.equal(speechLanguage('OK.', 'ru'), 'ru');
    // Latin letters on a Russian satellite: English is the best guess, a Russian voice would mangle them
    assert.equal(speechLanguage('The light is on.', 'ru'), 'en');
});

test('speechLanguage: the language pi-agent reports wins, unless the letters contradict it', () => {
    assert.equal(speechLanguage('The light is on.', 'de', 'en'), 'en');
    assert.equal(speechLanguage('Свет включён.', 'de', 'ru'), 'ru');
    assert.equal(speechLanguage('OK', 'de', 'en'), 'en');
    // a wrong mark on a Cyrillic answer: the letters decide
    assert.equal(speechLanguage('Свет включён.', 'de', 'de'), 'ru');
    assert.equal(speechLanguage('Das Licht ist an.', 'de', 'ru'), 'de');
    assert.equal(speechLanguage('Das Licht ist an.', 'de', 'ru-RU'), 'de');
});

test('voiceFitsLanguage: by the locale at the start of the name', () => {
    assert.equal(voiceFitsLanguage('de_DE-thorsten-medium', 'de'), true);
    assert.equal(voiceFitsLanguage('de_DE-thorsten-medium', 'ru'), false);
    assert.equal(voiceFitsLanguage('de-DE-KatjaNeural', 'ru'), false);
    assert.equal(voiceFitsLanguage('de-DE-SeraphinaMultilingualNeural', 'ru'), true);
    assert.equal(voiceFitsLanguage('de-DE-Klaus:MAI-Voice-2', 'ru'), false);
    assert.equal(voiceFitsLanguage('alloy', 'ru'), true);
    assert.equal(voiceFitsLanguage('Kore', 'ru'), true);
    assert.equal(voiceFitsLanguage('de_DE-thorsten-medium', ''), true);
});

test('parseVoiceTable: ISO code → voice and model, rows without either skipped', () => {
    assert.deepEqual(
        parseVoiceTable([
            { language: 'ru', voice: ' ru_RU-dmitri-medium ' },
            { language: 'en-US', voice: 'en_US-lessac-medium', model: '' },
            { language: 'uk', voice: '', model: ' elevenlabs/eleven-multilingual-v2 ' },
            { language: '', voice: 'x' },
            { language: 'fr', voice: '', model: '' },
            null,
        ]),
        {
            ru: { voice: 'ru_RU-dmitri-medium', model: '' },
            en: { voice: 'en_US-lessac-medium', model: '' },
            uk: { voice: '', model: 'elevenlabs/eleven-multilingual-v2' },
        },
    );
    assert.deepEqual(parseVoiceTable(undefined), {});
});

test('LanguageTts: hands the engine the language of the text, the reported one first', async () => {
    const engine = fakeEngine('main');
    const reported = new Map([['The light is on.', 'en']]);
    const tts = new LanguageTts(engine, text => reported.get(text), log);
    await tts.synthesize('Свет включён.', 'de');
    await tts.synthesize('The light is on.', 'de');
    await tts.synthesize('Das Licht ist an.', 'de');
    assert.deepEqual(
        engine.calls.map(c => c.lang),
        ['ru', 'en', 'de'],
    );
});

test('VoicePerLanguage: the row of the language, else the default engine; prepare loads every row', async () => {
    const main = fakeEngine('main');
    const ru = fakeEngine('ru');
    const tts = new VoicePerLanguage(main, { ru });
    await tts.synthesize('Свет включён.', 'ru');
    await tts.synthesize('Das Licht ist an.', 'de');
    assert.deepEqual(ru.calls, [{ name: 'ru', text: 'Свет включён.', lang: 'ru' }]);
    assert.deepEqual(main.calls, [{ name: 'main', text: 'Das Licht ist an.', lang: 'de' }]);
    await tts.prepare('de');
    assert.deepEqual(main.calls.at(-1), { name: 'main', prepare: 'de' });
    assert.deepEqual(ru.calls.at(-1), { name: 'ru', prepare: 'ru' });
});

test('AwsTts: the set voice only for its language, the default voice of another one', async () => {
    const creds = { accessKeyId: 'a', secretAccessKey: 'b', region: 'eu-central-1' };
    const used = [];
    const polly = new AwsTts(creds, 'Vicki', 'de');
    polly.client.send = async cmd => {
        used.push(cmd.input.VoiceId);
        return { AudioStream: { transformToByteArray: async () => new Uint8Array(2) } };
    };
    await polly.synthesize('Das Licht ist an.', 'de');
    await polly.synthesize('Свет включён.', 'ru');
    await polly.synthesize('x', 'uk'); // no Polly default for Ukrainian: the set voice rather than none
    assert.deepEqual(used, ['Vicki', 'Tatyana', 'Vicki']);
});

test('createTtsEngine: the language layer is outside, a row of the table gets its own engine', async () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speechlang-'));
    try {
        const ctx = {
            creds: { openaiKey: '', openrouterKey: '', azureKey: 'k', azureRegion: 'westeurope', aws: {} },
            voices: { openai: 'alloy', azure: 'de-DE-KatjaNeural', aws: '', piper: '', openrouter: '' },
            dataDir,
            log,
            voskModel: '',
            sttModel: '',
            ttsModel: '',
            openrouterSttModel: '',
            openrouterTtsModel: '',
            language: 'de',
            voicesByLanguage: { ru: { voice: 'ru-RU-SvetlanaNeural', model: '' } },
        };
        const tts = createTtsEngine('azure', ctx);
        assert.equal(tts.constructor.name, 'LanguageTts');
        assert.equal(tts.languageFor('Свет включён.', 'de'), 'ru');
        // one cache directory per voice: the Russian row does not share the German one
        assert.equal(tts.inner.constructor.name, 'VoicePerLanguage');
        assert.deepEqual(Object.keys(tts.inner.byLanguage), ['ru']);
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('createTtsEngine: the model of a row replaces the TTS model for its language', async () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speechlang-'));
    const engineOf = cached => cached.engine;
    try {
        const base = {
            creds: { openaiKey: 'k', openrouterKey: 'k', azureKey: 'k', azureRegion: 'westeurope', aws: {} },
            voices: { openai: 'nova', azure: 'de-DE-KatjaNeural', aws: '', piper: '', openrouter: 'george' },
            dataDir,
            log,
            voskModel: '',
            sttModel: '',
            ttsModel: '',
            openrouterSttModel: '',
            openrouterTtsModel: '',
            language: 'de',
        };
        // OpenRouter: another model without a voice gets none (the voices belong to the model), with a voice that one
        const router = createTtsEngine('openrouter', {
            ...base,
            voicesByLanguage: {
                ru: { voice: '', model: 'elevenlabs/eleven-multilingual-v2' },
                uk: { voice: 'Kore', model: 'google/gemini-3.1-flash-tts-preview' },
                en: { voice: 'adam', model: '' },
            },
        });
        const rows = router.inner.byLanguage;
        const ru = engineOf(rows.ru);
        assert.equal(ru.model, 'elevenlabs/eleven-multilingual-v2');
        assert.equal(ru.voice, '');
        assert.equal(engineOf(rows.uk).model, 'google/gemini-3.1-flash-tts-preview');
        assert.equal(engineOf(rows.uk).voice, 'Kore');
        // a row with only a voice keeps the model set above
        assert.equal(engineOf(rows.en).model, 'elevenlabs/eleven-flash-v2.5');
        assert.equal(engineOf(router.inner.fallback).model, 'elevenlabs/eleven-flash-v2.5');

        // OpenAI: the voice above stays, the model changes, and the cache directory is a different one
        const openai = createTtsEngine('openai', {
            ...base,
            voicesByLanguage: { ru: { voice: '', model: 'gpt-4o-mini-tts' } },
        });
        const row = openai.inner.byLanguage.ru;
        assert.equal(engineOf(row).model, 'gpt-4o-mini-tts');
        assert.equal(engineOf(row).voice, 'nova');
        assert.notEqual(row.opts.dir, openai.inner.fallback.opts.dir);

        // Azure has no model choice: a row with only a model is left out
        const azure = createTtsEngine('azure', {
            ...base,
            voicesByLanguage: { ru: { voice: '', model: 'x' }, uk: { voice: 'uk-UA-PolinaNeural', model: 'x' } },
        });
        assert.deepEqual(Object.keys(azure.inner.byLanguage), ['uk']);
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('questionLanguage: Cyrillic by the letters, English and German by their function words', () => {
    const { questionLanguage } = require('../../build/lib/voice/speechLanguage');
    // the field report: answered with the German time on a German satellite
    assert.equal(questionLanguage('скажи, сколько сейчас времени', 'de'), 'ru');
    assert.equal(questionLanguage('Выключи тестовую лампу', 'de'), 'ru');
    assert.equal(questionLanguage('What time is it?', 'de'), 'en');
    assert.equal(questionLanguage('Turn off the light in the kitchen', 'de'), 'en');
    assert.equal(questionLanguage('Wie spät ist es?', 'en'), 'de');
    assert.equal(questionLanguage('Wie spät ist es?', 'de'), 'de');
    assert.equal(questionLanguage('Сколько времени?', 'ru'), 'ru');
    // the configured language stays when nothing clearly speaks against it
    assert.equal(questionLanguage('Licht an', 'de'), 'de');
    assert.equal(questionLanguage('Licht an', 'ru'), 'ru');
    assert.equal(questionLanguage('Schalte den Fan im Wohnzimmer aus', 'de'), 'de');
    assert.equal(questionLanguage('Turn on Wohnzimmer Licht', 'de'), 'de');
    assert.equal(questionLanguage('Allume la lumière du salon', 'fr'), 'fr');
    assert.equal(questionLanguage('OK', 'de'), 'de');
    assert.equal(questionLanguage('', 'de-DE'), 'de-DE');
});

test('AnswerLanguages: by the text without control markers, the oldest goes first', () => {
    const { AnswerLanguages } = require('../../build/lib/voice/speechLanguage');
    const memo = new AnswerLanguages();
    memo.remember('It is 9:15. [[LISTEN]]', 'en');
    memo.remember('x', 'not a language');
    assert.equal(memo.languageOf('It is 9:15.'), 'en');
    assert.equal(memo.languageOf('x'), '');
    for (let i = 0; i < 50; i++) {
        memo.remember(`answer ${i}`, 'ru');
    }
    assert.equal(memo.languageOf('It is 9:15.'), '');
    assert.equal(memo.languageOf('answer 49'), 'ru');
});
