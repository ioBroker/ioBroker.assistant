'use strict';
// Integration test: provider preset resolution (SDK, base URL, default model).
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveProvider } = require('../../build/lib/llm.js');

test('openai / anthropic use the vendor SDK with the default endpoint', () => {
    const o = resolveProvider('openai');
    assert.equal(o.sdk, 'openai');
    assert.equal(o.baseUrl, '');
    assert.ok(o.defaultModel);

    const a = resolveProvider('anthropic');
    assert.equal(a.sdk, 'anthropic');
    assert.equal(a.baseUrl, '');
    assert.match(a.defaultModel, /claude/);
});

test('gemini / deepseek use the OpenAI SDK with a fixed base URL', () => {
    const g = resolveProvider('gemini', 'http://ignored-for-gemini');
    assert.equal(g.sdk, 'openai');
    assert.match(g.baseUrl, /generativelanguage\.googleapis\.com/);
    assert.ok(g.defaultModel);

    const d = resolveProvider('deepseek');
    assert.equal(d.sdk, 'openai');
    assert.match(d.baseUrl, /api\.deepseek\.com/);
    assert.match(d.defaultModel, /deepseek/);
});

test('custom uses the configured base URL; unknown falls back to openai', () => {
    assert.equal(resolveProvider('custom', 'http://x/v1').baseUrl, 'http://x/v1');
    assert.equal(resolveProvider('custom', '').baseUrl, '');
    assert.equal(resolveProvider(undefined).sdk, 'openai');
    assert.equal(resolveProvider('nonsense').sdk, 'openai');
});
