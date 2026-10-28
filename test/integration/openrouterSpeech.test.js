'use strict';
// Speech over OpenRouter: model list, voices, PCM out of the response, and what the engines send.
// No network: the global fetch is replaced (the OpenAI client takes it when it is built).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    OpenRouterStt,
    OpenRouterTts,
    listOpenRouterSpeechModels,
    voicesForLanguage,
    pcmFromResponse,
    DEFAULT_OPENROUTER_TTS_MODEL,
} = require('../../build/lib/voice/openrouter.js');
const { createSttEngine, createTtsEngine, listVoices, listSttModels } = require('../../build/lib/voice/engines.js');
const { pcmToWav } = require('../../build/lib/voice/stt.js');

const SPEECH_MODELS = {
    data: [
        { id: DEFAULT_OPENROUTER_TTS_MODEL, name: 'Gemini TTS', supported_voices: ['Kore', 'Puck'] },
        {
            id: 'microsoft/mai-voice-2',
            name: 'MAI Voice',
            supported_voices: ['en-US-Harper:MAI-Voice-2', 'de-DE-Klaus:MAI-Voice-2'],
        },
        { id: 'minimax/speech-2.8-turbo', name: 'MiniMax', supported_voices: null },
    ],
};
const TRANSCRIPTION_MODELS = { data: [{ id: 'openai/whisper-large-v3-turbo', name: 'Whisper' }, { name: 'no id' }] };

/** Replace the global fetch: model lists answer from the tables above, audio requests go to `audio` */
function fakeNetwork(audio) {
    const requests = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
        const url = String(input instanceof Request ? input.url : input);
        const headers = new Headers(init.headers);
        requests.push({ url, headers, body: init.body });
        if (url.includes('/models?output_modalities=speech')) {
            return Response.json(SPEECH_MODELS);
        }
        if (url.includes('/models?output_modalities=transcription')) {
            return Response.json(TRANSCRIPTION_MODELS);
        }
        return audio(url, init);
    };
    return { requests, restore: () => (globalThis.fetch = original) };
}

test('pcmFromResponse: raw PCM at the rate of the content type or 24 kHz, WAV unwrapped', () => {
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
    assert.deepEqual(pcmFromResponse(pcm, 'audio/pcm'), { pcm, sampleRate: 24000 });
    assert.equal(pcmFromResponse(pcm, 'audio/pcm; rate=16000').sampleRate, 16000);
    assert.equal(pcmFromResponse(pcm, 'audio/pcm;sample_rate=44100').sampleRate, 44100);

    const wav = pcmToWav(pcm, 22050);
    assert.deepEqual(pcmFromResponse(wav, 'audio/wav'), { pcm, sampleRate: 22050 });
    // a LIST chunk between fmt and data, as some encoders write it
    const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO')]);
    const withList = Buffer.concat([wav.subarray(0, 36), list, wav.subarray(36)]);
    withList.writeUInt32LE(withList.length - 8, 4);
    assert.deepEqual(pcmFromResponse(withList, ''), { pcm, sampleRate: 22050 });
});

test('voicesForLanguage: locale voices narrowed to the language, other names untouched', () => {
    const mai = ['en-US-Harper:MAI-Voice-2', 'de-DE-Klaus:MAI-Voice-2', 'es-MX-Valeria:MAI-Voice-2'];
    assert.deepEqual(voicesForLanguage(mai, 'de'), ['de-DE-Klaus:MAI-Voice-2']);
    assert.deepEqual(voicesForLanguage(mai, 'ru'), mai, 'no voice for the language: all of them');
    assert.deepEqual(voicesForLanguage(['Kore', 'Puck'], 'de'), ['Kore', 'Puck']);
    assert.deepEqual(voicesForLanguage(mai, ''), mai);
});

test('model lists and voices come from the public model list (no key)', async () => {
    const net = fakeNetwork(() => new Response('', { status: 500 }));
    try {
        const speech = await listOpenRouterSpeechModels('speech');
        assert.deepEqual(
            speech.map(m => [m.id, m.voices.length]),
            [
                [DEFAULT_OPENROUTER_TTS_MODEL, 2],
                ['microsoft/mai-voice-2', 2],
                ['minimax/speech-2.8-turbo', 0],
            ],
        );
        assert.deepEqual(await listSttModels('openrouter', 'de'), ['openai/whisper-large-v3-turbo']);
        const ctx = { openrouterTtsModel: 'microsoft/mai-voice-2' };
        assert.deepEqual(await listVoices('openrouter', ctx, 'de'), ['de-DE-Klaus:MAI-Voice-2']);
        assert.deepEqual(await listVoices('openrouter', { openrouterTtsModel: '' }, 'de'), ['Kore', 'Puck']);
        assert.ok(
            net.requests.every(r => !r.headers.get('authorization')),
            'the lists need no key',
        );
        assert.equal(net.requests[0].headers.get('x-title'), 'ioBroker');
    } finally {
        net.restore();
    }
});

test('TTS: model, voice and pcm to OpenRouter with the key; without a voice the first one of the model', async () => {
    const pcm = Buffer.alloc(480);
    const net = fakeNetwork(() => new Response(pcm, { headers: { 'content-type': 'audio/pcm' } }));
    try {
        const out = await new OpenRouterTts('sk-or-test', '', '').synthesize('Hallo', 'de');
        assert.equal(out.sampleRate, 24000);
        assert.equal(out.pcm.length, 480);
        const req = net.requests.find(r => r.url.endsWith('/audio/speech'));
        assert.equal(req.url, 'https://openrouter.ai/api/v1/audio/speech');
        assert.equal(req.headers.get('authorization'), 'Bearer sk-or-test');
        assert.equal(req.headers.get('http-referer'), 'https://www.iobroker.net');
        assert.deepEqual(JSON.parse(req.body), {
            model: DEFAULT_OPENROUTER_TTS_MODEL,
            input: 'Hallo',
            voice: 'Kore',
            response_format: 'pcm',
        });

        await new OpenRouterTts('sk-or-test', 'microsoft/mai-voice-2', 'de-DE-Klaus:MAI-Voice-2').synthesize('x', 'de');
        assert.equal(JSON.parse(net.requests.at(-1).body).voice, 'de-DE-Klaus:MAI-Voice-2');
    } finally {
        net.restore();
    }
});

test('TTS: an mp3-only model asks for mp3 and decodes it; without a decoder it says so', async () => {
    const mp3 = Buffer.from('ID3-fake-mp3');
    const net = fakeNetwork(() => new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } }));
    try {
        let decoded = null;
        const decode = async audio => {
            decoded = audio;
            return { pcm: Buffer.alloc(4), sampleRate: 24000 };
        };
        const out = await new OpenRouterTts('k', 'minimax/speech-2.8-turbo', 'English_radiant_girl', decode).synthesize(
            'Hi',
            'en',
        );
        assert.equal(JSON.parse(net.requests.at(-1).body).response_format, 'mp3');
        assert.deepEqual(decoded, mp3);
        assert.equal(out.pcm.length, 4);
        await assert.rejects(
            new OpenRouterTts('k', 'minimax/speech-2.8-turbo', 'x').synthesize('Hi', 'en'),
            /only returns mp3/,
        );
    } finally {
        net.restore();
    }
});

test('STT: WAV upload with model and language, the text trimmed', async () => {
    const net = fakeNetwork(() => Response.json({ text: ' Licht an \n' }));
    try {
        const text = await new OpenRouterStt('sk-or-test').transcribe(Buffer.alloc(3200), 16000, 'de-DE', ['Küche']);
        assert.equal(text, 'Licht an');
        const req = net.requests.find(r => r.url.endsWith('/audio/transcriptions'));
        assert.equal(req.url, 'https://openrouter.ai/api/v1/audio/transcriptions');
        assert.equal(req.headers.get('authorization'), 'Bearer sk-or-test');
        const form = req.body;
        assert.equal(form.get('model'), 'openai/whisper-large-v3-turbo');
        assert.equal(form.get('language'), 'de');
        assert.equal(form.get('prompt'), null, 'OpenRouter ignores a prompt');
        assert.equal(form.get('file').type, 'audio/wav');
    } finally {
        net.restore();
    }
});

test('factory: OpenRouter engines need the OpenRouter key', () => {
    const ctx = key => ({
        creds: {
            openaiKey: 'sk-openai',
            openrouterKey: key,
            azureKey: '',
            azureRegion: '',
            aws: { accessKeyId: '', secretAccessKey: '', region: '' },
        },
        voices: { openai: 'alloy', azure: '', aws: '', piper: '', openrouter: 'Kore' },
        dataDir: require('node:os').tmpdir(),
        log: { info() {}, warn() {}, error() {}, debug() {} },
        voskModel: '',
        sttModel: '',
        ttsModel: '',
        openrouterSttModel: '',
        openrouterTtsModel: '',
    });
    assert.throws(() => createSttEngine('openrouter', ctx('')), /OpenRouter speech needs an API key/);
    assert.throws(() => createTtsEngine('openrouter', ctx('')), /OpenRouter speech needs an API key/);
    assert.equal(createSttEngine('openrouter', ctx('sk-or')).constructor.name, 'OpenRouterStt');
    assert.equal(createTtsEngine('openrouter', ctx('sk-or')).constructor.name, 'CachedTts');
});
