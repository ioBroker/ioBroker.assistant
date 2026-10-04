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
    // Every engine comes wrapped in the shared cache/length/SSML layer, so the provider is internal.
    for (const provider of ['openai', 'azure', 'aws', 'piper']) {
        const engine = createTtsEngine(provider, withKey);
        assert.equal(engine.constructor.name, 'CachedTts', provider);
        assert.equal(typeof engine.synthesize, 'function');
        assert.equal(typeof engine.warm, 'function', 'the cache can be warmed');
    }
    assert.throws(() => createTtsEngine('vosk', withKey), /not text-to-speech/);
});

test('a configured fallback wraps the pair; an unusable one is dropped with a warning', () => {
    const base = ctx({ creds: { ...ctx().creds, openaiKey: 'sk-x' } });
    const warnings = [];
    const withFallback = { ...base, ttsFallback: 'piper', log: { ...base.log, warn: m => warnings.push(m) } };
    assert.equal(createTtsEngine('openai', withFallback).constructor.name, 'FallbackTts');

    // Same provider as the primary → nothing to fall back to.
    assert.equal(createTtsEngine('piper', { ...base, ttsFallback: 'piper' }).constructor.name, 'CachedTts');

    // A fallback that cannot be built (no credentials) must not take the primary down.
    const broken = { ...base, ttsFallback: 'azure', log: { ...base.log, warn: m => warnings.push(m) } };
    assert.equal(createTtsEngine('openai', broken).constructor.name, 'CachedTts');
    assert.match(warnings.join('\n'), /fallback 'azure' unavailable/);
});

test('STT factory wraps a pair too, and keeps the bare engine without a fallback', () => {
    const withKey = ctx({ creds: { ...ctx().creds, openaiKey: 'sk-x' } });
    assert.equal(createSttEngine('openai', withKey).constructor.name, 'OpenAiStt');
    assert.equal(createSttEngine('openai', { ...withKey, sttFallback: 'vosk' }).constructor.name, 'FallbackStt');
    assert.equal(createSttEngine('openai', { ...withKey, sttFallback: 'openai' }).constructor.name, 'OpenAiStt');
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
