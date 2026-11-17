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
    readTfliteIo,
    microModelProblem,
    MAX_MODEL_BYTES,
    WAKE_WORD_ID_RE,
    trainingName,
    shortWakeWordName,
    wakeWordBaseName,
    activateWakeWord,
    readBundledWakeWords,
    BUNDLED_WAKE_WORD_DIR,
} = require('../../build/lib/voice/wakeWords.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tfliteModel, microModel, openWakeWordModel, FLOAT32, UINT8, INT8 } = require('./tfliteModel.js');

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
    const model = microModel();
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
    const word = prepareWakeWord({ model: microModel(), fileName: 'hey_hannah.tflite' }, 'de');
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
            model: microModel(),
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
    const a = prepareWakeWord({ model: microModel('a'), fileName: 'hey_hannah.tflite' });
    const again = prepareWakeWord({ model: microModel('a'), fileName: 'hey_hannah.tflite', phrase: 'Hey Hanna' });
    const b = prepareWakeWord({ model: microModel('b'), fileName: 'hey_hannah.tflite' });
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
        () => prepareWakeWord({ model: microModel('x', MAX_MODEL_BYTES), fileName: 'big.tflite' }),
        /microWakeWord models are well below/,
    );
    assert.throws(
        () => prepareWakeWord({ model: microModel(), fileName: 'x.tflite', config: { ...OFFICIAL_JSON, type: 'open' } }),
        /"open" model/,
    );
    assert.throws(() => prepareWakeWord({ model: microModel(), config: '{ broken' }), /not valid JSON/);
    assert.throws(() => prepareWakeWord({ model: microModel(), config: '[1,2]' }), /must contain an object/);
});

test('ids are safe as file names and URL segments', () => {
    assert.equal(slugify('Hey Hännah!.tflite'), 'hey_hannah');
    assert.equal(slugify('C:\\models\\Grüß Gott.tflite'), 'gruss_gott');
    assert.equal(slugify('../../etc/passwd'), 'passwd');
    assert.equal(slugify('Привет'), '', 'nothing usable left');

    const cyrillic = prepareWakeWord({ model: microModel(), fileName: 'привет.tflite' });
    assert.match(cyrillic.id, /^wake_word_[0-9a-f]{8}$/);
    assert.equal(cyrillic.phrase, 'Привет');
});

test('a stored wake word loads back with the same identity', () => {
    const word = prepareWakeWord({ model: microModel(), fileName: 'hey_hannah.tflite' }, 'de');
    const loaded = loadWakeWord(word.id, word.config, word.model);
    assert.equal(loaded.phrase, word.phrase);
    assert.deepEqual(loaded.languages, word.languages);
    assert.equal(loaded.sha256, word.sha256);
    assert.equal(loaded.size, word.size);

    assert.throws(() => loadWakeWord('../evil', word.config, word.model), /invalid wake word id/);
    assert.throws(() => loadWakeWord(word.id, word.config, Buffer.from('garbage!garbage')), /not a TensorFlow Lite/);
});

test('isTfliteModel looks at the flatbuffer identifier', () => {
    assert.equal(isTfliteModel(microModel()), true);
    assert.equal(isTfliteModel(Buffer.from('TFL3')), false);
    assert.equal(isTfliteModel(Buffer.from('PK\u0003\u0004 zip file')), false);
});

test('readTfliteIo reads the tensors the device checks', () => {
    assert.deepEqual(readTfliteIo(microModel()), {
        input: { shape: [1, 3, 40], type: INT8, quantized: true },
        output: { shape: [1, 1], type: UINT8, quantized: true },
    });
    assert.deepEqual(readTfliteIo(openWakeWordModel()), {
        input: { shape: [1, 16, 96], type: FLOAT32, quantized: false },
        output: { shape: [1, 1], type: FLOAT32, quantized: false },
    });
    // The file identifier alone is not a model — offsets into nowhere must not throw.
    const garbage = Buffer.concat([Buffer.from([0x1c, 0, 0, 0]), Buffer.from('TFL3'), Buffer.alloc(300, 'x')]);
    assert.equal(readTfliteIo(garbage), null);
    assert.equal(readTfliteIo(Buffer.from([0xff, 0xff, 0xff, 0x7f, 0x54, 0x46, 0x4c, 0x33, 0])), null);
    assert.equal(readTfliteIo(Buffer.from('not a model at all')), null);
});

test('only models the firmware can run are accepted', () => {
    assert.equal(microModelProblem(microModel()), null);
    // What openWakeWord's training notebook produces — happened on the real device: downloaded, never active.
    assert.match(microModelProblem(openWakeWordModel()), /openWakeWord model/);
    assert.throws(() => prepareWakeWord({ model: openWakeWordModel(), fileName: 'vita_nova.tflite' }), /openWakeWord/);

    const otherShape = tfliteModel({
        input: { shape: [1, 49, 32], type: INT8, scale: 0.1 },
        output: { shape: [1, 1], type: UINT8, scale: 0.1 },
    });
    assert.match(microModelProblem(otherShape), /not a microWakeWord model \(input \[1, 49, 32\]/);

    const float = tfliteModel({ input: { shape: [1, 3, 40], type: FLOAT32 }, output: { shape: [1, 1], type: FLOAT32 } });
    assert.match(microModelProblem(float), /not quantized/);
    const floatOut = tfliteModel({
        input: { shape: [1, 3, 40], type: INT8, scale: 0.1 },
        output: { shape: [1, 1], type: FLOAT32 },
    });
    assert.match(microModelProblem(floatOut), /not quantized/);

    const garbage = Buffer.concat([Buffer.from([0x1c, 0, 0, 0]), Buffer.from('TFL3'), Buffer.alloc(300, 'x')]);
    assert.match(microModelProblem(garbage), /damaged/);
    assert.match(microModelProblem(Buffer.from('nope, not a model')), /not a TensorFlow Lite model/);
});

// ── short names, versions, shipped wake words ───────────────────────────────

/** The JSON a training run writes next to its model: the phrase only, no date. */
const TRAINING_JSON = {
    ...OFFICIAL_JSON,
    wake_word: 'ioBroker',
    model: 'iobroker.tflite',
    trained_languages: ['de', 'en'],
};

test('a training run file name becomes a short name with the date', () => {
    assert.equal(trainingName('20261103-085427-9b0f-microwakeword-iobroker.tflite'), '261103_iobroker');
    assert.equal(trainingName('C:\\models\\20261117-101500-e2d7-microwakeword-hey-hannah.json'), '261117_hey_hannah');
    assert.equal(trainingName('20261115_openwakeword_iobroker.onnx'), '261115_iobroker');
    assert.equal(trainingName('20261103-085427-9b0f-microwakeword.tflite'), '261103_wake_word', 'no word left');
    assert.equal(trainingName('hey_bro.tflite'), null, 'no training date');
    assert.equal(trainingName('20261399_iobroker.tflite'), null, 'not a date');

    assert.equal(shortWakeWordName('20261103-085427-9b0f-microwakeword-iobroker.tflite', 'ioBroker'), '261103_iobroker');
    assert.equal(shortWakeWordName('hey_bro.tflite', 'Hey Bro'), 'Hey Bro', 'the JSON names it');
    assert.equal(shortWakeWordName('hey_bro.tflite'), 'Hey Bro', 'from the file name');
});

test('a model from a training run gets the short name and a short id, whatever its JSON says', () => {
    const model = microModel('iobroker');
    const sha = crypto.createHash('sha256').update(model).digest('hex');
    const fileName = '20261103-085427-9b0f-microwakeword-iobroker.tflite';
    const word = prepareWakeWord({ model, fileName, config: TRAINING_JSON });
    assert.equal(word.phrase, '261103_iobroker', 'every version would be "ioBroker" otherwise');
    assert.equal(word.id, `261103_iobroker_${sha.slice(0, 8)}`);
    assert.deepEqual(word.languages, ['de', 'en']);
    assert.equal(JSON.parse(word.config.toString()).wake_word, '261103_iobroker', 'the device lists this name');

    const typed = prepareWakeWord({ model, fileName, config: TRAINING_JSON, phrase: 'ioBroker neu' });
    assert.equal(typed.phrase, 'ioBroker neu', 'a phrase typed by the user still wins');
    assert.equal(typed.id, word.id);
});

test('versions of one wake word share their base name', () => {
    for (const name of [
        '20261028 Iobroker',
        '20261103 085427 9b0f Microwakeword Iobroker',
        '261103_iobroker',
        'ioBroker',
        'iobroker_1a2b3c4d',
        '261103_iobroker_2ae6f3f7',
    ]) {
        assert.equal(wakeWordBaseName(name), 'iobroker', name);
    }
    assert.equal(wakeWordBaseName('Okay Nabu'), 'okay_nabu');
    assert.equal(wakeWordBaseName('Hey Bro'), 'hey_bro');
    assert.equal(wakeWordBaseName('Привет'), '');
});

test('switching a wake word on replaces an older version in its slot, or takes a free one', () => {
    const oldA = '20261028_iobroker_aa11bb22';
    const oldB = '20261103_085427_9b0f_microwakeword_iobrok_cc33dd44';
    const available = [
        { id: 'okay_nabu', phrase: 'Okay Nabu' },
        { id: 'hey_jarvis', phrase: 'Hey Jarvis' },
        { id: oldA, phrase: '20261028 Iobroker' },
        { id: oldB, phrase: '20261103 085427 9b0f Microwakeword Iobroker' },
    ];
    const add = { id: '261117_iobroker_12ab34cd', phrase: '261117_iobroker' };

    // The situation of the screenshot: 2 of 2 active, one of them an older ioBroker.
    assert.deepEqual(activateWakeWord([oldA, 'okay_nabu'], available, add, 2), {
        active: [add.id, 'okay_nabu'],
        replaced: [oldA],
    });
    // Two old versions active: both go, the new one takes the first slot.
    assert.deepEqual(activateWakeWord([oldB, oldA], available, add, 2), {
        active: [add.id],
        replaced: [oldB, oldA],
    });
    assert.deepEqual(activateWakeWord(['okay_nabu'], available, add, 2), {
        active: ['okay_nabu', add.id],
        replaced: [],
    });
    assert.equal(activateWakeWord(['okay_nabu', 'hey_jarvis'], available, add, 2), null, 'full of other words');
    assert.equal(activateWakeWord(['okay_nabu', 'hey_jarvis'], available, add, 0).active.length, 3, 'no limit');
    assert.deepEqual(activateWakeWord([add.id, 'okay_nabu'], available, add, 2), {
        active: [add.id, 'okay_nabu'],
        replaced: [],
    });
    // A name without letters to compare (Cyrillic) replaces nothing.
    assert.equal(
        activateWakeWord(
            ['wake_word_aa11bb22', 'okay_nabu'],
            [{ id: 'wake_word_aa11bb22', phrase: 'Алиса' }],
            { id: 'wake_word_cc33dd44', phrase: 'Привет' },
            2,
        ),
        null,
    );
});

test('shipped wake words: every runnable model with its JSON, others skipped with a reason', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-words-'));
    try {
        const write = (file, data) => fs.writeFileSync(path.join(dir, file), data);
        write('20261103-085427-9b0f-microwakeword-iobroker.tflite', microModel('io'));
        write('20261103-085427-9b0f-microwakeword-iobroker.json', JSON.stringify(TRAINING_JSON));
        write('alisa.tflite', microModel('alisa'));
        write('alisa.json', JSON.stringify({ ...OFFICIAL_JSON, wake_word: 'Alisa', trained_languages: ['ru'] }));
        write('20261115-171514-d050-openwakeword-iobroker.tflite', openWakeWordModel());
        write('20261115-171514-d050-openwakeword-iobroker.onnx', 'onnx');

        const { words, skipped } = await readBundledWakeWords(dir, 'de');
        assert.deepEqual(
            words.map(w => [w.phrase, w.languages.join(',')]),
            [
                ['261103_iobroker', 'de,en'],
                ['Alisa', 'ru'],
            ],
        );
        assert.match(words[0].id, /^261103_iobroker_[0-9a-f]{8}$/);
        assert.equal(skipped.length, 1);
        assert.match(skipped[0].reason, /openWakeWord/);

        const again = await readBundledWakeWords(dir, 'de');
        assert.deepEqual(
            again.words.map(w => w.id),
            words.map(w => w.id),
            'the same id every time — "installed" depends on it',
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.deepEqual(await readBundledWakeWords(path.join(os.tmpdir(), 'no-such-wake-word-dir')), {
        words: [],
        skipped: [],
    });
});

test('every microWakeWord model in the package folder runs on the device', async () => {
    const dir = path.join(__dirname, '..', '..', BUNDLED_WAKE_WORD_DIR);
    const { words, skipped } = await readBundledWakeWords(dir);
    assert.ok(words.length > 0, 'the adapter ships wake words');
    for (const word of words) {
        assert.match(word.id, WAKE_WORD_ID_RE);
        assert.ok(word.phrase.length <= 20, `short name: ${word.phrase}`);
    }
    // Only the openWakeWord models of other satellites may be left out.
    for (const s of skipped) {
        assert.match(s.reason, /openWakeWord/, s.file);
    }
});
