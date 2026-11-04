'use strict';
// Integration test: "Download ffmpeg" - the static ffmpeg of ffmpeg-static, checked against the pinned SHA-256.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {
    FFMPEG_STATIC_RELEASE,
    downloadFfmpegStatic,
    ffmpegStaticAsset,
    ffmpegStaticPath,
} = require('../../build/lib/voice/ffmpegStatic.js');

const BINARY = Buffer.from('#!/bin/sh\necho "ffmpeg version 6.1.1-static"\n'.repeat(2000));
const GZ = zlib.gzipSync(BINARY);
const SHA = crypto.createHash('sha256').update(GZ).digest('hex');

/** Serves `/<name>` with the gzipped fake binary, everything else with 404. */
async function server(name) {
    const srv = http.createServer((req, res) => {
        if (req.url === `/${name}`) {
            res.writeHead(200, { 'content-length': GZ.length });
            res.end(GZ);
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise(r => srv.close(r)) };
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-static-'));

test('the file for each platform of ffmpeg-static, none elsewhere', () => {
    assert.equal(FFMPEG_STATIC_RELEASE, 'b6.1.1');
    assert.equal(ffmpegStaticAsset('linux', 'arm64').name, 'ffmpeg-linux-arm64.gz');
    assert.equal(ffmpegStaticAsset('linux', 'arm').name, 'ffmpeg-linux-arm.gz');
    assert.equal(ffmpegStaticAsset('win32', 'x64').name, 'ffmpeg-win32-x64.gz');
    assert.match(ffmpegStaticAsset('darwin', 'arm64').sha256, /^[0-9a-f]{64}$/);
    assert.equal(ffmpegStaticAsset('win32', 'arm64'), null);
    assert.equal(ffmpegStaticAsset('freebsd', 'x64'), null);
    assert.equal(path.basename(ffmpegStaticPath('/data', 'win32')), 'ffmpeg.exe');
    assert.equal(path.basename(ffmpegStaticPath('/data', 'linux')), 'ffmpeg');
});

test('downloads, checks and unpacks the binary', async () => {
    const dir = tmpDir();
    const srv = await server('ffmpeg-linux-x64.gz');
    try {
        const logs = [];
        const log = { info: m => logs.push(m), warn: m => logs.push(m), debug: () => {}, error: m => logs.push(m) };
        const file = await downloadFfmpegStatic(dir, {
            baseUrl: srv.url,
            asset: { name: 'ffmpeg-linux-x64.gz', sha256: SHA },
            platform: 'linux',
            log,
        });
        assert.equal(file, ffmpegStaticPath(dir, 'linux'));
        assert.deepEqual(fs.readFileSync(file), BINARY);
        if (process.platform !== 'win32') {
            assert.equal(fs.statSync(file).mode & 0o111, 0o111, 'executable');
        }
        assert.ok(!fs.existsSync(`${file}.part`));
        assert.ok(
            logs.some(l => /Downloading ffmpeg \(ffmpeg-linux-x64\.gz, [\d.]+ MB\)/.test(l)),
            logs.join('\n'),
        );

        // a second download replaces the first
        fs.writeFileSync(file, 'old');
        await downloadFfmpegStatic(dir, {
            baseUrl: srv.url,
            asset: { name: 'ffmpeg-linux-x64.gz', sha256: SHA },
            platform: 'linux',
        });
        assert.deepEqual(fs.readFileSync(file), BINARY);
    } finally {
        await srv.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a file with the wrong checksum is refused and nothing stays behind', async () => {
    const dir = tmpDir();
    const srv = await server('ffmpeg-linux-x64.gz');
    try {
        await assert.rejects(
            downloadFfmpegStatic(dir, {
                baseUrl: srv.url,
                asset: { name: 'ffmpeg-linux-x64.gz', sha256: '0'.repeat(64) },
                platform: 'linux',
            }),
            /wrong checksum/,
        );
        const file = ffmpegStaticPath(dir, 'linux');
        assert.ok(!fs.existsSync(file));
        assert.ok(!fs.existsSync(`${file}.part`));
    } finally {
        await srv.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('HTTP errors and unsupported platforms are reported', async () => {
    const dir = tmpDir();
    const srv = await server('ffmpeg-linux-x64.gz');
    try {
        await assert.rejects(
            downloadFfmpegStatic(dir, {
                baseUrl: srv.url,
                asset: { name: 'missing.gz', sha256: SHA },
                platform: 'linux',
            }),
            /HTTP 404/,
        );
        await assert.rejects(downloadFfmpegStatic(dir, { asset: null }), /no ffmpeg download for/);
    } finally {
        await srv.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
