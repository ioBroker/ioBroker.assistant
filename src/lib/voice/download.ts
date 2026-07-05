/**
 * Small download + extract helpers for the local engines (Piper binary/voices, Vosk models).
 * Files land in the writable instance data dir so they survive adapter upgrades.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

export type VoiceLogger = Pick<ioBroker.Logger, 'info' | 'warn' | 'debug' | 'error'>;

/** Download a file to `dest` (skips if it already exists). */
export async function downloadFile(url: string, dest: string, log: VoiceLogger): Promise<void> {
    if (fs.existsSync(dest)) {
        return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    log.info(`Downloading ${path.basename(dest)} …`);
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`download ${url} failed: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // Write to a temp file first so an interrupted download does not leave a truncated "valid" file.
    const tmp = `${dest}.part`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
    log.info(`Saved ${path.basename(dest)} (${(buf.length / 1e6).toFixed(1)} MB).`);
}

/** Extract a `.tar.gz`/`.tgz` (via `tar`) or `.zip` (via `unzip`) into `destDir`. */
export function extractArchive(archive: string, destDir: string, log: VoiceLogger): Promise<void> {
    fs.mkdirSync(destDir, { recursive: true });
    const isZip = archive.endsWith('.zip');
    const cmd = isZip ? 'unzip' : 'tar';
    const args = isZip ? ['-o', archive, '-d', destDir] : ['-xzf', archive, '-C', destDir];
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args);
        child.stderr?.on('data', d => log.debug(`${cmd}: ${String(d).trim()}`));
        child.on('error', e => reject(new Error(`${cmd} failed: ${e.message} — is '${cmd}' installed?`)));
        child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
    });
}
