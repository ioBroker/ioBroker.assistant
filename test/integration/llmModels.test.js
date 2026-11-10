'use strict';
// Integration test: model manager of the local LLM (directory, downloads, statistics) and its benchmark.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {
    ModelManager,
    MODEL_PRESETS,
    normalizeModelUrl,
    modelFileName,
    summarizeStats,
} = require('../../build/lib/llmModels.js');
const { benchmarkCases, runBenchmark } = require('../../build/lib/llmBenchmark.js');

const log = { info() {}, warn() {}, debug() {} };

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'llm-models-'));
}

/** HTTP server: /model.gguf (valid), /page.gguf (HTML), /slow.gguf (never ends), /huge.gguf (HEAD 1 PB). */
function startServer() {
    const gguf = Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(200_000, 7)]);
    const server = http.createServer((req, res) => {
        if (req.url === '/model.gguf') {
            res.writeHead(200, { 'Content-Length': gguf.length });
            return req.method === 'HEAD' ? res.end() : res.end(gguf);
        }
        if (req.url === '/page.gguf') {
            const html = Buffer.from('<html>not found</html>');
            res.writeHead(200, { 'Content-Length': html.length });
            return req.method === 'HEAD' ? res.end() : res.end(html);
        }
        if (req.url === '/slow.gguf') {
            res.writeHead(200, { 'Content-Length': 10_000_000 });
            if (req.method === 'HEAD') {
                return res.end();
            }
            res.write(Buffer.from('GGUF'));
            return; // never ends
        }
        if (req.url === '/huge.gguf') {
            res.writeHead(200, { 'Content-Length': String(10 ** 15) });
            return res.end();
        }
        res.writeHead(404);
        res.end();
    });
    return new Promise(resolve =>
        server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })),
    );
}

function waitDone(manager, dir, url) {
    return new Promise((resolve, reject) => {
        manager.startDownload(url, dir, (file, error) => (error ? reject(error) : resolve(file))).catch(reject);
    });
}

test('links: hf: shorthand, /blob/ pages and file names', () => {
    assert.equal(
        normalizeModelUrl('hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF/qwen2.5-0.5b-instruct-q4_k_m.gguf'),
        'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf',
    );
    assert.equal(
        normalizeModelUrl('https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/blob/main/Qwen3-0.6B-Q4_K_M.gguf'),
        'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf',
    );
    assert.equal(normalizeModelUrl('/etc/passwd'), '');
    assert.equal(modelFileName('https://x/y/Model-Q4.gguf?download=true'), 'Model-Q4.gguf');
    assert.equal(modelFileName('https://x/y/readme.md'), '');
});

test('presets: unique ids and files, every one a Hugging Face .gguf link with size and texts', () => {
    assert.equal(new Set(MODEL_PRESETS.map(p => p.id)).size, MODEL_PRESETS.length);
    assert.equal(new Set(MODEL_PRESETS.map(p => p.file)).size, MODEL_PRESETS.length);
    for (const p of MODEL_PRESETS) {
        assert.match(p.url, /^https:\/\/huggingface\.co\/.+\/resolve\/main\/.+\.gguf$/, p.id);
        assert.equal(modelFileName(p.url), p.file, p.id);
        assert.ok(p.sizeBytes > 100_000_000, p.id);
        for (const lang of ['en', 'de', 'ru']) {
            assert.ok(p.description[lang], `${p.id} ${lang}`);
        }
    }
});

test('directory: default under the data dir, relative paths refused', () => {
    const data = tmpDir();
    const m = new ModelManager(data, log);
    assert.equal(m.resolveDir(''), path.join(data, 'models'));
    assert.equal(m.resolveDir('/mnt/ssd/llm'), path.resolve('/mnt/ssd/llm'));
    assert.throws(() => m.resolveDir('models'), /absolute/);
    assert.throws(() => m.modelPath(data, '../evil.gguf'), /invalid/);
    assert.throws(() => m.modelPath(data, 'notes.txt'), /invalid/);
});

test('download: progress, .part renamed only after the GGUF check, listed with size and source', async () => {
    const { server, base } = await startServer();
    try {
        const data = tmpDir();
        const dir = path.join(data, 'models');
        const m = new ModelManager(data, log);
        const file = await waitDone(m, dir, `${base}/model.gguf`);
        assert.equal(file, 'model.gguf');
        assert.ok(!fs.existsSync(path.join(dir, 'model.gguf.part')));
        const list = await m.list(dir);
        assert.equal(list.length, 1);
        assert.equal(list[0].sizeBytes, 200_004);
        assert.equal(list[0].url, `${base}/model.gguf`);
        assert.ok(list[0].addedAt > 0);
        // second time: already there
        await assert.rejects(m.startDownload(`${base}/model.gguf`, dir), /already in/);
        const disk = await m.disk(dir);
        assert.ok(disk && disk.free > 0 && disk.total >= disk.free);
    } finally {
        server.close();
    }
});

test('download: an HTML page is not a model, a too large file is refused before downloading', async () => {
    const { server, base } = await startServer();
    try {
        const data = tmpDir();
        const dir = path.join(data, 'models');
        const m = new ModelManager(data, log);
        await assert.rejects(waitDone(m, dir, `${base}/page.gguf`), /not a GGUF/);
        assert.deepEqual(
            fs.readdirSync(dir).filter(f => f.endsWith('.gguf') || f.endsWith('.part')),
            [],
        );
        assert.equal(m.listDownloads()[0].error.includes('not a GGUF'), true);
        await assert.rejects(m.startDownload(`${base}/huge.gguf`, dir), /not enough free space/);
        await assert.rejects(m.startDownload(`${base}/missing.gguf`, dir), /HTTP 404/);
        await assert.rejects(m.startDownload(`${base}/readme.md`, dir), /\.gguf/);
    } finally {
        server.close();
    }
});

test('download: cancel removes the .part file', async () => {
    const { server, base } = await startServer();
    try {
        const data = tmpDir();
        const dir = path.join(data, 'models');
        const m = new ModelManager(data, log);
        const done = waitDone(m, dir, `${base}/slow.gguf`);
        await new Promise(r => setTimeout(r, 200));
        assert.equal(m.isDownloading('slow.gguf'), true);
        await assert.rejects(m.startDownload(`${base}/slow.gguf`, dir), /already downloading/);
        assert.equal(m.cancelDownload('slow.gguf'), true);
        await assert.rejects(done, /cancelled/);
        assert.equal(fs.existsSync(path.join(dir, 'slow.gguf.part')), false);
        assert.equal(m.isDownloading('slow.gguf'), false);
    } finally {
        server.closeAllConnections();
        server.close();
    }
});

test('delete: never the active model, other files are removed with their source entry', async () => {
    const data = tmpDir();
    const dir = path.join(data, 'models');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.gguf'), 'GGUFaaaa');
    fs.writeFileSync(path.join(dir, 'b.gguf'), 'GGUFbb');
    const m = new ModelManager(data, log);
    await m.rememberSource(dir, 'b.gguf', 'https://example.com/b.gguf');
    await assert.rejects(m.delete(dir, 'a.gguf', 'a.gguf'), /active model/);
    await m.delete(dir, 'b.gguf', 'a.gguf');
    assert.deepEqual(
        (await m.list(dir)).map(x => x.file),
        ['a.gguf'],
    );
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'));
    assert.equal(meta['b.gguf'], undefined);
});

test('statistics: averages, failure rate, persistence, reset keeps the benchmark', async () => {
    const data = tmpDir();
    const m = new ModelManager(data, log);
    await m.recordRun('x.gguf', { outcome: 'answered', ms: 4000, tokens: 40, genMs: 2000, firstTokenMs: 1500 });
    await m.recordRun('x.gguf', { outcome: 'answered', ms: 2000, tokens: 20, genMs: 1000, firstTokenMs: 500 });
    await m.recordRun('x.gguf', { outcome: 'handoff', ms: 800, tokens: 2, genMs: 0, firstTokenMs: 700 });
    await m.recordRun('x.gguf', { outcome: 'timeout', ms: 15000 });
    await m.recordRun('x.gguf', { outcome: 'busy', ms: 0 });
    await m.recordLoad('x.gguf', 3210);
    await m.recordBenchmark('x.gguf', { at: 1, cases: 2, correct: 1 });
    await m.flush();

    const again = new ModelManager(data, log);
    const s = await again.getStats('x.gguf');
    assert.equal(s.asked, 5);
    assert.equal(s.answered, 2);
    assert.equal(s.handoffs, 1);
    assert.equal(s.timeouts, 1);
    assert.equal(s.busy, 1);
    assert.equal(s.tokensPerSec, 20); // 60 tokens in 3 s
    assert.equal(s.avgFirstTokenMs, 900);
    assert.equal(s.avgAnswerMs, 3000);
    assert.equal(s.failureRate, 0.25); // 1 timeout of 4 handled (busy not counted)
    assert.equal(s.lastLoadMs, 3210);

    await again.resetStats('x.gguf');
    const r = await again.getStats('x.gguf');
    assert.equal(r.asked, 0);
    assert.equal(r.benchmark.correct, 1);
    assert.equal(summarizeStats(undefined).failureRate, null);
});

test('benchmark: cases for the language plus English, scoring of hand-offs and facts', async () => {
    const ru = benchmarkCases('ru');
    assert.deepEqual([...new Set(ru.map(c => c.lang))], ['ru', 'en']);
    assert.deepEqual([...new Set(benchmarkCases('fr').map(c => c.lang))], ['en']);
    const en = benchmarkCases('en');
    assert.equal(en.length, 6);

    // A model that hands off everything: home questions right, facts needlessly handed off.
    let r = await runBenchmark(en, async () => ({
        answer: 'HANDOFF',
        ms: 100,
        tokens: 2,
        genMs: 50,
        firstTokenMs: 40,
    }));
    assert.equal(r.correct, 3);
    assert.equal(r.needlessHandoffs, 3);

    // A model that answers everything with the facts: facts right, home questions missed.
    const facts = { 'How many days does a leap year have?': '366 days.', 'What is the capital of France?': 'Paris.' };
    r = await runBenchmark(en, async q => {
        if (q.startsWith('What is 7')) {
            throw new Error('timed out after 15 s');
        }
        return { answer: facts[q] || 'Sure, the light is on now.', ms: 1000, tokens: 10, genMs: 500 };
    });
    assert.equal(r.missedHandoffs, 3);
    assert.equal(r.correct, 2);
    assert.equal(r.timeouts, 1);
    assert.equal(r.tokensPerSec, 20);
    assert.equal(r.details.length, 6);
});
