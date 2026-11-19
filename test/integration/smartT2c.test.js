'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SmartText2Command, T2C_QUESTION_MS, interpretT2cResult, t2cSessionId } = require('../../build/lib/smartT2c');

const ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * A host with a smart-text2command instance that answers `processText` with `reply(message)` — checked against
 * its request validator (ids, mode, languages de/en), like `src/api/RequestValidator.ts` there.
 */
function fakeHost(reply, alive = true) {
    const sent = [];
    return {
        sent,
        async getForeignStateAsync(id) {
            return id === 'system.adapter.smart-text2command.0.alive' ? { val: alive } : null;
        },
        async sendToAsync(instance, command, message, options) {
            sent.push({ instance, command, message, options });
            if (!ID_RE.test(message.requestId) || (message.sessionId !== undefined && !ID_RE.test(message.sessionId))) {
                return { error: 'Invalid requestId' };
            }
            if (message.language !== undefined && !['de', 'en'].includes(message.language)) {
                return { error: 'Unsupported language' };
            }
            if (message.mode !== 'execute') {
                return { error: 'Invalid mode' };
            }
            return reply(message);
        },
    };
}

const success = {
    requestId: 'r',
    status: 'success',
    language: 'de',
    intent: 'device.turnOn',
    response: 'Der Befehl, Lampe im Raum Wohnzimmer einzuschalten, wurde übergeben.',
    actions: [{ deviceId: 'd', stateId: 'd.POWER', status: 'accepted' }],
};

test('t2cSessionId: plain sources stay, others get a readable part and a hash', () => {
    assert.equal(t2cSessionId('chat'), 'chat');
    assert.equal(t2cSessionId('telegram:denis'), 'telegram:denis');
    const spaced = t2cSessionId('telegram:Denis Haev');
    assert.match(spaced, /^telegram:Denis_Haev-[0-9a-f]{8}$/);
    const cyrillic = t2cSessionId('Кухня');
    assert.match(cyrillic, /^[0-9a-f]{8}$/);
    assert.notEqual(cyrillic, t2cSessionId('Спальня'), 'two Cyrillic rooms must not share a session');
    assert.equal(t2cSessionId(''), 'default');
    assert.ok(ID_RE.test(t2cSessionId('x'.repeat(300))));
    assert.ok(ID_RE.test(t2cSessionId(`${'ä'.repeat(50)} ${'b'.repeat(200)}`)));
});

test('interpretT2cResult: success, cancel, question, rejection, errors', () => {
    const ok = interpretT2cResult(success);
    assert.equal(ok.kind, 'answer');
    assert.equal(ok.control, true);
    assert.equal(ok.text, success.response);

    const read = interpretT2cResult({
        status: 'success',
        intent: 'device.getValue',
        response: 'Der Wert beträgt 21 °C.',
        actions: [{ status: 'confirmed', value: 21 }],
    });
    assert.equal(read.kind, 'answer');
    assert.equal(read.control, false, 'a read has something to tell');

    assert.equal(interpretT2cResult({ status: 'cancelled', response: 'Okay.' }).kind, 'answer');

    const question = interpretT2cResult({
        status: 'clarification',
        intent: 'device.getValue',
        response: 'Meintest du Heizung (Wohnzimmer), Temperatursensor (Schlafzimmer)?',
        clarification: { id: 'a89a5821-c40e-4e03-8810-0f2284c3563e', key: 'device', options: [] },
    });
    assert.equal(question.kind, 'question');

    const invalid = interpretT2cResult({
        status: 'clarification',
        errorCode: 'INVALID_SELECTION',
        response: 'Die Antwort passt nicht zur Rückfrage. …',
        clarification: { id: 'a89a5821', key: 'device' },
    });
    assert.equal(invalid.kind, 'pass', 'a reply that does not fit is a new request');

    for (const code of ['UNCLEAR_INTENT', 'UNKNOWN_ROOM', 'ACTION_NOT_APPROVED', 'MODEL_UNAVAILABLE']) {
        const r = interpretT2cResult({ status: 'rejected', errorCode: code, response: 'Nein.' });
        assert.equal(r.kind, 'pass', code);
        assert.equal(r.reason, code);
    }
    assert.equal(
        interpretT2cResult({ status: 'error', errorCode: 'PROCESSING_ERROR', response: 'Verarbeitung fehlgeschlagen.' })
            .kind,
        'pass',
    );
    const failedRead = interpretT2cResult({
        status: 'error',
        errorCode: 'STATE_UNAVAILABLE',
        response: 'Der Datenpunkt liefert derzeit keinen Wert.',
        actions: [{ status: 'failed', message: 'STATE_UNAVAILABLE' }],
    });
    assert.equal(failedRead.kind, 'answer', 'it tried: its error is said, the models must not repeat it');

    assert.deepEqual(interpretT2cResult({ error: 'RATE_LIMITED' }).reason, 'RATE_LIMITED');
    assert.equal(interpretT2cResult(undefined).kind, 'pass');
    // wrapped once more, as its documentation shows the callback
    assert.equal(interpretT2cResult({ message: success }).kind, 'answer');
});

test('ask: sends processText with a new request id, the session, the language and execute', async () => {
    const host = fakeHost(() => success);
    const t2c = new SmartText2Command(host, 'smart-text2command.0', 5000);
    const outcome = await t2c.ask('Schalte die Lampe im Wohnzimmer ein', 'telegram:Denis Haev', 'de');
    assert.equal(outcome.kind, 'answer');
    await t2c.ask('Schalte die Lampe aus', 'telegram:Denis Haev', 'de');
    const [first, second] = host.sent;
    assert.equal(first.instance, 'smart-text2command.0');
    assert.equal(first.command, 'processText');
    assert.equal(first.message.mode, 'execute');
    assert.equal(first.message.language, 'de');
    assert.equal(first.message.clarificationId, undefined);
    assert.equal(first.message.sessionId, second.message.sessionId);
    assert.notEqual(first.message.requestId, second.message.requestId);
    assert.equal(first.options.timeout, 5000);
});

test('a question: the next utterance of the same source is its answer, other sources are not', async () => {
    let step = 0;
    const host = fakeHost(message => {
        step++;
        if (!message.clarificationId) {
            return {
                status: 'clarification',
                intent: 'device.getValue',
                response: 'Welche Temperatur? Wohnzimmer oder Schlafzimmer?',
                clarification: { id: 'q-1', key: 'room' },
            };
        }
        assert.equal(message.clarificationId, 'q-1');
        assert.equal(message.language, undefined, 'the language of the question applies');
        return { status: 'success', intent: 'device.getValue', response: '21 °C.', actions: [{ status: 'confirmed' }] };
    });
    const t2c = new SmartText2Command(host, 'smart-text2command.0');
    const asked = await t2c.ask('Welche Temperatur', 'kitchen', 'de');
    assert.equal(asked.kind, 'question');
    assert.equal(t2c.hasQuestion('kitchen'), true);
    assert.equal(t2c.hasQuestion('bedroom'), false);
    assert.equal((await t2c.reply('Wohnzimmer', 'bedroom')).kind, 'pass');

    const answered = await t2c.reply('Wohnzimmer', 'kitchen');
    assert.equal(answered.kind, 'answer');
    assert.equal(answered.text, '21 °C.');
    assert.equal(t2c.hasQuestion('kitchen'), false, 'the question is used up');
    assert.equal(step, 2);
});

test('a reply that does not fit ends the question; a new request ends it too', async () => {
    const host = fakeHost(message =>
        message.clarificationId
            ? { status: 'clarification', errorCode: 'INVALID_SELECTION', response: '…', clarification: { id: 'q-1' } }
            : { status: 'clarification', response: 'Welcher Raum?', clarification: { id: 'q-1', key: 'room' } },
    );
    const t2c = new SmartText2Command(host, 'smart-text2command.0');
    await t2c.ask('Licht an', 'chat', 'de');
    const reply = await t2c.reply('Wie spät ist es?', 'chat');
    assert.equal(reply.kind, 'pass');
    assert.equal(t2c.hasQuestion('chat'), false);

    await t2c.ask('Licht an', 'chat', 'de');
    assert.equal(t2c.hasQuestion('chat'), true);
    t2c.forget('chat');
    assert.equal(t2c.hasQuestion('chat'), false);
});

test('a question expires after its five minutes', async () => {
    let now = 1_000_000;
    const host = fakeHost(() => ({ status: 'clarification', response: 'Welcher Raum?', clarification: { id: 'q-1' } }));
    const t2c = new SmartText2Command(host, 'smart-text2command.0', 1000, () => now);
    await t2c.ask('Licht an', 'chat', 'de');
    now += T2C_QUESTION_MS - 1;
    assert.equal(t2c.hasQuestion('chat'), true);
    now += 2;
    assert.equal(t2c.hasQuestion('chat'), false);
    assert.equal((await t2c.reply('Küche', 'chat')).kind, 'pass');
    assert.equal(host.sent.length, 1, 'an expired question is not sent as one');
});

test('a language it does not speak is asked once, then left out', async () => {
    const host = fakeHost(() => success);
    const t2c = new SmartText2Command(host, 'smart-text2command.0');
    const first = await t2c.ask('Включи свет', 'kitchen', 'ru');
    assert.equal(first.kind, 'pass');
    assert.match(first.reason, /'ru'/);
    const second = await t2c.ask('Выключи свет', 'kitchen', 'ru');
    assert.equal(second.kind, 'pass');
    assert.equal(host.sent.length, 1);
    assert.equal((await t2c.ask('Licht an', 'kitchen', 'de-DE')).kind, 'answer');
});

test('not running, no answer: the request goes on', async () => {
    const stopped = fakeHost(() => success, false);
    const t2c = new SmartText2Command(stopped, 'smart-text2command.0');
    const outcome = await t2c.ask('Licht an', 'chat', 'de');
    assert.equal(outcome.kind, 'pass');
    assert.match(outcome.reason, /not running/);
    assert.equal(stopped.sent.length, 0);

    const silent = fakeHost(() => {
        throw new Error('timeout');
    });
    const timeout = await new SmartText2Command(silent, 'smart-text2command.0').ask('Licht an', 'chat', 'de');
    assert.equal(timeout.kind, 'pass');
    assert.equal(timeout.reason, 'timeout');
});
