/**
 * Local STT via Vosk (https://alphacephei.com/vosk).
 *
 * The official `vosk` npm module depends on `ffi-napi`, which does NOT compile on Node ≥ 20/22
 * (node-api finalizer signature change). So instead of that module we bind the prebuilt **libvosk**
 * shared library directly via **koffi** — a maintained FFI shipped as prebuilt binaries (no node-gyp).
 * Both koffi (npm) and libvosk (GitHub release) are installed on demand into the instance data dir,
 * plus a small language model. Input is 16 kHz mono 16-bit PCM — exactly what satellites stream.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { downloadFile, extractArchive, type VoiceLogger } from './download';
import type { SttEngine } from './stt';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Prebuilt libvosk release to use (contains the shared library + header). */
const LIBVOSK_VERSION = '0.3.45';

/** Default small Vosk model per language (fast enough on a Pi). */
const MODEL: Record<string, string> = {
    en: 'vosk-model-small-en-us-0.15',
    de: 'vosk-model-small-de-0.15',
    ru: 'vosk-model-small-ru-0.22',
    fr: 'vosk-model-small-fr-0.22',
    es: 'vosk-model-small-es-0.42',
    it: 'vosk-model-small-it-0.22',
    nl: 'vosk-model-small-nl-0.22',
    pt: 'vosk-model-small-pt-0.3',
    uk: 'vosk-model-small-uk-v3-small',
    zh: 'vosk-model-small-cn-0.22',
};

/**
 * Curated Vosk models per language for the config dropdown (small first = the default; larger models are
 * more accurate but heavier). See https://alphacephei.com/vosk/models for the full catalog.
 */
const MODEL_CATALOG: Record<string, string[]> = {
    en: ['vosk-model-small-en-us-0.15', 'vosk-model-en-us-0.22', 'vosk-model-en-us-0.42-gigaspeech'],
    de: ['vosk-model-small-de-0.15', 'vosk-model-de-0.21', 'vosk-model-de-tuda-0.6-900k'],
    ru: ['vosk-model-small-ru-0.22', 'vosk-model-ru-0.42'],
    fr: ['vosk-model-small-fr-0.22', 'vosk-model-fr-0.22'],
    es: ['vosk-model-small-es-0.42'],
    it: ['vosk-model-small-it-0.22', 'vosk-model-it-0.22'],
    nl: ['vosk-model-small-nl-0.22', 'vosk-model-nl-spraakherkenning-0.6'],
    pt: ['vosk-model-small-pt-0.3'],
    uk: ['vosk-model-small-uk-v3-small', 'vosk-model-uk-v3'],
    zh: ['vosk-model-small-cn-0.22', 'vosk-model-cn-0.22'],
};

/** Suggested Vosk model names for a language (small default first). Falls back to English. */
export function listVoskModels(language: string): string[] {
    const iso = (language || 'en').split('-')[0].toLowerCase();
    return MODEL_CATALOG[iso] || MODEL_CATALOG.en;
}

/** Prebuilt libvosk asset (release zip name + library file name) for the current platform. */
function libvoskAsset(): { archive: string; libName: string } {
    const v = LIBVOSK_VERSION;
    const p = process.platform;
    const a = process.arch;
    if (p === 'linux' && a === 'arm64') {
        return { archive: `vosk-linux-aarch64-${v}`, libName: 'libvosk.so' };
    }
    if (p === 'linux' && (a === 'x64' || a === 'ia32')) {
        return { archive: `vosk-linux-x86_64-${v}`, libName: 'libvosk.so' };
    }
    if (p === 'win32') {
        return { archive: `vosk-win64-${v}`, libName: 'libvosk.dll' };
    }
    if (p === 'darwin') {
        return { archive: `vosk-osx-${v}`, libName: 'libvosk.dyld' };
    }
    throw new Error(`No prebuilt libvosk for ${p}/${a}`);
}

/** Recursively find a file by name under a directory (for the extracted libvosk library). */
function findFile(dir: string, name: string): string | null {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return null;
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            const hit = findFile(full, name);
            if (hit) {
                return hit;
            }
        } else if (e.name === name) {
            return full;
        }
    }
    return null;
}

function koffiInstalled(dataDir: string): boolean {
    return fs.existsSync(path.join(dataDir, 'node_modules', 'koffi', 'package.json'));
}

/** Install the prebuilt `koffi` FFI module into the data dir via a spawned `npm install` (no node-gyp). */
function installKoffi(dataDir: string, log: VoiceLogger): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(dataDir, { recursive: true });
        const pkg = path.join(dataDir, 'package.json');
        if (!fs.existsSync(pkg)) {
            fs.writeFileSync(pkg, JSON.stringify({ name: 'assistant-local-voice', private: true, version: '1.0.0' }));
        }
        log.info('Installing koffi (first use) — this takes a moment …');
        const child = spawn(NPM, ['install', 'koffi', '--omit=dev', '--no-audit', '--no-fund'], {
            cwd: dataDir,
            shell: process.platform === 'win32',
        });
        child.stdout.on('data', d => log.debug(`npm: ${String(d).trim()}`));
        child.stderr.on('data', d => log.debug(`npm: ${String(d).trim()}`));
        child.on('error', reject);
        child.on('close', code => (code === 0 ? resolve() : reject(new Error(`npm install koffi exited ${code}`))));
    });
}

/** libvosk C-API functions bound via koffi (opaque pointers as `void *`). */
interface VoskApi {
    setLogLevel: (level: number) => void;
    modelNew: (path: string) => unknown;
    recNew: (model: unknown, rate: number) => unknown;
    recFree: (rec: unknown) => void;
    recAccept: (rec: unknown, data: Buffer, len: number) => number;
    recFinal: (rec: unknown) => string;
}

export class VoskStt implements SttEngine {
    private api: VoskApi | null = null;
    private ready: Promise<void> | null = null;
    private readonly models = new Map<string, unknown>(); // iso → libvosk model pointer

    constructor(
        private readonly dataDir: string,
        /** Override model name/dir; '' → default per language. */
        private readonly modelOverride: string,
        private readonly log: VoiceLogger,
    ) {}

    private ensureReady(): Promise<void> {
        if (!this.ready) {
            this.ready = this.load().catch(e => {
                this.ready = null;
                throw e;
            });
        }
        return this.ready;
    }

    /** Ensure koffi + libvosk are present, then bind the C API. */
    private async load(): Promise<void> {
        if (!koffiInstalled(this.dataDir)) {
            await installKoffi(this.dataDir, this.log);
        }
        const libPath = await this.ensureLibvosk();
        const req = createRequire(path.join(this.dataDir, 'package.json'));
        const koffi = req('koffi');
        const lib = koffi.load(libPath);
        this.api = {
            setLogLevel: lib.func('void vosk_set_log_level(int level)'),
            modelNew: lib.func('void* vosk_model_new(const char* path)'),
            recNew: lib.func('void* vosk_recognizer_new(void* model, float rate)'),
            recFree: lib.func('void vosk_recognizer_free(void* rec)'),
            recAccept: lib.func('int vosk_recognizer_accept_waveform(void* rec, const char* data, int len)'),
            recFinal: lib.func('const char* vosk_recognizer_final_result(void* rec)'),
        };
        this.api.setLogLevel(-1); // silence vosk's own logging
        this.log.info('Vosk (libvosk via koffi) loaded.');
    }

    /** Download + extract the prebuilt libvosk for this platform; return the absolute library path. */
    private async ensureLibvosk(): Promise<string> {
        const { archive, libName } = libvoskAsset();
        const libDir = path.join(this.dataDir, 'vosk-lib');
        const existing = findFile(libDir, libName);
        if (existing) {
            return existing;
        }
        const zip = path.join(libDir, `${archive}.zip`);
        await downloadFile(
            `https://github.com/alphacep/vosk-api/releases/download/v${LIBVOSK_VERSION}/${archive}.zip`,
            zip,
            this.log,
        );
        await extractArchive(zip, libDir, this.log);
        const found = findFile(libDir, libName);
        if (!found) {
            throw new Error(`libvosk (${libName}) not found after extracting ${archive}.zip`);
        }
        return found;
    }

    private async ensureModel(lang: string): Promise<unknown> {
        const iso = (lang || 'en').split('-')[0].toLowerCase();
        const cached = this.models.get(iso);
        if (cached) {
            return cached;
        }
        const name = this.modelOverride || MODEL[iso] || MODEL.en;
        const modelsDir = path.join(this.dataDir, 'vosk-models');
        const modelDir = path.join(modelsDir, name);
        if (!fs.existsSync(modelDir)) {
            const zip = path.join(modelsDir, `${name}.zip`);
            await downloadFile(`https://alphacephei.com/vosk/models/${name}.zip`, zip, this.log);
            await extractArchive(zip, modelsDir, this.log);
        }
        const model = this.api!.modelNew(modelDir);
        if (!model) {
            throw new Error(`vosk_model_new failed for ${modelDir}`);
        }
        this.models.set(iso, model);
        return model;
    }

    /** Warm-up: install koffi + libvosk and download the model so the first command isn't slow. */
    async prepare(lang: string): Promise<void> {
        await this.ensureReady();
        await this.ensureModel(lang);
    }

    // Note: the SttEngine `hints` vocabulary is intentionally not applied here. Vosk can bias only via a
    // grammar (vosk_recognizer_new_grm), but that is a *hard* constraint — it restricts recognition to the
    // listed words, which would break free-form questions (weather, general chat). Its words must also exist
    // in the model's lexicon, which arbitrary device names usually don't. So we keep open dictation instead.
    async transcribe(pcm: Buffer, sampleRate: number, lang: string): Promise<string> {
        await this.ensureReady();
        const model = await this.ensureModel(lang);
        const api = this.api!;
        const rec = api.recNew(model, sampleRate);
        try {
            api.recAccept(rec, pcm, pcm.length);
            const json = api.recFinal(rec);
            const res = JSON.parse(json || '{}') as { text?: string };
            return (res.text || '').trim();
        } finally {
            api.recFree(rec);
        }
    }
}
