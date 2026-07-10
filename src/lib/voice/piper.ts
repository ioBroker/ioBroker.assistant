/**
 * Local TTS via Piper (https://github.com/rhasspy/piper). The binary + a voice model are downloaded
 * into the instance data dir on first use, then `piper --output_raw` is spawned to synthesise 16-bit
 * PCM. No cloud, no API key.
 *
 * ⚠️ Binary/voice download + spawn are platform-specific — validate on the target device.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { downloadFile, extractArchive, type VoiceLogger } from './download';
import type { TtsEngine, TtsResult } from './tts';

const PIPER_RELEASE = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2';

/** Release asset for the current platform/arch. */
function piperAsset(): string {
    const p = process.platform;
    const a = process.arch;
    if (p === 'linux') {
        if (a === 'arm64') {
            return 'piper_linux_aarch64.tar.gz';
        }
        if (a === 'arm') {
            return 'piper_linux_armv7l.tar.gz';
        }
        return 'piper_linux_x86_64.tar.gz';
    }
    if (p === 'darwin') {
        return a === 'arm64' ? 'piper_macos_aarch64.tar.gz' : 'piper_macos_x64.tar.gz';
    }
    if (p === 'win32') {
        return 'piper_windows_amd64.zip';
    }
    throw new Error(`Piper: unsupported platform ${p}/${a}`);
}

/** Reasonable default Piper voice per language (rhasspy/piper-voices). */
const DEFAULT_VOICE: Record<string, string> = {
    de: 'de_DE-thorsten-medium',
    en: 'en_US-lessac-medium',
    ru: 'ru_RU-irina-medium',
    fr: 'fr_FR-siwis-medium',
    it: 'it_IT-riccardo-x_low',
    es: 'es_ES-sharvard-medium',
    nl: 'nl_NL-mls-medium',
    pl: 'pl_PL-darkman-medium',
    pt: 'pt_PT-tugão-medium',
    uk: 'uk_UA-ukrainian_tts-medium',
    zh: 'zh_CN-huayan-medium',
};

/** Build the two voice-file URLs (.onnx + .onnx.json) from a voice name like `de_DE-thorsten-medium`. */
function voiceUrls(voice: string): { onnx: string; json: string } {
    // name = <locale>-<speaker>-<quality>; path = <lang>/<locale>/<speaker>/<quality>/<name>.onnx
    const [locale, speaker, quality] = voice.split('-');
    const lang = locale.split('_')[0].toLowerCase();
    const base = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang}/${locale}/${speaker}/${quality}/${voice}`;
    return { onnx: `${base}.onnx`, json: `${base}.onnx.json` };
}

export class PiperTts implements TtsEngine {
    private binaryPath = '';
    private ready: Promise<void> | null = null;

    constructor(
        private readonly dataDir: string,
        /** Voice name (e.g. de_DE-thorsten-medium); '' → default per language. */
        private readonly voice: string,
        private readonly log: VoiceLogger,
    ) {}

    /** Download + unpack the binary once; concurrent calls share one init. */
    private ensure(): Promise<void> {
        if (!this.ready) {
            this.ready = this.doEnsure().catch(e => {
                this.ready = null; // allow a retry on the next call
                throw e;
            });
        }
        return this.ready;
    }

    private async doEnsure(): Promise<void> {
        // 1. binary
        const piperDir = path.join(this.dataDir, 'piper');
        const exe = path.join(piperDir, 'piper', process.platform === 'win32' ? 'piper.exe' : 'piper');
        if (!fs.existsSync(exe)) {
            const asset = piperAsset();
            const archive = path.join(piperDir, asset);
            await downloadFile(`${PIPER_RELEASE}/${asset}`, archive, this.log);
            await extractArchive(archive, piperDir, this.log);
            if (process.platform !== 'win32') {
                try {
                    fs.chmodSync(exe, 0o755);
                } catch {
                    /* best effort */
                }
            }
        }
        this.binaryPath = exe;
    }

    private voiceFor(lang: string): string {
        const iso = (lang || 'en').split('-')[0].toLowerCase();
        return this.voice || DEFAULT_VOICE[iso] || DEFAULT_VOICE.en;
    }

    private async ensureVoice(voice: string): Promise<{ onnx: string; sampleRate: number }> {
        const dir = path.join(this.dataDir, 'piper-voices');
        const onnx = path.join(dir, `${voice}.onnx`);
        const json = path.join(dir, `${voice}.onnx.json`);
        const urls = voiceUrls(voice);
        await downloadFile(urls.onnx, onnx, this.log);
        await downloadFile(urls.json, json, this.log);
        let sampleRate = 22050;
        try {
            const cfg = JSON.parse(fs.readFileSync(json, 'utf8')) as { audio?: { sample_rate?: number } };
            sampleRate = cfg.audio?.sample_rate || 22050;
        } catch {
            /* keep default */
        }
        return { onnx, sampleRate };
    }

    /** Warm-up: download the Piper binary + the voice for `lang` so the first command isn't slow. */
    async prepare(lang: string): Promise<void> {
        await this.ensure();
        await this.ensureVoice(this.voiceFor(lang));
    }

    async synthesize(text: string, lang: string): Promise<TtsResult> {
        await this.ensure();
        const voice = this.voiceFor(lang);
        const { onnx, sampleRate } = await this.ensureVoice(voice);

        return new Promise<TtsResult>((resolve, reject) => {
            const child = spawn(this.binaryPath, ['--model', onnx, '--output_raw'], {
                cwd: path.dirname(this.binaryPath), // finds bundled espeak-ng-data / libs
            });
            const chunks: Buffer[] = [];
            child.stdout.on('data', (d: Buffer) => chunks.push(d));
            child.stderr.on('data', (d: Buffer) => this.log.debug(`piper: ${String(d).trim()}`));
            child.on('error', e => reject(new Error(`piper failed: ${e.message}`)));
            child.on('close', code => {
                if (code === 0) {
                    resolve({ pcm: Buffer.concat(chunks), sampleRate });
                } else {
                    reject(new Error(`piper exited with code ${code}`));
                }
            });
            child.stdin.end(text);
        });
    }
}

/** Voices offered in the settings dropdown for Piper (the built-in per-language defaults). */
export function listPiperVoices(): string[] {
    return Object.values(DEFAULT_VOICE);
}
