import { createWriteStream, existsSync, promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Model manager for the local LLM (Tier 1a): the GGUF files in one directory, their download, their size,
 * and usage statistics per model file.
 *
 * - The directory is configurable (`localLlmModelDir`, e.g. an SSD); empty = `<instance data dir>/models`.
 * - `<dir>/models.json` remembers where a file came from (URL, preset), so the list can show it.
 * - Statistics live in the instance data dir (`local-llm-stats.json`), keyed by file name: they belong to
 *   this instance and its hardware, not to the file.
 * - Downloads go to `<file>.part` and are renamed only after the GGUF magic was checked, so an HTML error
 *   page from a wrong link never shows up as a model.
 */

/** Localized text of a preset. */
export type Localized = { en: string; de: string; ru: string };

export interface ModelPreset {
    id: string;
    name: string;
    /** File name in the model directory. */
    file: string;
    url: string;
    /** Size of the GGUF file in bytes (checked against Hugging Face). */
    sizeBytes: number;
    /** Parameter count as shown, e.g. "0.6B". */
    params: string;
    /** Languages the authors name on the model card (ISO codes); `multi` = many, including de/ru. */
    languages: string[];
    /** Rough speed class from the parameter count — an estimate, not a measurement. */
    speed: 'very fast' | 'fast' | 'medium' | 'slow';
    /** The model writes a chain of thought first; the adapter turns that off (thought budget 0). */
    thinking?: boolean;
    description: Localized;
}

const HF = 'https://huggingface.co';

/**
 * Presets. URLs and sizes checked against Hugging Face on 2026-11-10; languages from the model cards.
 * Qwen2.5-1.5B is the former default ({@link DEFAULT_PRESET_ID}).
 */
export const MODEL_PRESETS: ModelPreset[] = [
    {
        id: 'mnn-pocket-0.3b',
        name: 'MNN-Pocket 0.3B (Q4_1)',
        file: 'MNN-Pocket-0.3B-Instruct-Q4_1.gguf',
        url: `${HF}/taobao-mnn/MNN-Pocket-0.3B-GGUF/resolve/main/MNN-Pocket-0.3B-Instruct-Q4_1.gguf`,
        sizeBytes: 191_896_672,
        params: '0.3B',
        languages: ['en', 'zh'],
        speed: 'very fast',
        description: {
            en: 'Smallest and fastest. Trained for English and Chinese only: German or Russian questions are understood badly.',
            de: 'Am kleinsten und schnellsten. Nur auf Englisch und Chinesisch trainiert: deutsche oder russische Fragen versteht es schlecht.',
            ru: 'Самая маленькая и быстрая. Обучена только на английском и китайском: немецкие и русские вопросы понимает плохо.',
        },
    },
    {
        id: 'qwen3-0.6b',
        name: 'Qwen3 0.6B (Q4_K_M)',
        file: 'Qwen3-0.6B-Q4_K_M.gguf',
        url: `${HF}/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf`,
        sizeBytes: 396_705_472,
        params: '0.6B',
        languages: ['multi'],
        speed: 'very fast',
        thinking: true,
        description: {
            en: 'Very small, many languages including German and Russian. Its "thinking" is switched off for speed. Good for short facts, weak at anything longer.',
            de: 'Sehr klein, viele Sprachen inklusive Deutsch und Russisch. Das „Nachdenken“ wird für Tempo abgeschaltet. Gut für kurze Fakten, schwach bei allem Längeren.',
            ru: 'Очень маленькая, много языков, включая немецкий и русский. «Размышления» отключаются ради скорости. Хороша для коротких фактов, слаба во всём, что длиннее.',
        },
    },
    {
        id: 'qwen2.5-0.5b',
        name: 'Qwen2.5 0.5B (Q4_K_M)',
        file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
        url: `${HF}/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf`,
        sizeBytes: 491_400_032,
        params: '0.5B',
        languages: ['multi'],
        speed: 'very fast',
        description: {
            en: 'Very small, multilingual. Answers quickly but often wrong; hands device questions over reliably.',
            de: 'Sehr klein, mehrsprachig. Antwortet schnell, aber oft falsch; gibt Gerätefragen zuverlässig ab.',
            ru: 'Очень маленькая, многоязычная. Отвечает быстро, но часто ошибается; вопросы про устройства надёжно передаёт дальше.',
        },
    },
    {
        id: 'gemma3-1b',
        name: 'Gemma 3 1B (Q4_K_M)',
        file: 'google_gemma-3-1b-it-Q4_K_M.gguf',
        url: `${HF}/bartowski/google_gemma-3-1b-it-GGUF/resolve/main/google_gemma-3-1b-it-Q4_K_M.gguf`,
        sizeBytes: 806_058_496,
        params: '1B',
        languages: ['multi'],
        speed: 'fast',
        description: {
            en: 'Google, small and multilingual. A good balance on a Raspberry Pi 5.',
            de: 'Von Google, klein und mehrsprachig. Guter Kompromiss auf einem Raspberry Pi 5.',
            ru: 'От Google, маленькая и многоязычная. Хороший компромисс для Raspberry Pi 5.',
        },
    },
    {
        id: 'llama3.2-1b',
        name: 'Llama 3.2 1B (Q4_K_M)',
        file: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
        url: `${HF}/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf`,
        sizeBytes: 807_694_464,
        params: '1B',
        languages: ['en', 'de', 'fr', 'it', 'pt', 'hi', 'es', 'th'],
        speed: 'fast',
        description: {
            en: 'Meta. Officially English, German and six more languages, not Russian.',
            de: 'Von Meta. Offiziell Englisch, Deutsch und sechs weitere Sprachen, kein Russisch.',
            ru: 'От Meta. Официально английский, немецкий и ещё шесть языков, русского нет.',
        },
    },
    {
        id: 'qwen3-1.7b',
        name: 'Qwen3 1.7B (Q4_K_M)',
        file: 'Qwen3-1.7B-Q4_K_M.gguf',
        url: `${HF}/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf`,
        sizeBytes: 1_107_409_472,
        params: '1.7B',
        languages: ['multi'],
        speed: 'medium',
        thinking: true,
        description: {
            en: 'Multilingual, noticeably better than the small ones. "Thinking" is switched off for speed.',
            de: 'Mehrsprachig, merklich besser als die kleinen. Das „Nachdenken“ wird für Tempo abgeschaltet.',
            ru: 'Многоязычная, заметно лучше маленьких. «Размышления» отключаются ради скорости.',
        },
    },
    {
        id: 'qwen2.5-1.5b',
        name: 'Qwen2.5 1.5B (Q4_K_M)',
        file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
        url: `${HF}/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf`,
        sizeBytes: 1_117_320_736,
        params: '1.5B',
        languages: ['multi'],
        speed: 'medium',
        description: {
            en: 'The previous default. Multilingual, solid for general questions.',
            de: 'Der bisherige Standard. Mehrsprachig, solide bei allgemeinen Fragen.',
            ru: 'Прежняя модель по умолчанию. Многоязычная, надёжна в общих вопросах.',
        },
    },
    {
        id: 'llama3.2-3b',
        name: 'Llama 3.2 3B (Q4_K_M)',
        file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
        url: `${HF}/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf`,
        sizeBytes: 2_019_377_696,
        params: '3B',
        languages: ['en', 'de', 'fr', 'it', 'pt', 'hi', 'es', 'th'],
        speed: 'slow',
        description: {
            en: 'Meta, better answers, but slow on a Raspberry Pi. No Russian.',
            de: 'Von Meta, bessere Antworten, aber langsam auf einem Raspberry Pi. Kein Russisch.',
            ru: 'От Meta, ответы лучше, но на Raspberry Pi медленно. Русского нет.',
        },
    },
    {
        id: 'qwen2.5-3b',
        name: 'Qwen2.5 3B (Q4_K_M)',
        file: 'qwen2.5-3b-instruct-q4_k_m.gguf',
        url: `${HF}/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf`,
        sizeBytes: 2_104_932_768,
        params: '3B',
        languages: ['multi'],
        speed: 'slow',
        description: {
            en: 'Multilingual, better answers, but slow on a Raspberry Pi. Needs about 3 GB RAM.',
            de: 'Mehrsprachig, bessere Antworten, aber langsam auf einem Raspberry Pi. Braucht etwa 3 GB RAM.',
            ru: 'Многоязычная, ответы лучше, но на Raspberry Pi медленно. Нужно около 3 ГБ ОЗУ.',
        },
    },
    {
        id: 'gemma3-4b',
        name: 'Gemma 3 4B (Q4_K_M)',
        file: 'google_gemma-3-4b-it-Q4_K_M.gguf',
        url: `${HF}/bartowski/google_gemma-3-4b-it-GGUF/resolve/main/google_gemma-3-4b-it-Q4_K_M.gguf`,
        sizeBytes: 2_489_758_112,
        params: '4B',
        languages: ['multi'],
        speed: 'slow',
        description: {
            en: 'Google, the best of the presets, but only sensible on a PC or a strong mini PC.',
            de: 'Von Google, die beste der Vorlagen, aber nur auf einem PC oder starken Mini-PC sinnvoll.',
            ru: 'От Google, лучшая из предустановок, но разумна только на ПК или мощном мини-ПК.',
        },
    },
];

export const DEFAULT_PRESET_ID = 'qwen2.5-1.5b';

/** Space kept free after a download, so the host does not run out of disk. */
export const DISK_RESERVE_BYTES = 200 * 1024 * 1024;

const META_FILE = 'models.json';
const STATS_FILE = 'local-llm-stats.json';
const GGUF_MAGIC = 'GGUF';

type Logger = Pick<ioBroker.Logger, 'info' | 'warn' | 'debug'>;

/** Counters of one model; sums so the averages stay exact over restarts. */
export interface ModelStats {
    asked: number;
    answered: number;
    handoffs: number;
    busy: number;
    timeouts: number;
    errors: number;
    /** Sum of the run times of all answered questions. */
    answerMs: number;
    /** Generated tokens and the time it took from the first to the last token. */
    tokens: number;
    genMs: number;
    /** Sum of times to the first token, and how many runs had one. */
    firstTokenMs: number;
    firstTokenRuns: number;
    promptTokens: number;
    loads: number;
    lastLoadMs: number;
    lastUsed: number;
    benchmark?: BenchmarkResult;
}

export interface BenchmarkResult {
    at: number;
    languages: string[];
    cases: number;
    correct: number;
    /** A home question the model answered itself instead of handing off. */
    missedHandoffs: number;
    /** A general question the model handed off. */
    needlessHandoffs: number;
    /** A general question answered, but without the expected fact. */
    wrongAnswers: number;
    timeouts: number;
    errors: number;
    tokensPerSec: number;
    avgFirstTokenMs: number;
    avgMs: number;
    /** Per case, for the details view. */
    details: { lang: string; question: string; expect: string; answer: string; ok: boolean; ms: number }[];
}

export interface ModelStatsSummary extends ModelStats {
    /** Share of questions the model did not handle (timeout or error), 0–1; null without questions. */
    failureRate: number | null;
    tokensPerSec: number | null;
    avgFirstTokenMs: number | null;
    avgAnswerMs: number | null;
}

export type RunOutcome = 'answered' | 'handoff' | 'busy' | 'timeout' | 'error';

export interface RunSample {
    outcome: RunOutcome;
    ms: number;
    tokens?: number;
    genMs?: number;
    firstTokenMs?: number;
    promptTokens?: number;
}

export interface ModelInfo {
    file: string;
    name: string;
    sizeBytes: number;
    modifiedAt: number;
    url?: string;
    presetId?: string;
    addedAt?: number;
    stats: ModelStatsSummary;
}

export interface DownloadInfo {
    file: string;
    url: string;
    dir: string;
    presetId?: string;
    received: number;
    total: number;
    startedAt: number;
    /** Set when the download failed; the entry stays a while so the GUI can show it. */
    error?: string;
}

export interface DiskInfo {
    free: number;
    total: number;
}

function emptyStats(): ModelStats {
    return {
        asked: 0,
        answered: 0,
        handoffs: 0,
        busy: 0,
        timeouts: 0,
        errors: 0,
        answerMs: 0,
        tokens: 0,
        genMs: 0,
        firstTokenMs: 0,
        firstTokenRuns: 0,
        promptTokens: 0,
        loads: 0,
        lastLoadMs: 0,
        lastUsed: 0,
    };
}

/** Averages for display; nulls where there is nothing to average. */
export function summarizeStats(s: ModelStats | undefined): ModelStatsSummary {
    const st = { ...emptyStats(), ...(s || {}) };
    const handled = st.asked - st.busy;
    return {
        ...st,
        failureRate: handled > 0 ? (st.timeouts + st.errors) / handled : null,
        tokensPerSec: st.genMs > 0 ? (st.tokens / st.genMs) * 1000 : null,
        avgFirstTokenMs: st.firstTokenRuns > 0 ? st.firstTokenMs / st.firstTokenRuns : null,
        avgAnswerMs: st.answered > 0 ? st.answerMs / st.answered : null,
    };
}

/**
 * Normalizes what a user pastes: `hf:org/repo/file.gguf` and Hugging Face `/blob/` page links become direct
 * download links. Returns '' for anything that is not http(s).
 */
export function normalizeModelUrl(input: string): string {
    let url = (input || '').trim();
    const hf = /^hf:\/*([^/]+)\/([^/]+)\/(.+)$/i.exec(url);
    if (hf) {
        url = `${HF}/${hf[1]}/${hf[2]}/resolve/main/${hf[3]}`;
    }
    if (!/^https?:\/\//i.test(url)) {
        return '';
    }
    // https://huggingface.co/org/repo/blob/main/x.gguf → …/resolve/main/x.gguf
    return url.replace(/^(https?:\/\/(?:www\.)?huggingface\.co\/[^/]+\/[^/]+)\/blob\//i, '$1/resolve/');
}

/** File name a model URL is stored as; '' when the URL does not end in a `.gguf` file. */
export function modelFileName(url: string): string {
    const last = (url.split('?')[0].split('#')[0].split('/').pop() || '').trim();
    let name = '';
    try {
        name = decodeURIComponent(last);
    } catch {
        name = last;
    }
    name = name.replace(/[^\w.\-+]/g, '_');
    return /\.gguf$/i.test(name) ? name : '';
}

/** Display name of a model file ("qwen2.5-1.5b-instruct-q4_k_m"). */
export function modelDisplayName(file: string): string {
    const preset = MODEL_PRESETS.find(p => p.file === file);
    return preset ? preset.name : file.replace(/\.gguf$/i, '');
}

export function presetForFile(file: string): ModelPreset | undefined {
    return MODEL_PRESETS.find(p => p.file === file);
}

/** A file name that is safe to join to the model directory. */
function safeFile(file: string): string {
    const base = path.basename(String(file || ''));
    if (!base || base !== file || !/\.gguf$/i.test(base)) {
        throw new Error(`invalid model file name "${file}"`);
    }
    return base;
}

/** The nearest existing directory at or above `dir` (statfs needs one). */
async function existingParent(dir: string): Promise<string> {
    let cur = path.resolve(dir);
    for (;;) {
        try {
            const st = await fsp.stat(cur);
            if (st.isDirectory()) {
                return cur;
            }
        } catch {
            /* go up */
        }
        const up = path.dirname(cur);
        if (up === cur) {
            return cur;
        }
        cur = up;
    }
}

export class ModelManager {
    private stats: Record<string, ModelStats> = {};
    private statsLoaded = false;
    private saveTimer: NodeJS.Timeout | null = null;
    private readonly downloads = new Map<string, { info: DownloadInfo; abort: AbortController }>();
    /** Failed downloads stay listed for a minute so the GUI can show the error. */
    private readonly failed = new Map<string, { info: DownloadInfo; failedAt: number }>();

    constructor(
        private readonly dataDir: string,
        private readonly log: Logger,
    ) {}

    /** The model directory: configured absolute path, or `<dataDir>/models`. */
    resolveDir(configured?: string): string {
        const dir = (configured || '').trim();
        if (!dir) {
            return path.join(this.dataDir, 'models');
        }
        if (!path.isAbsolute(dir)) {
            throw new Error(`the model directory must be an absolute path: "${dir}"`);
        }
        return path.resolve(dir);
    }

    /** Full path of a model file. */
    modelPath(dir: string, file: string): string {
        return path.join(dir, safeFile(file));
    }

    // ---- Directory ---------------------------------------------------------------------------------------

    private async readMeta(
        dir: string,
    ): Promise<Record<string, { url?: string; presetId?: string; addedAt?: number }>> {
        try {
            const data = JSON.parse(await fsp.readFile(path.join(dir, META_FILE), 'utf8'));
            return data && typeof data === 'object' ? data : {};
        } catch {
            return {};
        }
    }

    private async writeMeta(dir: string, meta: Record<string, unknown>): Promise<void> {
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, META_FILE), JSON.stringify(meta, null, 2));
    }

    /** Remembers where a file came from, e.g. for a model the legacy loader downloaded. */
    async rememberSource(dir: string, file: string, url: string): Promise<void> {
        const meta = await this.readMeta(dir);
        if (!meta[file]?.url) {
            meta[file] = { ...meta[file], url, presetId: presetForFile(file)?.id, addedAt: Date.now() };
            await this.writeMeta(dir, meta);
        }
    }

    /** The GGUF files in `dir` (not the `.part` files of running downloads). */
    async list(dir: string): Promise<ModelInfo[]> {
        await this.loadStats();
        let names: string[] = [];
        try {
            names = await fsp.readdir(dir);
        } catch {
            return [];
        }
        const meta = await this.readMeta(dir);
        const out: ModelInfo[] = [];
        for (const file of names) {
            if (!/\.gguf$/i.test(file)) {
                continue;
            }
            try {
                const st = await fsp.stat(path.join(dir, file));
                if (!st.isFile()) {
                    continue;
                }
                const m = meta[file] || {};
                out.push({
                    file,
                    name: modelDisplayName(file),
                    sizeBytes: st.size,
                    modifiedAt: st.mtimeMs,
                    url: m.url || presetForFile(file)?.url,
                    presetId: m.presetId || presetForFile(file)?.id,
                    addedAt: m.addedAt,
                    stats: summarizeStats(this.stats[file]),
                });
            } catch {
                /* vanished meanwhile */
            }
        }
        return out.sort((a, b) => a.sizeBytes - b.sizeBytes);
    }

    async disk(dir: string): Promise<DiskInfo | null> {
        try {
            const st = await fsp.statfs(await existingParent(dir));
            return { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
        } catch {
            return null;
        }
    }

    /** Deletes a model file and its source entry. Never the active model or one that is downloading. */
    async delete(dir: string, file: string, activeFile: string): Promise<void> {
        const name = safeFile(file);
        if (name === activeFile) {
            throw new Error('the active model cannot be deleted; select another model first');
        }
        if (this.downloads.has(name)) {
            throw new Error('the model is still downloading; cancel the download first');
        }
        await fsp.rm(path.join(dir, name), { force: true });
        const meta = await this.readMeta(dir);
        if (meta[name]) {
            delete meta[name];
            await this.writeMeta(dir, meta);
        }
        this.log.info(`Local model ${name} deleted from ${dir}`);
    }

    // ---- Downloads ---------------------------------------------------------------------------------------

    /** Running downloads plus failed ones of the last minute. */
    listDownloads(): DownloadInfo[] {
        const now = Date.now();
        for (const [key, f] of this.failed) {
            if (now - f.failedAt > 60_000) {
                this.failed.delete(key);
            }
        }
        return [
            ...[...this.downloads.values()].map(d => ({ ...d.info })),
            ...[...this.failed.values()].map(f => f.info),
        ];
    }

    isDownloading(file: string): boolean {
        return this.downloads.has(file);
    }

    /**
     * Starts a download in the background and returns at once. Checks first: valid `.gguf` link, not
     * already there, enough free space (size from a HEAD request; a server without a size is not checked).
     * `onDone` runs after success or failure.
     */
    async startDownload(
        input: string,
        dir: string,
        onDone?: (file: string, error?: Error) => void,
        onProgress?: (info: DownloadInfo) => void,
    ): Promise<DownloadInfo> {
        const url = normalizeModelUrl(input);
        if (!url) {
            throw new Error('not a http(s) link or hf:org/repo/file.gguf');
        }
        const file = modelFileName(url);
        if (!file) {
            throw new Error('the link must point to a .gguf file');
        }
        if (this.downloads.has(file)) {
            throw new Error(`${file} is already downloading`);
        }
        if (existsSync(path.join(dir, file))) {
            throw new Error(`${file} is already in ${dir}`);
        }
        const preset = MODEL_PRESETS.find(p => p.url === url || p.file === file);
        let total = preset?.sizeBytes || 0;
        try {
            const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
            if (!head.ok) {
                throw new Error(`HTTP ${head.status}`);
            }
            total = Number(head.headers.get('content-length')) || total;
        } catch (e) {
            throw new Error(`cannot reach ${url}: ${(e as Error).message}`);
        }
        await fsp.mkdir(dir, { recursive: true });
        const disk = await this.disk(dir);
        if (disk && total && total + DISK_RESERVE_BYTES > disk.free) {
            throw new Error(
                `not enough free space in ${dir}: ${formatBytes(total)} needed plus ${formatBytes(DISK_RESERVE_BYTES)} reserve, ${formatBytes(disk.free)} free`,
            );
        }

        this.failed.delete(file);
        const info: DownloadInfo = { file, url, dir, presetId: preset?.id, received: 0, total, startedAt: Date.now() };
        const abort = new AbortController();
        this.downloads.set(file, { info, abort });
        this.log.info(`Downloading local model ${file} (${total ? formatBytes(total) : 'unknown size'}) to ${dir}`);

        void this.runDownload(info, abort.signal, onProgress)
            .then(async () => {
                const meta = await this.readMeta(dir);
                meta[file] = { url, presetId: preset?.id, addedAt: Date.now() };
                await this.writeMeta(dir, meta);
                this.log.info(`Local model ${file} downloaded`);
                onDone?.(file);
            })
            .catch(e => {
                const msg = abort.signal.aborted ? 'cancelled' : (e as Error).message;
                if (!abort.signal.aborted) {
                    this.log.warn(`Download of local model ${file} failed: ${msg}`);
                }
                this.failed.set(file, { info: { ...info, error: msg }, failedAt: Date.now() });
                onDone?.(file, new Error(msg));
            })
            .finally(() => this.downloads.delete(file));
        return { ...info };
    }

    cancelDownload(file: string): boolean {
        const d = this.downloads.get(file);
        if (!d) {
            return false;
        }
        d.abort.abort();
        return true;
    }

    /** Download to `<file>.part`, check the GGUF magic, then rename. */
    private async runDownload(
        info: DownloadInfo,
        signal: AbortSignal,
        onProgress?: (info: DownloadInfo) => void,
    ): Promise<void> {
        const target = path.join(info.dir, info.file);
        const part = `${target}.part`;
        try {
            const res = await fetch(info.url, { redirect: 'follow', signal });
            if (!res.ok || !res.body) {
                throw new Error(`HTTP ${res.status}`);
            }
            info.total = Number(res.headers.get('content-length')) || info.total;
            let lastReport = 0;
            const counter = new Transform({
                transform(chunk: Buffer, _enc, cb) {
                    info.received += chunk.length;
                    const now = Date.now();
                    if (onProgress && now - lastReport > 1000) {
                        lastReport = now;
                        onProgress({ ...info });
                    }
                    cb(null, chunk);
                },
            });
            await pipeline(Readable.fromWeb(res.body as any), counter, createWriteStream(part), { signal });
            const fh = await fsp.open(part, 'r');
            const magic = Buffer.alloc(4);
            try {
                await fh.read(magic, 0, 4, 0);
            } finally {
                await fh.close();
            }
            if (magic.toString('latin1') !== GGUF_MAGIC) {
                throw new Error('the downloaded file is not a GGUF model (wrong link?)');
            }
            await fsp.rename(part, target);
            onProgress?.({ ...info, received: info.total || info.received });
        } catch (e) {
            await fsp.rm(part, { force: true }).catch(() => undefined);
            throw e;
        }
    }

    /** Cancels all downloads (adapter stop). */
    cancelAll(): void {
        for (const d of this.downloads.values()) {
            d.abort.abort();
        }
    }

    // ---- Statistics --------------------------------------------------------------------------------------

    private async loadStats(): Promise<void> {
        if (this.statsLoaded) {
            return;
        }
        this.statsLoaded = true;
        try {
            const data = JSON.parse(await fsp.readFile(path.join(this.dataDir, STATS_FILE), 'utf8'));
            if (data && typeof data === 'object') {
                this.stats = data;
            }
        } catch {
            /* first start */
        }
    }

    private scheduleSave(): void {
        if (this.saveTimer) {
            return;
        }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.flush();
        }, 5000);
    }

    async flush(): Promise<void> {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        if (!this.statsLoaded) {
            return;
        }
        try {
            await fsp.mkdir(this.dataDir, { recursive: true });
            await fsp.writeFile(path.join(this.dataDir, STATS_FILE), JSON.stringify(this.stats));
        } catch (e) {
            this.log.debug(`Cannot save local model statistics: ${(e as Error).message}`);
        }
    }

    private async entry(file: string): Promise<ModelStats> {
        await this.loadStats();
        const s = (this.stats[file] = { ...emptyStats(), ...(this.stats[file] || {}) });
        return s;
    }

    async recordRun(file: string, sample: RunSample): Promise<void> {
        const s = await this.entry(file);
        s.asked++;
        s.lastUsed = Date.now();
        switch (sample.outcome) {
            case 'answered':
                s.answered++;
                s.answerMs += sample.ms;
                break;
            case 'handoff':
                s.handoffs++;
                break;
            case 'busy':
                s.busy++;
                break;
            case 'timeout':
                s.timeouts++;
                break;
            case 'error':
                s.errors++;
                break;
        }
        if (sample.tokens && sample.genMs && sample.genMs > 0) {
            s.tokens += sample.tokens;
            s.genMs += sample.genMs;
        }
        if (sample.firstTokenMs !== undefined && sample.firstTokenMs >= 0) {
            s.firstTokenMs += sample.firstTokenMs;
            s.firstTokenRuns++;
        }
        if (sample.promptTokens) {
            s.promptTokens += sample.promptTokens;
        }
        this.scheduleSave();
    }

    async recordLoad(file: string, ms: number): Promise<void> {
        const s = await this.entry(file);
        s.loads++;
        s.lastLoadMs = ms;
        this.scheduleSave();
    }

    async recordBenchmark(file: string, result: BenchmarkResult): Promise<void> {
        const s = await this.entry(file);
        s.benchmark = result;
        await this.flush();
    }

    async getStats(file: string): Promise<ModelStatsSummary> {
        await this.loadStats();
        return summarizeStats(this.stats[file]);
    }

    /** Resets the statistics of one model, or of all when `file` is empty. The benchmark result stays. */
    async resetStats(file?: string): Promise<void> {
        await this.loadStats();
        const keep = (f: string): ModelStats => ({ ...emptyStats(), benchmark: this.stats[f]?.benchmark });
        if (file) {
            this.stats[file] = keep(file);
        } else {
            for (const f of Object.keys(this.stats)) {
                this.stats[f] = keep(f);
            }
        }
        await this.flush();
    }
}

export function formatBytes(n: number): string {
    if (n >= 1024 ** 3) {
        return `${(n / 1024 ** 3).toFixed(2)} GB`;
    }
    if (n >= 1024 ** 2) {
        return `${Math.round(n / 1024 ** 2)} MB`;
    }
    return `${Math.round(n / 1024)} KB`;
}
