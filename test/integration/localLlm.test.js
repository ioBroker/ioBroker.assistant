'use strict';
// Integration test: local-LLM hand-off detection (tool-free model must escalate device work + refusals).
const test = require('node:test');
const assert = require('node:assert/strict');
const { isHandoff } = require('../../build/lib/localLlm.js');

test('explicit HANDOFF sentinel', () => {
    assert.equal(isHandoff('HANDOFF'), true);
    assert.equal(isHandoff('  handoff '), true);
    assert.equal(isHandoff('"HANDOFF"'), true);
    assert.equal(isHandoff('HANDOFF now'), true);
});

test('refusals escalate (de/en/ru) — the tool-free model should never refuse device work itself', () => {
    // The exact answer from the log that wrongly refused instead of handing off.
    assert.equal(
        isHandoff(
            'Я не могу включать свет в реальном времени. Я - искусственный интеллект и не имею возможности.',
        ),
        true,
    );
    assert.equal(isHandoff("I'm an AI and I cannot control the light in your home."), true);
    assert.equal(isHandoff('Ich bin eine KI und kann das Licht nicht schalten.'), true);
});

test('normal answers are NOT hand-offs', () => {
    assert.equal(isHandoff('Die Hauptstadt von Frankreich ist Paris.'), false);
    assert.equal(isHandoff('Столица Франции — Париж.'), false);
    assert.equal(isHandoff('Here is a short joke about cats.'), false);
});
