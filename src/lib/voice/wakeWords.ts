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
    if (!isTfliteModel(model)) {
        throw new Error('the model file is not a TensorFlow Lite model (.tflite)');
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
        (typeof source.wake_word === 'string' ? source.wake_word.trim() : '') ||
        phraseFromFileName(fileName)
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
    const id = `${slugify(fileName) || slugify(phrase) || 'wake_word'}_${sha256.slice(0, 8)}`;

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
