'use strict';
// Integration test: provider preset resolution (SDK, base URL, default model).
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveProvider, LlmAgent } = require('../../build/lib/llm.js');

const log = { level: 'info', debug() {}, info() {}, warn() {}, error() {}, silly() {} };

/** Send one side-job prompt through an agent and return the request the OpenAI SDK got. */
async function sentRequest(provider) {
    const agent = new LlmAgent({ provider, apiKey: 'test', model: 'some-model', baseUrl: 'http://x/v1', log });
    let request;
    agent.openai.chat.completions.create = async req => {
        request = req;
        return { choices: [{ message: { content: 'ok' } }] };
    };
    await agent.complete('ping', 8);
    return request;
}

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

test('openai gets max_completion_tokens, OpenAI-compatible providers keep max_tokens', async () => {
    const o = await sentRequest('openai');
    assert.ok(o.max_completion_tokens >= 1024, 'room for reasoning tokens');
    assert.equal('max_tokens' in o, false);

    const c = await sentRequest('custom');
    assert.equal(c.max_tokens, 8);
    assert.equal('max_completion_tokens' in c, false);
});
