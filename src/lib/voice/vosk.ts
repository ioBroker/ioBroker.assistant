/**
 * Local STT via Vosk (https://alphacephei.com/vosk). The `vosk` npm module (prebuilt native binary) is
 * installed on demand into the instance data dir (like the local LLM), and a small language model is
 * downloaded + unzipped there. Input is 16 kHz mono 16-bit PCM — exactly what satellites stream.
 *
 * ⚠️ On-demand install + model download need `npm` and `unzip` on the host — validate on the device.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { downloadFile, extractArchive, type VoiceLogger } from './download';
import type { SttEngine } from './stt';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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

function moduleInstalled(dataDir: string): boolean {
    return fs.existsSync(path.join(dataDir, 'node_modules', 'vosk', 'package.json'));
}

/** Install the `vosk` npm module into the data dir via a spawned `npm install`. */
function installVosk(dataDir: string, log: VoiceLogger): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(dataDir, { recursive: true });
        const pkg = path.join(dataDir, 'package.json');
        if (!fs.existsSync(pkg)) {
            fs.writeFileSync(pkg, JSON.stringify({ name: 'assistant-local-voice', private: true, version: '1.0.0' }));
        }
        log.info('Installing vosk (first use) — this can take a minute …');
        const child = spawn(NPM, ['install', 'vosk', '--omit=dev', '--no-audit', '--no-fund'], {
            cwd: dataDir,
            shell: process.platform === 'win32',
        });
        child.stdout.on('data', d => log.debug(`npm: ${String(d).trim()}`));
        child.stderr.on('data', d => log.debug(`npm: ${String(d).trim()}`));
        child.on('error', reject);
        child.on('close', code => (code === 0 ? resolve() : reject(new Error(`npm install vosk exited ${code}`))));
    });
}

export class VoskStt implements SttEngine {
    private vosk: any = null;
    private ready: Promise<void> | null = null;
    private readonly models = new Map<string, any>(); // iso → loaded vosk.Model

    constructor(
        private readonly dataDir: string,
        /** Override model name/dir; '' → default per language. */
        private readonly modelOverride: string,
        private readonly log: VoiceLogger,
    ) {}

    private ensureModule(): Promise<void> {
        if (!this.ready) {
            this.ready = this.loadModule().catch(e => {
                this.ready = null;
                throw e;
            });
        }
        return this.ready;
    }

    private async loadModule(): Promise<void> {
        if (!moduleInstalled(this.dataDir)) {
            await installVosk(this.dataDir, this.log);
        }
        const req = createRequire(path.join(this.dataDir, 'package.json'));
        this.vosk = req('vosk');
        this.vosk.setLogLevel?.(-1); // silence vosk's own logging
        this.log.info('Vosk loaded.');
    }

    private async ensureModel(lang: string): Promise<any> {
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
        const model = new this.vosk.Model(modelDir);
        this.models.set(iso, model);
        return model;
    }

    async transcribe(pcm: Buffer, sampleRate: number, lang: string): Promise<string> {
        await this.ensureModule();
        const model = await this.ensureModel(lang);
        const rec = new this.vosk.Recognizer({ model, sampleRate });
        try {
            rec.acceptWaveform(pcm);
            const res = rec.finalResult() as { text?: string };
            return (res?.text || '').trim();
        } finally {
            rec.free?.();
        }
    }
}
