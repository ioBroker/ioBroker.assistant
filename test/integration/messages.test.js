'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isLateReply } = require('../../build/lib/messages.js');

test('isLateReply: a reply whose callback is gone is no request', () => {
    // pi-agent answering the process of the assistant that stopped for its update
    assert.equal(
        isLateReply({
            command: 'ask',
            from: 'system.adapter.pi-agent.0',
            message: { answer: 'Fertig.' },
            callback: { ack: true, id: 12, message: { text: 'x' }, time: 1 },
        }),
        true,
    );
    // a request that waits for an answer, one that does not, and nothing
    assert.equal(isLateReply({ command: 'ask', callback: { ack: false, id: 3, message: {}, time: 1 } }), false);
    assert.equal(isLateReply({ command: 'ask', callback: { id: 3, message: {}, time: 1 } }), false);
    assert.equal(isLateReply({ command: 'ask' }), false);
    assert.equal(isLateReply(null), false);
});
