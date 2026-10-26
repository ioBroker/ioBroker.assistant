'use strict';
// Unit test: custom wake words — validating an upload and building the JSON config the ESPHome
// firmware downloads next to the model.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
    prepareWakeWord,
    loadWakeWord,
    slugify,
    isTfliteModel,
    MAX_MODEL_BYTES,
    WAKE_WORD_ID_RE,
} = require('../../build/lib/voice/wakeWords.js');

/** A minimal TFLite flatbuffer: the `TFL3` file identifier sits at byte 4. */
function fakeModel(fill = 'x', size = 300) {
    return Buffer.concat([Buffer.from([0x1c, 0, 0, 0]), Buffer.from('TFL3'), Buffer.alloc(size, fill)]);
}

/** The JSON shape of an official microWakeWord v2 model. */
const OFFICIAL_JSON = {
    type: 'micro',
    wake_word: 'Hey Jarvis',
    author: 'Kevin Ahrendt',
    model: 'hey_jarvis.tflite',
    trained_languages: ['en'],
    version: 2,
    micro: {
        probability_cutoff: 0.97,
        feature_step_size: 10,
        sliding_window_size: 5,
        tensor_arena_size: 22860,
        minimum_esphome_version: '2024.7.0',
    },
};

test('a model with its official JSON keeps phrase, languages and tuning', () => {
    const model = fakeModel();
    const word = prepareWakeWord({ model, fileName: 'hey_jarvis.tflite', config: JSON.stringify(OFFICIAL_JSON) }, 'de');
    const sha = crypto.createHash('sha256').update(model).digest('hex');

    assert.equal(word.phrase, 'Hey Jarvis');
    assert.deepEqual(word.languages, ['en'], 'the JSON wins over the default language');
    assert.equal(word.sha256, sha);
    assert.equal(word.size, model.length);
    assert.equal(word.id, `hey_jarvis_${sha.slice(0, 8)}`);
    assert.match(word.id, WAKE_WORD_ID_RE);

    const config = JSON.parse(word.config.toString());
    assert.equal(config.model, `${word.id}.tflite`, 'the device loads the model named here, next to the JSON');
    assert.equal(config.type, 'micro');
    assert.equal(config.author, 'Kevin Ahrendt', 'unknown fields are kept');
    assert.deepEqual(config.micro, OFFICIAL_JSON.micro);
});

test('a bare .tflite gets its phrase from the file name and the voice language', () => {
    const word = prepareWakeWord({ model: fakeModel(), fileName: 'hey_hannah.tflite' }, 'de');
    assert.equal(word.phrase, 'Hey Hannah');
    assert.deepEqual(word.languages, ['de']);
    const config = JSON.parse(word.config.toString());
    assert.equal(config.wake_word, 'Hey Hannah');
    assert.deepEqual(config.trained_languages, ['de']);
    assert.equal(config.version, 2);
    assert.deepEqual(config.micro, { probability_cutoff: 0.97, sliding_window_size: 5 });
});

test('phrase and languages typed by the user override the JSON', () => {
    const word = prepareWakeWord(
        {
            model: fakeModel(),
            fileName: 'hey_jarvis.tflite',
            config: OFFICIAL_JSON,
            phrase: '  Hallo Jarvis ',
            languages: ['DE', 'en', 'de'],
        },
        'ru',
    );
    assert.equal(word.phrase, 'Hallo Jarvis');
    assert.deepEqual(word.languages, ['de', 'en']);
});

test('a changed model is a new wake word, the same model the same one', () => {
    const a = prepareWakeWord({ model: fakeModel('a'), fileName: 'hey_hannah.tflite' });
    const again = prepareWakeWord({ model: fakeModel('a'), fileName: 'hey_hannah.tflite', phrase: 'Hey Hanna' });
    const b = prepareWakeWord({ model: fakeModel('b'), fileName: 'hey_hannah.tflite' });
    assert.equal(a.id, again.id, 'the id depends on the model, not the phrase');
    assert.notEqual(a.id, b.id, 'a device that has the old model would otherwise never fetch the new one');
});

test('anything that cannot run on the device is rejected with a reason', () => {
    assert.throws(() => prepareWakeWord({ model: Buffer.alloc(0) }), /no model file/);
    assert.throws(
        () => prepareWakeWord({ model: Buffer.from('this is not a tflite model'), fileName: 'x.tflite' }),
        /not a TensorFlow Lite model/,
    );
    assert.throws(
        () => prepareWakeWord({ model: fakeModel('x', MAX_MODEL_BYTES), fileName: 'big.tflite' }),
        /microWakeWord models are well below/,
    );
    assert.throws(
        () => prepareWakeWord({ model: fakeModel(), fileName: 'x.tflite', config: { ...OFFICIAL_JSON, type: 'open' } }),
        /"open" model/,
    );
    assert.throws(() => prepareWakeWord({ model: fakeModel(), config: '{ broken' }), /not valid JSON/);
    assert.throws(() => prepareWakeWord({ model: fakeModel(), config: '[1,2]' }), /must contain an object/);
});

test('ids are safe as file names and URL segments', () => {
    assert.equal(slugify('Hey Hännah!.tflite'), 'hey_hannah');
    assert.equal(slugify('C:\\models\\Grüß Gott.tflite'), 'gruss_gott');
    assert.equal(slugify('../../etc/passwd'), 'passwd');
    assert.equal(slugify('Привет'), '', 'nothing usable left');

    const cyrillic = prepareWakeWord({ model: fakeModel(), fileName: 'привет.tflite' });
    assert.match(cyrillic.id, /^wake_word_[0-9a-f]{8}$/);
    assert.equal(cyrillic.phrase, 'Привет');
});

test('a stored wake word loads back with the same identity', () => {
    const word = prepareWakeWord({ model: fakeModel(), fileName: 'hey_hannah.tflite' }, 'de');
    const loaded = loadWakeWord(word.id, word.config, word.model);
    assert.equal(loaded.phrase, word.phrase);
    assert.deepEqual(loaded.languages, word.languages);
    assert.equal(loaded.sha256, word.sha256);
    assert.equal(loaded.size, word.size);

    assert.throws(() => loadWakeWord('../evil', word.config, word.model), /invalid wake word id/);
    assert.throws(() => loadWakeWord(word.id, word.config, Buffer.from('garbage!garbage')), /not a TensorFlow Lite/);
});

test('isTfliteModel looks at the flatbuffer identifier', () => {
    assert.equal(isTfliteModel(fakeModel()), true);
    assert.equal(isTfliteModel(Buffer.from('TFL3')), false);
    assert.equal(isTfliteModel(Buffer.from('PK\u0003\u0004 zip file')), false);
});
