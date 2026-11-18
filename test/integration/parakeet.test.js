'use strict';
// ioBroker.voice (formerly ai-parakeet) as speech recognition (sendTo) and the installer behind "Install pi-agent" / "Install ioBroker.voice".
const test = require('node:test');
const assert = require('node:assert/strict');
const { ParakeetStt, renamedParakeetInstance } = require('../../build/lib/voice/parakeet.js');
const { createSttEngine, createTtsEngine } = require('../../build/lib/voice/engines.js');
const { AdapterInstaller } = require('../../build/lib/installer.js');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function ctx(over = {}) {
    return {
        creds: {
            openaiKey: '',
            azureKey: '',
            azureRegion: '',
            aws: { accessKeyId: '', secretAccessKey: '', region: '' },
        },
        voices: { openai: 'alloy', azure: '', aws: '', piper: '' },
        dataDir: require('node:os').tmpdir(),
        log: silentLog,
        voskModel: '',
        sttModel: '',
        ttsModel: '',
        ...over,
    };
}

test('parakeet: PCM goes as base64 with rate and the hints as prompt; the answer is the text', async () => {
    const sent = [];
    const stt = new ParakeetStt('voice.0', async (instance, command, message) => {
        sent.push({ instance, command, message });
        return { text: '  Schalte das Licht im Wohnzimmer ein. ', rawText: 'x', audioSeconds: 2 };
    });
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6]);
    const text = await stt.transcribe(pcm, 16000, 'de', ['Wohnzimmer', 'ioBroker', 'wohnzimmer']);
    assert.equal(text, 'Schalte das Licht im Wohnzimmer ein.');
    assert.deepEqual(sent, [
        {
            instance: 'voice.0',
            command: 'transcribe',
            message: { pcm: pcm.toString('base64'), sampleRate: 16000, prompt: 'Wohnzimmer, ioBroker', language: 'de' },
        },
    ]);

    // no hints → no prompt; the language goes along (Canary uses it, Parakeet ignores it), without the region
    await stt.transcribe(pcm, 22050, 'ru-RU');
    assert.deepEqual(sent[1].message, { pcm: pcm.toString('base64'), sampleRate: 22050, language: 'ru' });
    // no language → none sent
    await stt.transcribe(pcm, 16000, '');
    assert.deepEqual(sent[2].message, { pcm: pcm.toString('base64'), sampleRate: 16000 });
});

test('parakeet: an error of the adapter, no answer and empty text', async () => {
    const answer = { value: { error: 'The adapter is not ready' } };
    const stt = new ParakeetStt('voice.1', async () => answer.value);
    await assert.rejects(stt.transcribe(Buffer.alloc(4), 16000, 'de'), /voice\.1: The adapter is not ready/);
    answer.value = undefined;
    await assert.rejects(stt.transcribe(Buffer.alloc(4), 16000, 'de'), /gave no answer/);
    answer.value = { text: '' };
    assert.equal(await stt.transcribe(Buffer.alloc(4), 16000, 'de'), '');
    // a stopped instance: the sender rejects (main checks alive), the error goes on to the fallback engine
    const dead = new ParakeetStt('voice.0', () => Promise.reject(new Error('voice.0 is not running')));
    await assert.rejects(dead.transcribe(Buffer.alloc(4), 16000, 'de'), /not running/);
});

test('parakeet: factory', () => {
    const send = async () => ({ text: '' });
    assert.equal(
        createSttEngine('parakeet', ctx({ parakeetInstance: 'voice.0', sendMessage: send })).constructor.name,
        'ParakeetStt',
    );
    assert.throws(() => createSttEngine('parakeet', ctx({ sendMessage: send })), /needs an instance of ioBroker.voice/);
    assert.throws(() => createSttEngine('parakeet', ctx({ parakeetInstance: 'voice.0' })), /not available/);
    assert.throws(() => createTtsEngine('parakeet', ctx()), /not text-to-speech/);
    // as fallback behind a cloud engine
    const both = createSttEngine(
        'openai',
        ctx({
            creds: { ...ctx().creds, openaiKey: 'sk-x' },
            sttFallback: 'parakeet',
            parakeetInstance: 'voice.0',
            sendMessage: send,
        }),
    );
    assert.equal(both.constructor.name, 'FallbackStt');
});

/**
 * A fake ioBroker: objects + a host that runs `iobroker add|url` like js-controller's cmdExec — output and exit code as
 * messages back to the installer (cmdExit twice, as the host does).
 */
function fakeSystem({ repo = [], npm = [], objects = {}, host = 'pi', hang = false } = {}) {
    const objs = { ...objects };
    const commands = [];
    let installer = null;
    const reply = (id, lines, code) => {
        setImmediate(() => {
            for (const line of lines) {
                installer.handleMessage('cmdStdout', { id, data: line });
            }
            installer.handleMessage('cmdExit', { id, data: code });
            installer.handleMessage('cmdExit', { id, data: code });
        });
    };
    const addInstance = name => {
        let n = 0;
        while (objs[`system.adapter.${name}.${n}`]) {
            n++;
        }
        objs[`system.adapter.${name}.${n}`] = { type: 'instance', common: { enabled: true, host } };
    };
    const adapter = {
        log: silentLog,
        sendToHost(target, command, message) {
            assert.equal(command, 'cmdExec');
            commands.push(`${target}: ${message.data}`);
            if (hang) {
                return;
            }
            const [verb, arg] = message.data.split(' ');
            if (verb === 'add') {
                if (!objs[`system.adapter.${arg}`]) {
                    if (!repo.includes(arg)) {
                        return reply(
                            message.id,
                            [
                                `Unknown packet name ${arg}. Please install packages from outside the repository using "iobroker url <url-or-package>"!`,
                            ],
                            51,
                        );
                    }
                    objs[`system.adapter.${arg}`] = { type: 'adapter', common: {} };
                }
                addInstance(arg);
                return reply(message.id, [`host.${host} create instance ${arg}`], 0);
            }
            if (verb === 'url') {
                const name = arg.replace(/^iobroker\./, '');
                if (!npm.includes(name)) {
                    return reply(
                        message.id,
                        ['npm error code E404', `npm error 404 Not Found - GET https://registry.npmjs.org/${arg}`],
                        1,
                    );
                }
                objs[`system.adapter.${name}`] = { type: 'adapter', common: {} };
                return reply(message.id, ['changed 1 package'], 0);
            }
            reply(message.id, ['?'], 1);
        },
        async getForeignObjectAsync(id) {
            return objs[id] || null;
        },
        async getObjectViewAsync(design, search, { startkey, endkey }) {
            return {
                rows: Object.entries(objs)
                    .filter(([id, obj]) => obj.type === 'instance' && id >= startkey && id <= endkey)
                    .map(([id, value]) => ({ id, value })),
            };
        },
    };
    return {
        objs,
        commands,
        make(timeoutMs) {
            installer = new AdapterInstaller(adapter, host, timeoutMs);
            return installer;
        },
    };
}

test('installer: an existing instance is taken, nothing is installed — an enabled one on this host first', async () => {
    const sys = fakeSystem({
        objects: {
            'system.adapter.pi-agent': { type: 'adapter', common: {} },
            'system.adapter.pi-agent.0': { type: 'instance', common: { enabled: false, host: 'pi' } },
            'system.adapter.pi-agent.1': { type: 'instance', common: { enabled: true, host: 'other' } },
            'system.adapter.pi-agent.2': { type: 'instance', common: { enabled: true, host: 'pi' } },
            'system.adapter.pi-agent-x.0': { type: 'instance', common: { enabled: true, host: 'pi' } },
        },
    });
    const installer = sys.make();
    assert.deepEqual(await installer.ensure('pi-agent'), { instance: 'pi-agent.2', installed: false });
    assert.deepEqual(sys.commands, []);
});

test('installer: in the repository → one "add"', async () => {
    const sys = fakeSystem({ repo: ['pi-agent'] });
    const result = await sys.make().ensure('pi-agent');
    assert.deepEqual(result, { instance: 'pi-agent.0', installed: true });
    assert.deepEqual(sys.commands, ['pi: add pi-agent']);
});

test('installer: not in the repository → npm, then "add"', async () => {
    const sys = fakeSystem({ npm: ['pi-agent'] });
    const result = await sys.make().ensure('pi-agent');
    assert.deepEqual(result, { instance: 'pi-agent.0', installed: true });
    assert.deepEqual(sys.commands, ['pi: add pi-agent', 'pi: url iobroker.pi-agent', 'pi: add pi-agent']);
});

test('installer: installed without an instance → only "add"', async () => {
    const sys = fakeSystem({ repo: [], objects: { 'system.adapter.voice': { type: 'adapter', common: {} } } });
    assert.deepEqual(await sys.make().ensure('voice'), { instance: 'voice.0', installed: true });
    assert.deepEqual(sys.commands, ['pi: add voice']);
});

test('installer: neither in the repository nor on npm → an error that says both', async () => {
    const sys = fakeSystem();
    await assert.rejects(sys.make().ensure('voice'), err => {
        assert.match(err.message, /voice could not be installed/);
        assert.match(err.message, /repository \(exit code 51: Unknown packet name voice/);
        assert.match(err.message, /npm \(exit code 1: npm error 404 Not Found/);
        return true;
    });
    assert.equal(Object.keys(sys.objs).length, 0);
});

test('installer: one at a time; invalid names; a command that hangs times out', async () => {
    const sys = fakeSystem({ repo: ['pi-agent', 'voice'] });
    const installer = sys.make();
    const first = installer.ensure('pi-agent');
    await assert.rejects(installer.ensure('voice'), /pi-agent is being installed right now/);
    await first;
    assert.deepEqual(await installer.ensure('voice'), { instance: 'voice.0', installed: true });
    await assert.rejects(installer.ensure('pi-agent; rm -rf /'), /Invalid adapter name/);
    assert.equal(installer.handleMessage('cmdExit', { id: 'unknown', data: 0 }), true, 'a late second cmdExit');
    assert.equal(installer.handleMessage('ask', {}), false);

    // a command that hangs: no npm attempt while "add" may still run on the host
    const slow = fakeSystem({ hang: true });
    await assert.rejects(slow.make(50).ensure('pi-agent'), /iobroker add pi-agent still runs on pi after 1 min/);
    assert.deepEqual(slow.commands, ['pi: add pi-agent']);
});

test('parakeet: a saved ai-parakeet instance moves to voice with the same number', () => {
    assert.equal(renamedParakeetInstance('ai-parakeet.0'), 'voice.0');
    assert.equal(renamedParakeetInstance(' system.adapter.ai-parakeet.2 '), 'voice.2');
    assert.equal(renamedParakeetInstance('voice.0'), null);
    assert.equal(renamedParakeetInstance(''), null);
    assert.equal(renamedParakeetInstance('ai-parakeet.x'), null);
});
