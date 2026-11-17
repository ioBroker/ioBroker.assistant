/**
 * Custom wake words for ESPHome satellites — models the user uploads, offered to the devices as
 * "external wake words".
 *
 * The ESPHome API has no upload message. Instead the client lists models in every
 * `VoiceAssistantConfigurationRequest` (`external_wake_words`: id, phrase, languages, type, size,
 * SHA-256 and the URL of a JSON config). The device adds them to its available list, and only when one
 * is selected does it fetch the config from `url` and the model from the **same directory** as
 * `<id>.tflite` — query and fragment are dropped — storing both as `<id>.json` / `<id>.tflite` next to
 * its built-in models. Verified in the ThirdReality firmware (`linux-voice-assistant-cpp`,
 * `Satellite.cpp` `ResolveWakeWordConfig`, `audio/ExternalWakeWord.cpp`). Consequences baked in here:
 *
 * - **Only microWakeWord models** (`model_type: "micro"`): the firmware skips any other type.
 * - The device loads the model named by the JSON's `model` field, relative to the JSON — so the JSON we
 *   serve always says `<id>.tflite`, whatever the uploaded file was called.
 * - Once downloaded, a model is a *local* one on the device and wins over the external offer by id. A
 *   changed model under the same id would never reach a device that already has it, so the id carries
 *   a short hash of the model: a new upload is a new wake word.
 * - Downloaded models stay on the device; the API has no way to remove them.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** microWakeWord models are 50–200 KB; anything near this is not one. */
export const MAX_MODEL_BYTES = 1024 * 1024;

/** Ids are file names on the device and path segments in our URL. */
export const WAKE_WORD_ID_RE = /^[a-z0-9_]{1,64}$/;

/** Folder in the instance's file storage (`assistant.0/wakewords/`). */
export const WAKE_WORD_DIR = 'wakewords';

/** Where the media server serves them: `<prefix><id>.json` and `<prefix><id>.tflite`. */
export const WAKE_WORD_URL_PREFIX = '/wakeword/';

/** Defaults of the official v2 models, used when a model comes without its JSON. */
const DEFAULT_MICRO = { probability_cutoff: 0.97, sliding_window_size: 5 };

/** One uploaded wake word, ready to be offered and served. */
export interface CustomWakeWord {
    id: string;
    /** What the user says, e.g. "Hey Hannah". */
    phrase: string;
    /** ISO-639-1 codes the model was trained on. */
    languages: string[];
    /** The JSON config exactly as the device will store it. */
    config: Buffer;
    /** The `.tflite` model. */
    model: Buffer;
    size: number;
    /** SHA-256 of the model, lower-case hex — the device compares it with its cached copy. */
    sha256: string;
}

export interface WakeWordUpload {
    /** The `.tflite` file. */
    model: Buffer;
    /** Name of the uploaded model file — the readable half of the id. */
    fileName?: string;
    /** The `.json` that came with the model, if any. */
    config?: string | Record<string, unknown>;
    /** Overrides the phrase from the JSON. */
    phrase?: string;
    /** Overrides the languages from the JSON. */
    languages?: string[];
}

/** `hey_hannah.tflite` → `hey_hannah`; anything that is not a-z/0-9 becomes `_`. */
export function slugify(value: string): string {
    return value
        .replace(/^.*[\\/]/, '')
        .toLowerCase()
        .replace(/\.(tflite|json)$/, '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40)
        .replace(/_+$/, '');
}

/** The words of a file name in lower-case ASCII: `C:\x\Hey-Hännah.tflite` → `['hey', 'hannah']`. Not truncated. */
function nameTokens(value: string): string[] {
    return value
        .replace(/^.*[\\/]/, '')
        .toLowerCase()
        .replace(/\.(tflite|json|onnx)$/, '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/ß/g, 'ss')
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

/** `20261103` — the date a training run puts in front of its output files. */
const TRAINING_DATE_RE = /^20(\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;

/**
 * Parts of a name that say nothing about the word: the time of the training run (`085427`), its short hash
 * (`9b0f`, also our own 8-character model hash), the model type.
 */
function isNoiseToken(token: string): boolean {
    return (
        /^\d{4,}$/.test(token) ||
        (/^[0-9a-f]{4,8}$/.test(token) && /\d/.test(token) && /[a-f]/.test(token)) ||
        token === 'microwakeword' ||
        token === 'openwakeword' ||
        token === 'wakeword'
    );
}

/**
 * The short name of a model from a training run: `20261103-085427-9b0f-microwakeword-iobroker.tflite` →
 * `261103_iobroker`. The date stays (a newer training of the same word is a newer date), time, hash and model
 * type go. `null` when the file name carries no training date.
 *
 * @param fileName name of the model or JSON file
 */
export function trainingName(fileName: string): string | null {
    let date = '';
    const words = nameTokens(fileName).filter(token => {
        const m = !date && TRAINING_DATE_RE.exec(token);
        if (m) {
            date = `${m[1]}${m[2]}${m[3]}`;
            return false;
        }
        return !isNoiseToken(token);
    });
    return date ? `${date}_${words.join('_') || 'wake_word'}`.slice(0, 40) : null;
}

/**
 * How a wake word appears in the device's list: the short {@link trainingName} for a model from a training run
 * (its JSON says only "ioBroker", which would make every version look the same), otherwise the phrase of the JSON
 * or one built from the file name.
 *
 * @param fileName name of the model file
 * @param phrase the `wake_word` of the JSON that came with it
 */
export function shortWakeWordName(fileName: string, phrase = ''): string {
    return trainingName(fileName) || phrase.trim() || phraseFromFileName(fileName);
}

/**
 * The word without date, time, hash and model type, to tell two versions of the same wake word:
 * `20261028 Iobroker`, `261103_iobroker`, `ioBroker` and the id `iobroker_1a2b3c4d` are all `iobroker`.
 */
export function wakeWordBaseName(value: string): string {
    return nameTokens(value)
        .filter(token => !TRAINING_DATE_RE.test(token) && !isNoiseToken(token))
        .join('_');
}

/**
 * The active wake words of a device after switching `add` on. An active older version of the same word gives up
 * its place (and its slot, so the slot's sensitivity stays) — two versions of one word would both trigger.
 * Otherwise `add` is appended while the device has a free slot.
 *
 * @param active ids active on the device now
 * @param available what the device offers, for the phrases of the active ids
 * @param add the wake word to switch on
 * @param add.id its id
 * @param add.phrase its phrase, which names the word
 * @param max how many the device runs at once (0 = no limit known)
 * @returns the new list and the ids it no longer has, or `null` when every slot is taken by another word
 */
export function activateWakeWord(
    active: string[],
    available: { id: string; phrase: string }[],
    add: { id: string; phrase: string },
    max: number,
): { active: string[]; replaced: string[] } | null {
    if (active.includes(add.id)) {
        return { active: [...active], replaced: [] };
    }
    // No usable name (e.g. a Cyrillic phrase): replace nothing rather than every "wake_word_…".
    const name = wakeWordBaseName(add.phrase);
    const sameWord = (id: string): boolean => {
        const phrase = available.find(w => w.id === id)?.phrase || '';
        return !!name && (wakeWordBaseName(phrase) === name || wakeWordBaseName(id) === name);
    };
    const replaced = active.filter(sameWord);
    if (replaced.length) {
        const next: string[] = [];
        for (const id of active) {
            if (!replaced.includes(id)) {
                next.push(id);
            } else if (!next.includes(add.id)) {
                next.push(add.id);
            }
        }
        return { active: next, replaced };
    }
    if (max > 0 && active.length >= max) {
        return null;
    }
    return { active: [...active, add.id], replaced: [] };
}

/** `hey_hannah` → `Hey Hannah` — a phrase for a model that came without its JSON. */
function phraseFromFileName(fileName: string): string {
    const base = fileName.replace(/^.*[\\/]/, '').replace(/\.(tflite|json)$/i, '');
    return base
        .split(/[_\-\s]+/)
        .filter(Boolean)
        .map(w => w[0].toUpperCase() + w.slice(1))
        .join(' ');
}

/** A TensorFlow Lite flatbuffer carries the file identifier `TFL3` at byte 4. */
export function isTfliteModel(model: Buffer): boolean {
    return model.length > 8 && model.toString('latin1', 4, 8) === 'TFL3';
}

/** microWakeWord feeds 40 mel features per frame (`MicroFeatures::kFeatureSize` on the device). */
const MICRO_FEATURES = 40;

/** openWakeWord classifiers take 96-value speech embeddings, e.g. input `[1, 16, 96]`. */
const OPEN_WAKE_WORD_FEATURES = 96;

/** Shapes longer than this are not a wake word model; it also bounds the loop over a broken file. */
const MAX_DIMENSIONS = 8;

export interface TfliteTensor {
    shape: number[];
    /** TFLite `TensorType`: 0 float32, 3 uint8, 9 int8, … */
    type: number;
    /** Has a non-zero quantization scale. */
    quantized: boolean;
}

/**
 * Read the first input and output tensor of the main graph — the two the device checks before it runs a
 * model. Walks the flatbuffer by hand (schema: `tensorflow/compiler/mlir/lite/schema/schema.fbs`), which
 * spares a TensorFlow dependency for four fields. `null` when the file is not a readable model.
 */
export function readTfliteIo(model: Buffer): { input: TfliteTensor; output: TfliteTensor } | null {
    // Field positions in the schema's tables.
    const MODEL_SUBGRAPHS = 2;
    const SUBGRAPH_TENSORS = 0;
    const SUBGRAPH_INPUTS = 1;
    const SUBGRAPH_OUTPUTS = 2;
    const TENSOR_SHAPE = 0;
    const TENSOR_TYPE = 1;
    const TENSOR_QUANTIZATION = 4;
    const QUANTIZATION_SCALE = 2;

    /** Position of field `index` of the table at `table`, 0 when it is absent. */
    const field = (table: number, index: number): number => {
        const vtable = table - model.readInt32LE(table);
        const offset = 4 + 2 * index;
        if (offset >= model.readUInt16LE(vtable)) {
            return 0;
        }
        const at = model.readUInt16LE(vtable + offset);
        return at ? table + at : 0;
    };
    /** Follow the offset stored in field `index` to the table, vector or string it points at. */
    const ref = (table: number, index: number): number => {
        const at = field(table, index);
        return at ? at + model.readUInt32LE(at) : 0;
    };
    const length = (vector: number): number => (vector ? model.readUInt32LE(vector) : 0);
    /** Element `k` of a vector of tables. */
    const tableAt = (vector: number, k: number): number => {
        const at = vector + 4 + 4 * k;
        return at + model.readUInt32LE(at);
    };
    const intAt = (vector: number, k: number): number => model.readInt32LE(vector + 4 + 4 * k);

    const tensor = (subgraph: number, list: number): TfliteTensor | null => {
        const tensors = ref(subgraph, SUBGRAPH_TENSORS);
        if (!length(list)) {
            return null;
        }
        const index = intAt(list, 0);
        if (index < 0 || index >= length(tensors)) {
            return null;
        }
        const t = tableAt(tensors, index);
        const dims = ref(t, TENSOR_SHAPE);
        if (length(dims) > MAX_DIMENSIONS) {
            return null;
        }
        const shape = Array.from({ length: length(dims) }, (_, k) => intAt(dims, k));
        const typeAt = field(t, TENSOR_TYPE);
        const quantization = ref(t, TENSOR_QUANTIZATION);
        const scales = quantization ? ref(quantization, QUANTIZATION_SCALE) : 0;
        return {
            shape,
            type: typeAt ? model.readUInt8(typeAt) : 0,
            quantized: length(scales) > 0 && model.readFloatLE(scales + 4) !== 0,
        };
    };

    if (!isTfliteModel(model)) {
        return null;
    }
    try {
        const subgraphs = ref(model.readUInt32LE(0), MODEL_SUBGRAPHS);
        if (!length(subgraphs)) {
            return null;
        }
        const main = tableAt(subgraphs, 0);
        const input = tensor(main, ref(main, SUBGRAPH_INPUTS));
        const output = tensor(main, ref(main, SUBGRAPH_OUTPUTS));
        return input && output ? { input, output } : null;
    } catch {
        return null; // an offset pointed outside the file
    }
}

/**
 * Why the device cannot run this model, or `null` when it can. Mirrors the checks of the firmware's
 * `MicroWakeWord::FromConfig`: input `[1, stride, 40]`, quantized input and output. An openWakeWord
 * model is named as such — it is the most likely mix-up, both come as `.tflite`, and the device runs
 * openWakeWord only when its firmware was started in that mode (then without the built-in models).
 *
 * @param model the `.tflite` file
 */
export function microModelProblem(model: Buffer): string | null {
    if (!isTfliteModel(model)) {
        return 'the model file is not a TensorFlow Lite model (.tflite)';
    }
    const io = readTfliteIo(model);
    if (!io) {
        return 'the model file is damaged — it could not be read as a TensorFlow Lite model';
    }
    const shape = io.input.shape;
    if (shape[shape.length - 1] === OPEN_WAKE_WORD_FEATURES) {
        return 'this is an openWakeWord model — the device runs only microWakeWord models, so the wake word has to be trained with microWakeWord';
    }
    if (shape.length !== 3 || shape[2] !== MICRO_FEATURES) {
        return `this is not a microWakeWord model (input [${shape.join(', ')}], a microWakeWord model takes [1, n, ${MICRO_FEATURES}])`;
    }
    if (!io.input.quantized || !io.output.quantized) {
        return 'the model is not quantized — the device runs only quantized microWakeWord models';
    }
    return null;
}

function parseConfig(config: WakeWordUpload['config']): Record<string, unknown> {
    if (config === undefined || config === null || config === '') {
        return {};
    }
    if (typeof config === 'object') {
        return config;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(config);
    } catch (e) {
        throw new Error(`the JSON file is not valid JSON: ${(e as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('the JSON file must contain an object');
    }
    return parsed as Record<string, unknown>;
}

function languageList(value: unknown): string[] {
    return Array.isArray(value) ? [...new Set(value.map(v => String(v).trim().toLowerCase()).filter(Boolean))] : [];
}

/**
 * Validate an upload and build the wake word the devices will download. Throws with a message meant for
 * the user when the files cannot work on the device.
 *
 * @param upload what was uploaded
 * @param defaultLanguage language to record when neither the upload nor its JSON names one
 */
export function prepareWakeWord(upload: WakeWordUpload, defaultLanguage = ''): CustomWakeWord {
    const model = upload.model;
    if (!model?.length) {
        throw new Error('no model file (.tflite) was uploaded');
    }
    if (model.length > MAX_MODEL_BYTES) {
        throw new Error(
            `the model is ${Math.round(model.length / 1024)} KB — microWakeWord models are well below ${MAX_MODEL_BYTES / 1024} KB`,
        );
    }
    const problem = microModelProblem(model);
    if (problem) {
        throw new Error(problem);
    }

    const source = parseConfig(upload.config);
    const type = typeof source.type === 'string' ? source.type : '';
    if (type && type !== 'micro') {
        throw new Error(
            `this is a "${type}" model — the device only accepts microWakeWord models ("micro") from outside`,
        );
    }

    const fileName = upload.fileName || (typeof source.model === 'string' ? source.model : '');
    const phrase = (
        upload.phrase?.trim() ||
        shortWakeWordName(fileName, typeof source.wake_word === 'string' ? source.wake_word : '')
    ).slice(0, 64);
    if (!phrase) {
        throw new Error('the wake word needs a phrase (what you say to wake the device)');
    }

    let languages = languageList(upload.languages);
    if (!languages.length) {
        languages = languageList(source.trained_languages);
    }
    if (!languages.length && defaultLanguage) {
        languages = [defaultLanguage.toLowerCase()];
    }

    const sha256 = createHash('sha256').update(model).digest('hex');
    // The id is the file name on the device and shows up in its logs: short for a training run's output too.
    const id = `${slugify(trainingName(fileName) || fileName) || slugify(phrase) || 'wake_word'}_${sha256.slice(0, 8)}`;

    const micro = source.micro && typeof source.micro === 'object' ? (source.micro as Record<string, unknown>) : {};
    const config = {
        ...source,
        type: 'micro',
        wake_word: phrase,
        model: `${id}.tflite`,
        trained_languages: languages,
        version: typeof source.version === 'number' ? source.version : 2,
        micro: { ...DEFAULT_MICRO, ...micro },
    };

    return {
        id,
        phrase,
        languages,
        config: Buffer.from(`${JSON.stringify(config, null, 2)}\n`),
        model,
        size: model.length,
        sha256,
    };
}

/**
 * Rebuild a stored wake word from its two files (adapter start). The JSON is the one we wrote, so it is
 * trusted for the phrase; size and hash are recomputed from the model rather than stored.
 */
export function loadWakeWord(id: string, config: Buffer, model: Buffer): CustomWakeWord {
    if (!WAKE_WORD_ID_RE.test(id)) {
        throw new Error(`invalid wake word id "${id}"`);
    }
    if (!isTfliteModel(model)) {
        throw new Error(`${id}.tflite is not a TensorFlow Lite model`);
    }
    const parsed = parseConfig(config.toString('utf8'));
    return {
        id,
        phrase: typeof parsed.wake_word === 'string' ? parsed.wake_word : id,
        languages: languageList(parsed.trained_languages),
        config,
        model,
        size: model.length,
        sha256: createHash('sha256').update(model).digest('hex'),
    };
}

/** Folder of the wake words shipped with the adapter, relative to the package root. */
export const BUNDLED_WAKE_WORD_DIR = 'wake-word';

/**
 * Read the wake words shipped with the adapter: every `<name>.tflite` in `dir` the devices can run, with its
 * `<name>.json` when there is one. They are prepared exactly like an upload of the same files, so the id is the
 * one an install stores — `installed` is then just "is this id among the uploaded ones". Models the devices
 * cannot run (openWakeWord models for other satellites) come back in `skipped` with the reason.
 *
 * @param dir the folder
 * @param defaultLanguage language to record when the JSON names none
 */
export async function readBundledWakeWords(
    dir: string,
    defaultLanguage = '',
): Promise<{ words: CustomWakeWord[]; skipped: { file: string; reason: string }[] }> {
    let files: string[];
    try {
        files = await readdir(dir);
    } catch {
        return { words: [], skipped: [] }; // not shipped (e.g. a development checkout without the folder)
    }
    const words: CustomWakeWord[] = [];
    const skipped: { file: string; reason: string }[] = [];
    for (const file of files.filter(f => /\.tflite$/i.test(f)).sort()) {
        const base = file.replace(/\.tflite$/i, '');
        const jsonFile = files.find(f => f.toLowerCase() === `${base.toLowerCase()}.json`);
        try {
            const model = await readFile(join(dir, file));
            const config = jsonFile ? await readFile(join(dir, jsonFile), 'utf8') : undefined;
            const word = prepareWakeWord({ model, fileName: file, config }, defaultLanguage);
            if (!words.some(w => w.id === word.id)) {
                words.push(word);
            }
        } catch (e) {
            skipped.push({ file, reason: (e as Error).message });
        }
    }
    return { words, skipped };
}
