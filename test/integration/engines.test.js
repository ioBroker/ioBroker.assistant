'use strict';
// Integration test: STT/TTS engine factory + a couple of pure helpers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSttEngine, createTtsEngine, listVoices } = require('../../build/lib/voice/engines.js');
const { isoToLocale } = require('../../build/lib/voice/lang.js');
const { pcmToWav, hintsToPrompt } = require('../../build/lib/voice/stt.js');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function ctx(over = {}) {
    return {
        creds: { openaiKey: '', azureKey: '', azureRegion: '', aws: { accessKeyId: '', secretAccessKey: '', region: '' } },
        voices: { openai: 'alloy', azure: '', aws: '', piper: '' },
        dataDir: require('node:os').tmpdir(),
        log: silentLog,
        voskModel: '',
        sttModel: '',
        ttsModel: '',
        ...over,
    };
}

test('STT factory: constructs / throws per provider', () => {
    const withKey = ctx({ creds: { ...ctx().creds, openaiKey: 'sk-x', azureKey: 'a', azureRegion: 'r', aws: { accessKeyId: 'A', secretAccessKey: 'S', region: 'eu' } } });
    assert.equal(createSttEngine('openai', withKey).constructor.name, 'OpenAiStt');
    assert.equal(createSttEngine('azure', withKey).constructor.name, 'AzureStt');
    assert.equal(createSttEngine('aws', withKey).constructor.name, 'AwsStt');
    assert.equal(createSttEngine('vosk', withKey).constructor.name, 'VoskStt');
    assert.throws(() => createSttEngine('openai', ctx()), /API key/);
    assert.throws(() => createSttEngine('azure', ctx()), /key and region/);
    assert.throws(() => createSttEngine('piper', withKey), /not speech-to-text/);
});

test('TTS factory: constructs / throws per provider', () => {
    const withKey = ctx({ creds: { ...ctx().creds, openaiKey: 'sk-x', azureKey: 'a', azureRegion: 'r', aws: { accessKeyId: 'A', secretAccessKey: 'S', region: 'eu' } } });
    assert.equal(createTtsEngine('openai', withKey).constructor.name, 'OpenAiTts');
    assert.equal(createTtsEngine('azure', withKey).constructor.name, 'AzureTts');
    assert.equal(createTtsEngine('aws', withKey).constructor.name, 'AwsTts');
    assert.equal(createTtsEngine('piper', withKey).constructor.name, 'PiperTts');
    assert.throws(() => createTtsEngine('vosk', withKey), /not text-to-speech/);
});

test('listVoices: OpenAI returns the fixed set; Piper returns per-language defaults', async () => {
    const v = await listVoices('openai', ctx(), 'de');
    assert.deepEqual(v, ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
    const p = await listVoices('piper', ctx(), 'de');
    assert.ok(p.includes('de_DE-thorsten-medium'));
});

test('isoToLocale maps ISO codes and normalises locales', () => {
    assert.equal(isoToLocale('de'), 'de-DE');
    assert.equal(isoToLocale('ru'), 'ru-RU');
    assert.equal(isoToLocale('zh-cn'), 'zh-CN');
    assert.equal(isoToLocale(''), 'en-US');
    assert.equal(isoToLocale('xx'), 'en-US');
});

test('pcmToWav prepends a valid 44-byte RIFF/WAVE header', () => {
    const pcm = Buffer.alloc(1600, 1);
    const wav = pcmToWav(pcm, 16000);
    assert.equal(wav.length, pcm.length + 44);
    assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
    assert.equal(wav.readUInt32LE(24), 16000, 'sample rate in header');
    assert.equal(wav.readUInt16LE(22), 1, 'mono');
    assert.equal(wav.readUInt16LE(34), 16, 'bits per sample');
});

test('hintsToPrompt joins, de-dups and bounds the STT vocabulary bias', () => {
    assert.equal(hintsToPrompt(undefined), '');
    assert.equal(hintsToPrompt([]), '');
    // joined as a comma list, blanks dropped, case-insensitive de-dup (first spelling kept)
    assert.equal(hintsToPrompt(['Wohnzimmer', 'Licht', '', 'wohnzimmer']), 'Wohnzimmer, Licht');
    // length-bounded: with a tiny budget only what fits is kept
    const many = Array.from({ length: 100 }, (_, i) => `Device${i}`);
    const out = hintsToPrompt(many, 20);
    assert.ok(out.length <= 20, `bounded (${out.length})`);
    assert.ok(out.startsWith('Device0'));
});
