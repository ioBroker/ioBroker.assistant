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
    // ...inside the language layer, which speaks every text in its own language (speechLanguage.ts).
    for (const provider of ['openai', 'azure', 'aws', 'piper']) {
        const engine = createTtsEngine(provider, withKey);
        assert.equal(engine.inner.constructor.name, 'CachedTts', provider);
        assert.equal(typeof engine.synthesize, 'function');
        assert.equal(typeof engine.warm, 'function', 'the cache can be warmed');
    }
    assert.throws(() => createTtsEngine('vosk', withKey), /not text-to-speech/);
});

test('a configured fallback wraps the pair; an unusable one is dropped with a warning', () => {
    const base = ctx({ creds: { ...ctx().creds, openaiKey: 'sk-x' } });
    const warnings = [];
    const withFallback = { ...base, ttsFallback: 'piper', log: { ...base.log, warn: m => warnings.push(m) } };
    assert.equal(createTtsEngine('openai', withFallback).inner.constructor.name, 'FallbackTts');

    // Same provider as the primary → nothing to fall back to.
    assert.equal(createTtsEngine('piper', { ...base, ttsFallback: 'piper' }).inner.constructor.name, 'CachedTts');

    // A fallback that cannot be built (no credentials) must not take the primary down.
    const broken = { ...base, ttsFallback: 'azure', log: { ...base.log, warn: m => warnings.push(m) } };
    assert.equal(createTtsEngine('openai', broken).inner.constructor.name, 'CachedTts');
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

/** A local stand-in for a Whisper container: answers `/v1/audio/transcriptions` and records what it got. */
async function fakeWhisperServer(text = ' Licht in der Küche an \n') {
    const http = require('node:http');
    const requests = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) {
            chunks.push(c);
        }
        const body = Buffer.concat(chunks);
        // Parse the multipart body with the platform's own parser.
        const form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
        requests.push({ url: req.url, auth: req.headers.authorization, form });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ text }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('STT base URL: normalized, /v1 added only to a bare address', () => {
    const { normalizeSttBaseUrl } = require('../../build/lib/voice/stt.js');
    assert.equal(normalizeSttBaseUrl(''), '');
    assert.equal(normalizeSttBaseUrl('  http://192.168.1.10:8000/ '), 'http://192.168.1.10:8000/v1');
    assert.equal(normalizeSttBaseUrl('http://host:8000/v1/'), 'http://host:8000/v1');
    assert.equal(normalizeSttBaseUrl('https://api.groq.com/openai/v1'), 'https://api.groq.com/openai/v1');
    assert.throws(() => normalizeSttBaseUrl('192.168.1.10:8000'), /not a URL/);
});

test('STT base URL: an own server gets the audio, its model and its key — never the OpenAI key', async () => {
    const srv = await fakeWhisperServer();
    try {
        const engine = createSttEngine(
            'openai',
            ctx({
                creds: { ...ctx().creds, openaiKey: 'sk-openai-secret' },
                sttModel: 'Systran/faster-whisper-large-v3-turbo',
                sttBaseUrl: srv.url,
                sttServerKey: '',
            }),
        );
        const text = await engine.transcribe(Buffer.alloc(3200), 16000, 'ru-RU', ['Кухня']);
        assert.equal(text, 'Licht in der Küche an');
        assert.equal(srv.requests.length, 1);
        const [req] = srv.requests;
        assert.equal(req.url, '/v1/audio/transcriptions');
        assert.doesNotMatch(req.auth || '', /sk-openai-secret/);
        assert.equal(req.form.get('model'), 'Systran/faster-whisper-large-v3-turbo');
        assert.equal(req.form.get('language'), 'ru');
        assert.equal(req.form.get('prompt'), 'Кухня');
        assert.equal(req.form.get('file').type, 'audio/wav');

        // With a server key that one goes along.
        const keyed = createSttEngine(
            'openai',
            ctx({ sttModel: 'whisper-large-v3-turbo', sttBaseUrl: `${srv.url}/v1`, sttServerKey: 'local-key' }),
        );
        await keyed.transcribe(Buffer.alloc(3200), 16000, 'de');
        assert.equal(srv.requests[1].auth, 'Bearer local-key');
    } finally {
        srv.close();
    }
});

test('STT base URL: no OpenAI key needed for an own server', () => {
    assert.throws(() => createSttEngine('openai', ctx()), /API key/);
    assert.equal(
        createSttEngine('openai', ctx({ sttBaseUrl: 'http://127.0.0.1:8000' })).constructor.name,
        'OpenAiStt',
    );
});
