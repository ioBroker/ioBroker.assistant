/**
 * A static ffmpeg for hosts without one: the binaries of ffmpeg-static (github.com/eugeneware/ffmpeg-static),
 * downloaded on request ("Download ffmpeg" on the Voice tab) into the instance data dir.
 *
 * Deliberately not the npm package: its install script downloads 20-30 MB for every installation of the adapter,
 * also where nobody uses voice, and newer npm versions no longer run install scripts without asking - then the
 * binary is silently missing. The release and the SHA-256 of every file are pinned here, so a replaced file is
 * refused instead of executed.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import type { VoiceLogger } from './download';

/** The ffmpeg-static release. The binaries are newer than its name (Linux arm64: ffmpeg 7.0.2). */
export const FFMPEG_STATIC_RELEASE = 'b6.1.1';

const BASE_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_STATIC_RELEASE}`;

/** SHA-256 of the gzipped binaries, as GitHub reports them for the release. Key = `<platform>-<arch>` of Node. */
const ASSETS: Record<string, string> = {
    'darwin-arm64': '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
    'darwin-x64': '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
    'linux-arm': '64b115a12f0ab77c277e3c418aae8b40ef881e75e746a0e2d066a206b9bc5172',
    'linux-arm64': '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0',
    'linux-ia32': '169b27c078a8ecedb814cac67afccf15a9868d63e9d74ef86088adefaa500d00',
    'linux-x64': 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
    'win32-x64': '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
};

/** A file of the release: its name and the SHA-256 of the gzipped content. */
export interface FfmpegAsset {
    name: string;
    sha256: string;
}

/**
 * The file for this machine, or `null` if ffmpeg-static has none (e.g. Windows on ARM, FreeBSD).
 *
 * @param platform Node's `process.platform`
 * @param arch Node's `process.arch`
 */
export function ffmpegStaticAsset(
    platform: string = process.platform,
    arch: string = process.arch,
): FfmpegAsset | null {
    const key = `${platform}-${arch}`;
    return ASSETS[key] ? { name: `ffmpeg-${key}.gz`, sha256: ASSETS[key] } : null;
}

/**
 * Where the downloaded binary lives.
 *
 * @param dataDir the instance data dir
 * @param platform Node's `process.platform`
 */
export function ffmpegStaticPath(dataDir: string, platform: string = process.platform): string {
    return path.join(dataDir, 'ffmpeg', platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

/** Options of {@link downloadFfmpegStatic} - besides the logger only for tests. */
export interface FfmpegDownloadOptions {
    log?: VoiceLogger;
    /** Release URL without the file name */
    baseUrl?: string;
    /** Instead of the file for this machine */
    asset?: FfmpegAsset | null;
    platform?: string;
    timeoutMs?: number;
}

/**
 * Download, check and unpack the static ffmpeg into `<dataDir>/ffmpeg/`. Replaces an older download.
 *
 * @param dataDir the instance data dir
 * @param options logger; the rest is for tests
 * @returns the path of the binary
 */
export async function downloadFfmpegStatic(dataDir: string, options: FfmpegDownloadOptions = {}): Promise<string> {
    const platform = options.platform ?? process.platform;
    const asset = options.asset === undefined ? ffmpegStaticAsset(platform) : options.asset;
    if (!asset) {
        throw new Error(
            `there is no ffmpeg download for ${process.platform}-${process.arch} - install ffmpeg yourself and enter its path`,
        );
    }
    const url = `${options.baseUrl ?? BASE_URL}/${asset.name}`;
    const dest = ffmpegStaticPath(dataDir, platform);
    const tmp = `${dest}.part`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    const res = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 10 * 60_000) });
    if (!res.ok || !res.body) {
        throw new Error(`download of ${url} failed: HTTP ${res.status}`);
    }
    const size = Number(res.headers.get('content-length')) || 0;
    options.log?.info(`Downloading ffmpeg (${asset.name}${size ? `, ${(size / 1e6).toFixed(1)} MB` : ''}) …`);

    // The hash is taken over the gzipped bytes - that is what GitHub publishes.
    const hash = createHash('sha256');
    const tap = new Transform({
        transform(chunk: Buffer, _encoding, done): void {
            hash.update(chunk);
            done(null, chunk);
        },
    });
    try {
        await pipeline(
            Readable.fromWeb(res.body as WebReadableStream),
            tap,
            createGunzip(),
            fs.createWriteStream(tmp, { mode: 0o755 }),
        );
        const actual = hash.digest('hex');
        if (actual !== asset.sha256) {
            throw new Error(`${asset.name} has the wrong checksum (${actual}) - not used`);
        }
        if (platform !== 'win32') {
            fs.chmodSync(tmp, 0o755);
        }
        fs.rmSync(dest, { force: true });
        fs.renameSync(tmp, dest);
    } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
    }
    options.log?.info(`ffmpeg saved to ${dest}`);
    return dest;
}
