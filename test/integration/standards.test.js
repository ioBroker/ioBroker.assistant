'use strict';
// Integration test: the shared commands of other adapters (HELP.md) — the `help` answers, the registry against fake
// instances, the shapes of lists, errors and pictures — and the quick-command parsers of src/lib/quick.ts.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseHelpCommands,
    StandardRegistry,
    standardError,
    listOf,
    pictureOf,
    redactPictures,
    compareInstances,
} = require('../../build/lib/standards');
const {
    parseCallCommand,
    parseShowOnCommand,
    parsePictureCommand,
    showTarget,
    nameFits,
    pickNamed,
    quickReply,
} = require('../../build/lib/quick');

// ── help answers ──────────────────────────────────────────────────────────

test('parseHelpCommands: the full name as the command, when the short one is taken (rule 1)', () => {
    const list = parseHelpCommands('telegram.0', {
        help: '',
        commands: [
            { command: 'send', write: true },
            { command: 'message.send', write: true, standard: 'message.send' },
        ],
    });
    assert.deepEqual(
        list.map(c => [c.command, c.standard]),
        [['message.send', 'message.send']],
    );
});

test('parseHelpCommands keeps only commands with a valid standard', () => {
    const answer = {
        help: 'text',
        commands: [
            { command: 'help', write: false },
            { command: 'getSnapshot', write: false, standard: 'camera.snapshot' },
            { command: 'list', write: false, standard: 'camera.getCameras' },
            { command: 'bad', write: true, standard: 'Camera.Snapshot' },
            { command: 'send', write: true, standard: ['message.send', 'speech.speak'] },
            { command: '', write: true, standard: 'message.ask' },
            { command: 'again', write: false, standard: 'camera.snapshot' },
        ],
    };
    const cmds = parseHelpCommands('frigate.0', answer);
    assert.deepEqual(
        cmds.map(c => `${c.command}=${c.standard}${c.write ? '!' : ''}`),
        ['getSnapshot=camera.snapshot', 'list=camera.getCameras', 'send=message.send!', 'send=speech.speak!'],
    );
    assert.equal(cmds[0].adapter, 'frigate');
    assert.equal(cmds[0].instance, 'frigate.0');
    assert.deepEqual(parseHelpCommands('x.0', null), []);
    assert.deepEqual(parseHelpCommands('x.0', { help: 'only text' }), []);
});

function fakeHost(instances) {
    const asked = [];
    return {
        asked,
        host: {
            namespace: 'assistant.0',
            getObjectViewAsync: async () => ({
                rows: Object.entries(instances).map(([id, i]) => ({
                    id: `system.adapter.${id}`,
                    value: {
                        common: {
                            version: i.version || '1.0.0',
                            supportedMessages: i.help === false ? {} : { help: true },
                        },
                    },
                })),
            }),
            getForeignStateAsync: async id => {
                const inst = id.replace(/^system\.adapter\./, '').replace(/\.alive$/, '');
                return { val: instances[inst]?.alive !== false };
            },
            sendToAsync: async (instance, command) => {
                asked.push(`${instance}:${command}`);
                const i = instances[instance];
                if (i.fail) {
                    throw new Error('timeout');
                }
                return { help: 'x', commands: i.commands };
            },
            log: { debug() {}, info() {} },
        },
    };
}

test('StandardRegistry asks running instances with help, not itself, and sorts them', async () => {
    const { host, asked } = fakeHost({
        'cameras.0': { commands: [{ command: 'image', write: false, standard: 'camera.snapshot' }] },
        'frigate.0': { commands: [{ command: 'snapshot', write: false, standard: 'camera.snapshot' }] },
        'frigate.1': { alive: false, commands: [{ command: 'snapshot', write: false, standard: 'camera.snapshot' }] },
        'sonos.0': { help: false, commands: [{ command: 'x', standard: 'media.play' }] },
        'assistant.0': { commands: [{ command: 'ask', standard: 'speech.speak' }] },
        'broken.0': { fail: true },
    });
    const registry = new StandardRegistry(host);
    const snaps = await registry.find('camera.snapshot');
    assert.deepEqual(
        snaps.map(c => `${c.instance}:${c.command}`),
        ['cameras.0:image', 'frigate.0:snapshot'],
    );
    assert.ok(!asked.includes('assistant.0:help'), 'never asks itself');
    assert.ok(!asked.some(a => a.startsWith('sonos.0')), 'only instances with supportedMessages.help');
    assert.ok(!asked.some(a => a.startsWith('frigate.1')), 'stopped instances are not asked');
    assert.equal(registry.has('frigate.0', 'camera.snapshot'), true);
    assert.equal(registry.commandOf('cameras.0', 'camera.snapshot').command, 'image');
    assert.equal(registry.commandOf('cameras.0', 'media.play'), null);
    // within the TTL nobody is asked again
    const before = asked.length;
    await registry.find('media.play');
    assert.equal(asked.length, before);
    // after invalidate they are
    registry.invalidate();
    await registry.find('media.play');
    assert.ok(asked.length > before);
});

test('StandardRegistry shares one run between concurrent calls', async () => {
    const { host, asked } = fakeHost({
        'a.0': { commands: [{ command: 'call', standard: 'phone.call', write: true }] },
    });
    const registry = new StandardRegistry(host);
    await Promise.all([registry.find('phone.call'), registry.find('phone.call'), registry.refresh()]);
    assert.equal(asked.filter(a => a === 'a.0:help').length, 1);
});

test('compareInstances orders by adapter, then number', () => {
    assert.deepEqual(['b.0', 'a.10', 'a.2', 'a.0'].sort(compareInstances), ['a.0', 'a.2', 'a.10', 'b.0']);
});

// ── answers ────────────────────────────────────────────────────────────────

test('standardError reads rule 4', () => {
    assert.equal(standardError({ ok: true }), null);
    assert.equal(standardError({ ok: true, error: null }), null);
    assert.deepEqual(standardError({ error: 'no', reason: 'NOT_FOUND', candidates: ['Anna', 1] }), {
        error: 'no',
        reason: 'NOT_FOUND',
        candidates: ['Anna'],
    });
    assert.equal(standardError(undefined).reason, 'NO_ANSWER');
    assert.equal(standardError({ error: { code: 1 } }).error, '{"code":1}');
});

test('listOf takes {things: [...]}, a bare array and admin selects', () => {
    assert.deepEqual(
        listOf({ cameras: [{ id: 'door', name: 'Haustür', room: 'Flur' }] }, 'cameras').map(i => [
            i.id,
            i.name,
            i.room,
        ]),
        [['door', 'Haustür', 'Flur']],
    );
    assert.deepEqual(
        listOf([{ value: 'cam1', label: 'Einfahrt' }, 'Garten', null, {}], 'cameras').map(i => [i.id, i.name]),
        [
            ['cam1', 'Einfahrt'],
            ['Garten', 'Garten'],
        ],
    );
    assert.deepEqual(listOf({ other: [] }, 'cameras'), []);
});

test('pictureOf accepts {data, contentType} and data URLs, nothing else', () => {
    assert.equal(pictureOf({ data: 'AAAA', contentType: 'image/jpeg' }), 'data:image/jpeg;base64,AAAA');
    assert.equal(pictureOf({ data: 'data:image/png;base64,BBBB' }), 'data:image/png;base64,BBBB');
    assert.equal(pictureOf('data:image/png;base64,CC'), 'data:image/png;base64,CC');
    assert.equal(pictureOf({ data: { type: 'Buffer', data: [1, 2] } }), null, 'a Buffer is not a picture');
    assert.equal(pictureOf({ file: '/opt/iobroker/x.jpg' }), null, 'a host path is not a picture');
    assert.equal(pictureOf({ data: 'AAAA', contentType: 'text/plain' }), null);
});

test('redactPictures keeps the trace small', () => {
    const big = `data:image/jpeg;base64,${'A'.repeat(4000)}`;
    const out = redactPictures({ file: big, text: 'Haustür', nested: [{ image: big }], bytes: new Array(100).fill(1) });
    assert.match(out.file, /^<image\/jpeg, \d+ KB>$/);
    assert.equal(out.text, 'Haustür');
    assert.match(out.nested[0].image, /^<image\/jpeg/);
    assert.equal(out.bytes, '<100 bytes>');
});

// ── quick commands ─────────────────────────────────────────────────────────

test('parseCallCommand: de/en/ru, names and numbers', () => {
    const c = t => {
        const r = parseCallCommand(t);
        return r && `${r.to}|${r.language}`;
    };
    assert.equal(c('Ruf Anna an'), 'Anna|de');
    assert.equal(c('Rufe bitte die Küche an'), 'Küche|de');
    assert.equal(c('Kannst du mal Oma anrufen'), 'Oma|de');
    assert.equal(c('Verbinde mich mit der Haustür'), 'Haustür|de');
    assert.equal(c('Call Anna please'), 'Anna|en');
    assert.equal(c('Connect me with the front door'), 'front door|en');
    assert.equal(c('Позвони Анне'), 'Анне|ru');
    assert.equal(c('Набери 0171 234 56'), '017123456|ru');
    assert.equal(c('Ruf mich an'), null);
    assert.equal(c('Wer hat angerufen?'), null);
    assert.equal(c('Wen soll ich anrufen'), null);
    assert.equal(c('Ruf'), null);
    assert.equal(c('Mach das Licht an'), null);
});

test('parseShowOnCommand splits at the last screen preposition', () => {
    const s = t => {
        const r = parseShowOnCommand(t);
        return r && `${r.what}|${r.screen}|${r.language}`;
    };
    assert.equal(s('Zeige die Haustür auf dem Küchendisplay'), 'Haustür|Küchendisplay|de');
    assert.equal(s('Zeig mir bitte die Kamera an der Haustür auf dem Fernseher'), 'Kamera an der Haustür|Fernseher|de');
    assert.equal(s('Zeige die Einfahrt im Wohnzimmer'), 'Einfahrt|Wohnzimmer|de');
    assert.equal(s('Show the front door camera on the TV'), 'front door camera|TV|en');
    assert.equal(s('Покажи камеру у входа на телевизоре'), 'камеру у входа|телевизоре|ru');
    assert.equal(s('Zeig mir die Haustür'), 'Haustür||de');
    assert.equal(s('Zeig'), null);
    assert.equal(s('Schalte das Licht an'), null);
});

test('showTarget: camera, view, text or unknown', () => {
    const t = x => {
        const r = showTarget(x);
        return `${r.kind}:${r.name}`;
    };
    assert.equal(t('Kamera Einfahrt'), 'camera:Einfahrt');
    assert.equal(t('die Kamera an der Haustür'), 'camera:Haustür');
    assert.equal(t('Einfahrt-Kamera'), 'camera:Einfahrt');
    assert.equal(t('Gartenkamera'), 'camera:Garten');
    assert.equal(t('front door camera'), 'camera:front door');
    assert.equal(t('камеру у входа'), 'camera:входа');
    assert.equal(t('die Ansicht Wetter'), 'view:Wetter');
    assert.equal(t('den Text Essen ist fertig!'), 'text:Essen ist fertig!');
    assert.equal(t('Haustür'), 'unknown:Haustür');
});

test('parsePictureCommand: me or a name, and the camera', () => {
    const p = t => {
        const r = parsePictureCommand(t);
        return r && `${r.recipient}|${r.camera}|${r.cameraWord}|${r.language}`;
    };
    assert.equal(p('Schick mir ein Bild der Haustür'), 'me|Haustür|false|de');
    assert.equal(p('Schicke Anna ein Foto von der Einfahrtkamera per Telegram'), 'Anna|Einfahrt|true|de');
    assert.equal(p('Send me a picture of the front door camera'), 'me|front door|true|en');
    assert.equal(p('Пришли мне фото с камеры у входа'), 'me|входа|true|ru');
    assert.equal(p('Schick mir ein Bild'), null);
    assert.equal(p('Schick Anna eine Nachricht'), null);
});

test('nameFits and pickNamed: endings, rooms, exact names first', () => {
    assert.equal(nameFits('Анне', 'Анна'), true);
    assert.equal(nameFits('кухню', 'Кухня'), true);
    assert.equal(nameFits('Haustür', 'Kamera Haustür'), true);
    assert.equal(nameFits('Garten', 'Garage'), false);
    assert.equal(nameFits('Tür', 'Tor'), false);
    const items = [
        { id: 'a', name: 'Haustür', room: 'Flur' },
        { id: 'b', name: 'Haustür hinten', room: 'Garten' },
        { id: 'c', name: 'Einfahrt', room: 'Hof' },
    ];
    assert.deepEqual(
        pickNamed(items, 'haustür').map(i => i.id),
        ['a'],
        'the exact name wins',
    );
    assert.deepEqual(
        pickNamed(items, 'Hof').map(i => i.id),
        ['c'],
        'a room',
    );
    assert.deepEqual(
        pickNamed(items, 'hinten').map(i => i.id),
        ['b'],
    );
    assert.deepEqual(pickNamed(items, 'Keller'), []);
});

test('quickReply speaks the language of the question', () => {
    assert.equal(quickReply('de', 'calling', { name: 'Anna' }), 'Ich rufe Anna an.');
    assert.equal(quickReply('fr', 'calling', { name: 'Anna' }), 'Calling Anna.');
    assert.equal(
        quickReply('de', 'unknownCamera', { name: 'Keller', names: ['Haustür', 'Einfahrt', 'Garten'] }),
        'Die Kamera Keller kenne ich nicht. Ich kenne: Haustür, Einfahrt oder Garten.',
    );
    assert.equal(quickReply('ru', 'pictureSent', { what: 'Вход' }), 'Отправила тебе снимок: Вход.');
});
