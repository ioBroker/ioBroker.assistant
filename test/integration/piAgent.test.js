'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    PiAgentHarness,
    PI_AGENT_MAX_INSTRUCTIONS,
    composeInstructions,
    conversationOf,
} = require('../../build/lib/piAgent');

/** A host that answers `ask` with `reply(message)` and reports the instance as running unless told otherwise. */
function fakeHost(reply, alive = true) {
    const sent = [];
    return {
        sent,
        async getForeignStateAsync(id) {
            return id === 'system.adapter.pi-agent.0.alive' ? { val: alive } : null;
        },
        async sendToAsync(instance, command, message, options) {
            sent.push({ instance, command, message, options });
            return reply(message);
        },
    };
}

test('ask: sends text, conversation and instructions, with a unique request id and the timeout', async () => {
    const host = fakeHost(() => ({ answer: '  Das Licht ist an. ' }));
    const harness = new PiAgentHarness(host, 'pi-agent.0', 30000);
    const answer = await harness.ask({ text: 'Ist das Licht an?', conversation: 'kitchen', instructions: 'Kurz.' });
    assert.equal(answer, 'Das Licht ist an.');
    await harness.ask({ text: 'Und jetzt?', conversation: 'kitchen', instructions: 'Kurz.' });

    assert.equal(host.sent.length, 2);
    const [first, second] = host.sent;
    assert.equal(first.instance, 'pi-agent.0');
    assert.equal(first.command, 'ask');
    assert.equal(first.message.text, 'Ist das Licht an?');
    assert.equal(first.message.conversation, 'kitchen');
    assert.equal(first.message.instructions, 'Kurz.');
    assert.deepEqual(first.options, { timeout: 30000 });
    assert.notEqual(first.message.requestId, second.message.requestId, 'pi-agent answers a repeated id only once');
});

test('ask: an instance that is not running fails at once, without waiting for the timeout', async () => {
    const host = fakeHost(() => ({ answer: 'never' }), false);
    const harness = new PiAgentHarness(host, 'pi-agent.0');
    await assert.rejects(harness.ask({ text: 'x', conversation: 'c', instructions: '' }), /not running/);
    assert.equal(host.sent.length, 0);
});

test('ask: an error or an empty answer of pi-agent is an exception (the caller falls back)', async () => {
    const failing = new PiAgentHarness(
        fakeHost(() => ({ error: 'Agent is not running' })),
        'pi-agent.0',
    );
    await assert.rejects(failing.ask({ text: 'x', conversation: 'c', instructions: '' }), /Agent is not running/);
    const empty = new PiAgentHarness(
        fakeHost(() => ({ answer: '' })),
        'pi-agent.0',
    );
    await assert.rejects(empty.ask({ text: 'x', conversation: 'c', instructions: '' }), /no answer/);
});

test('conversationOf: "/" is the separator of pi-agent, an empty source gets a name', () => {
    assert.equal(conversationOf('telegram:Max/1'), 'telegram:Max_1');
    assert.equal(conversationOf(''), 'default');
    assert.equal(conversationOf('x'.repeat(300)).length, 100);
});

test('composeInstructions: optional blocks are dropped from the end until it fits', () => {
    assert.deepEqual(composeInstructions(['Style', ''], ['Memory', 'Devices']), {
        text: 'Style\n\nMemory\n\nDevices',
        dropped: 0,
    });
    const devices = 'd'.repeat(PI_AGENT_MAX_INSTRUCTIONS);
    const { text, dropped } = composeInstructions(['Style'], ['Memory', devices]);
    assert.equal(text, 'Style\n\nMemory', 'the device list goes first, the memory stays');
    assert.equal(dropped, 1);
    const tooLong = composeInstructions(['s'.repeat(PI_AGENT_MAX_INSTRUCTIONS + 10)], []);
    assert.equal(tooLong.text.length, PI_AGENT_MAX_INSTRUCTIONS);
});
