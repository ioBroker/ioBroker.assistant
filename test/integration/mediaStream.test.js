// Music from a URL on an ESPHome media player: what a URL is (Content-Type, extension, playlists), direct or through
// ffmpeg, and the live streams of the media server.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const {
    kindFromContentType,
    kindFromUrl,
    parsePlaylist,
    probeStream,
    deviceCodecs,
    transcodeTarget,
    transcodeArgs,
    planStream,
} = require('../../build/lib/voice/mediaStream.js');
const { MediaServer } = require('../../build/lib/voice/mediaServer.js');
const { pcmToWav } = require('../../build/lib/voice/stt.js');

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, silly() {} };
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

const fmt = (format, sampleRate, channels, purpose) => ({ format, sampleRate, channels, purpose, sampleBytes: 2 });

test('the Content-Type names the codec; playlists and other audio are told apart', () => {
    assert.equal(kindFromContentType('audio/mpeg'), 'mp3');
    assert.equal(kindFromContentType('Audio/MPEG; charset=x'), 'mp3');
    assert.equal(kindFromContentType('audio/x-flac'), 'flac');
    assert.equal(kindFromContentType('audio/wav'), 'wav');
    assert.equal(kindFromContentType('audio/x-wav'), 'wav');
    assert.equal(kindFromContentType('audio/ogg; codecs=opus'), 'opus');
    assert.equal(kindFromContentType('audio/ogg'), 'other', 'plain Ogg is Vorbis, which ESPHome does not decode');
    assert.equal(kindFromContentType('audio/aacp'), 'other');
    assert.equal(kindFromContentType('audio/aac'), 'other');
    assert.equal(kindFromContentType('application/vnd.apple.mpegurl'), 'playlist');
    assert.equal(kindFromContentType('audio/x-mpegurl'), 'playlist');
    assert.equal(kindFromContentType('audio/x-scpls'), 'playlist');
    assert.equal(kindFromContentType('application/octet-stream'), 'unknown');
    assert.equal(kindFromContentType('text/html'), 'unknown');
    assert.equal(kindFromContentType(''), 'unknown');
});

test('the extension, when the Content-Type says nothing', () => {
    assert.equal(kindFromUrl('http://x/live.MP3?token=1'), 'mp3');
    assert.equal(kindFromUrl('https://x/a/b.flac'), 'flac');
    assert.equal(kindFromUrl('https://x/hls/index.m3u8'), 'hls');
    assert.equal(kindFromUrl('https://x/bob.pls'), 'playlist');
    assert.equal(kindFromUrl('https://x/bob.m3u'), 'playlist');
    assert.equal(kindFromUrl('https://x/stream.aac'), 'other');
    assert.equal(kindFromUrl('https://x/stream'), 'unknown');
    assert.equal(kindFromUrl('not a url'), 'unknown');
});

test('a playlist gives its first stream; HLS stays as it is', () => {
    const pls =
        '[playlist]\nNumberOfEntries=2\nFile1=http://stream.example/bob.mp3\nTitle1=Bob\nFile2=http://b/2.mp3\n';
    assert.deepEqual(parsePlaylist(pls, 'http://x/bob.pls'), { hls: false, url: 'http://stream.example/bob.mp3' });
    const m3u = '#EXTM3U\n#EXTINF:-1,Radio Bob\n\nhttps://stream.example/bob.aac\n';
    assert.deepEqual(parsePlaylist(m3u, 'http://x/bob.m3u'), { hls: false, url: 'https://stream.example/bob.aac' });
    assert.deepEqual(parsePlaylist('#EXTM3U\r\nlive/128.mp3\r\n', 'http://x/radio/list.m3u'), {
        hls: false,
        url: 'http://x/radio/live/128.mp3',
    });
    const hls = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=128000\nchunklist.m3u8\n';
    assert.deepEqual(parsePlaylist(hls, 'http://x/index.m3u8'), { hls: true, url: 'http://x/index.m3u8' });
    assert.deepEqual(parsePlaylist('#EXTM3U\nfile:///etc/passwd\n', 'http://x/a.m3u'), { hls: false, url: '' });
    assert.deepEqual(parsePlaylist('', 'http://x/a.m3u'), { hls: false, url: '' });
});

/** A web server with a radio station behind every kind of URL; live streams never end. */
async function radioServer(t) {
    const live = [];
    const stream = (res, type) => {
        res.writeHead(200, { 'Content-Type': type });
        const timer = setInterval(() => res.write(Buffer.alloc(1024, 0x55)), 20);
        live.push(timer);
        res.on('close', () => clearInterval(timer));
    };
    const server = http.createServer((req, res) => {
        const base = `http://127.0.0.1:${server.address().port}`;
        switch (req.url) {
            case '/live.mp3':
                return stream(res, 'audio/mpeg');
            case '/aac':
                return stream(res, 'audio/aacp');
            case '/octet':
                return stream(res, 'application/octet-stream');
            case '/bob.pls':
                res.writeHead(200, { 'Content-Type': 'audio/x-scpls' });
                return res.end(`[playlist]\nFile1=${base}/redirect\nTitle1=Bob\n`);
            case '/redirect':
                res.writeHead(302, { Location: '/live.mp3' });
                return res.end();
            case '/loop.m3u':
                res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
                return res.end(`#EXTM3U\n${base}/loop.m3u\n`);
            case '/hls/index.m3u8':
                res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
                return res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\nseg1.aac\n');
            case '/gone.mp3':
                res.writeHead(404);
                return res.end();
            default:
                res.writeHead(404);
                res.end();
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        live.forEach(clearInterval);
        server.closeAllConnections();
        server.close();
    });
    return `http://127.0.0.1:${server.address().port}`;
}

test('probe: live streams are left after their headers, playlists are followed', async t => {
    const base = await radioServer(t);
    const started = Date.now();
    assert.deepEqual(await probeStream(`${base}/live.mp3`), {
        url: `${base}/live.mp3`,
        kind: 'mp3',
        contentType: 'audio/mpeg',
    });
    assert.equal((await probeStream(`${base}/aac`)).kind, 'other');
    assert.equal((await probeStream(`${base}/octet`)).kind, 'unknown');
    assert.ok(Date.now() - started < 2000, 'a live stream must not be read to its (never coming) end');

    const pls = await probeStream(`${base}/bob.pls`);
    assert.equal(pls.kind, 'mp3', 'the playlist entry, behind a redirect');
    assert.equal(pls.url, `${base}/redirect`, 'the device gets the entry and follows the redirect itself');

    const hls = await probeStream(`${base}/hls/index.m3u8`);
    assert.deepEqual([hls.kind, hls.url], ['hls', `${base}/hls/index.m3u8`]);

    const loop = await probeStream(`${base}/loop.m3u`);
    assert.equal(loop.kind, 'playlist');
    assert.match(loop.error, /too deep/);

    const gone = await probeStream(`${base}/gone.mp3`);
    assert.deepEqual([gone.kind, gone.error], ['mp3', 'HTTP 404']);

    const dead = await probeStream('http://127.0.0.1:1/radio.mp3', { timeoutMs: 2000 });
    assert.equal(dead.kind, 'mp3', 'nothing to look at: the extension decides');
    assert.ok(dead.error);
});

test('the device decodes what it lists; nothing listed or NONE = MP3, FLAC and WAV', () => {
    assert.deepEqual([...deviceCodecs([])].sort(), ['flac', 'mp3', 'wav']);
    assert.deepEqual([...deviceCodecs([fmt('flac', 48000, 1, 'announcement')])], ['flac']);
    assert.deepEqual([...deviceCodecs([fmt('flac', 48000, 1, 'announcement'), fmt('none', 0, 0, 'default')])].sort(), [
        'flac',
        'mp3',
        'wav',
    ]);
    assert.deepEqual([...deviceCodecs([fmt('mp3', 0, 0, 'default'), fmt('opus', 48000, 1, 'announcement')])].sort(), [
        'mp3',
        'opus',
    ]);
});

test('transcoded as FLAC when possible, at the rate and channels the device asks for music', () => {
    assert.deepEqual(transcodeTarget([]), { codec: 'flac', sampleRate: 48000, channels: 1 });
    assert.deepEqual(transcodeTarget([fmt('flac', 48000, 1, 'announcement'), fmt('flac', 44100, 2, 'default')]), {
        codec: 'flac',
        sampleRate: 44100,
        channels: 2,
    });
    assert.deepEqual(transcodeTarget([fmt('mp3', 0, 0, 'default')]), { codec: 'mp3', sampleRate: 48000, channels: 1 });
    assert.deepEqual(transcodeTarget([fmt('opus', 44100, 1, 'default')]), {
        codec: 'opus',
        sampleRate: 48000,
        channels: 1,
    });
});

test('direct when the device decodes it, else through ffmpeg — unless there is none', () => {
    const classic = deviceCodecs([]);
    const probe = (kind, extra = {}) => ({ url: 'http://x/s', kind, contentType: '', ...extra });
    assert.equal(planStream(probe('mp3'), classic, false, true).mode, 'direct');
    assert.equal(planStream(probe('other'), classic, false, true).mode, 'transcode');
    assert.equal(planStream(probe('hls'), classic, false, true).mode, 'transcode');
    assert.equal(planStream(probe('unknown'), classic, false, true).mode, 'transcode');
    assert.equal(planStream(probe('mp3'), classic, true, true).mode, 'transcode', 'the transcode switch');
    assert.equal(
        planStream(probe('mp3'), deviceCodecs([fmt('flac', 48000, 1, 'announcement')]), false, true).mode,
        'transcode',
    );
    const noFfmpeg = planStream(probe('other'), classic, false, false);
    assert.equal(noFfmpeg.mode, 'direct');
    assert.match(noFfmpeg.reason, /ffmpeg is missing/);
    assert.match(
        planStream(probe('unknown', { error: 'timeout' }), classic, false, true).reason,
        /unknown format \(timeout\)/,
    );
});

test('ffmpeg arguments: reconnect for a radio, not for HLS; the codec and format of the target', () => {
    const radio = transcodeArgs('http://x/aac', { codec: 'flac', sampleRate: 48000, channels: 1 }, false);
    assert.ok(radio.includes('-reconnect_streamed'));
    assert.deepEqual(radio.slice(radio.indexOf('-i'), radio.indexOf('-i') + 2), ['-i', 'http://x/aac']);
    assert.deepEqual(radio.slice(-5), ['-c:a', 'flac', '-f', 'flac', '-']);
    assert.ok(radio.join(' ').includes('-ar 48000 -ac 1'));
    const hls = transcodeArgs('http://x/i.m3u8', { codec: 'mp3', sampleRate: 44100, channels: 2 }, true);
    assert.ok(!hls.includes('-reconnect'));
    assert.ok(hls.join(' ').includes('-c:a libmp3lame'));
});

test('media server: a live stream starts per listener and stops when the listener goes or the path is removed', async t => {
    const media = new MediaServer({ port: 0, log: silentLog });
    await media.start();
    t.after(() => media.stop());
    let started = 0;
    let stopped = 0;
    media.serveStream('/stream/abc.flac', 'audio/flac', res => {
        started++;
        const timer = setInterval(() => res.write(Buffer.from('fLaC')), 10);
        return () => {
            stopped++;
            clearInterval(timer);
        };
    });
    const url = `http://127.0.0.1:${media.port}/stream/abc.flac`;

    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.headers.get('content-type'), 'audio/flac');
    assert.equal(started, 0, 'HEAD does not start the source');

    // the listener goes away
    const controller = new AbortController();
    const res = await fetch(url, { signal: controller.signal });
    const reader = res.body.getReader();
    const { value } = await reader.read();
    assert.equal(Buffer.from(value).subarray(0, 4).toString(), 'fLaC');
    assert.equal(media.streamListeners, 1);
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual([started, stopped, media.streamListeners], [1, 1, 0]);

    // the path is removed while someone listens: cut off
    const second = await fetch(url);
    const r2 = second.body.getReader();
    await r2.read();
    media.unserve('/stream/abc.flac');
    await assert.rejects(
        (async () => {
            for (;;) {
                const { done } = await r2.read();
                if (done) {
                    throw new Error('ended');
                }
            }
        })(),
    );
    assert.deepEqual([started, stopped], [2, 2]);
    assert.equal((await fetch(url)).status, 404);
});

test(
    'ffmpeg turns a stream the device cannot decode into FLAC',
    { skip: !hasFfmpeg && 'ffmpeg not installed' },
    async t => {
        // the "station": one second of a 440 Hz tone as WAV at 22.05 kHz
        const rate = 22050;
        const pcm = Buffer.alloc(rate * 2);
        for (let i = 0; i < rate; i++) {
            pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
        }
        const station = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'audio/wav' });
            res.end(pcmToWav(pcm, rate));
        });
        await new Promise(resolve => station.listen(0, '127.0.0.1', resolve));
        const media = new MediaServer({ port: 0, log: silentLog });
        await media.start();
        t.after(async () => {
            await media.stop();
            station.close();
        });
        const target = { codec: 'flac', sampleRate: 48000, channels: 1 };
        const source = `http://127.0.0.1:${station.address().port}/tone.wav`;
        media.serveStream('/stream/t.flac', 'audio/flac', res => {
            const proc = spawn('ffmpeg', transcodeArgs(source, target, false), { stdio: ['ignore', 'pipe', 'ignore'] });
            proc.stdout.pipe(res);
            return () => proc.kill();
        });
        const body = Buffer.from(await (await fetch(`http://127.0.0.1:${media.port}/stream/t.flac`)).arrayBuffer());
        assert.equal(body.subarray(0, 4).toString(), 'fLaC');
        // decode it again: 48 kHz mono, about one second
        const back = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-'], {
            input: body,
        });
        assert.equal(back.status, 0);
        const seconds = back.stdout.length / 2 / 48000;
        assert.ok(Math.abs(seconds - 1) < 0.05, `about one second at 48 kHz, got ${seconds}`);
    },
);
