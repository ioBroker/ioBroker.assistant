'use strict';
// The system-wide AI settings of admin (system.ai) as the source of the cloud LLM.
//
// systemAi.js loads credentials.js, which imports @iobroker/adapter-core — see credentials.test.js for why
// IOBROKER_CONTROLLER_DIR has to be set before.
const path = require('node:path');
if (!process.env.IOBROKER_CONTROLLER_DIR) {
    try {
        process.env.IOBROKER_CONTROLLER_DIR = path.dirname(require.resolve('iobroker.js-controller/package.json'));
    } catch {
        process.env.IOBROKER_CONTROLLER_DIR = __dirname;
    }
}
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    systemAiSelection,
    systemAiFingerprint,
    usesSystemAi,
    resolveLlm,
    resolveSystemLlm,
} = require('../../build/lib/systemAi.js');

const CREDENTIAL = 'system.credentials.openrouter';

/** An adapter with the given objects; a credential's encrypted key is "enc:<key>". */
function fakeAdapter(objects = {}) {
    return {
        log: { warn() {}, error() {}, info() {}, debug() {} },
        decrypt: value => value.replace(/^enc:/, ''),
        async getForeignObjectAsync(id) {
            return objects[id] || null;
        },
    };
}

const credential = key => ({
    _id: CREDENTIAL,
    type: 'config',
    common: { name: 'OpenRouter' },
    native: { type: 'ai', version: 1, encryptedFields: ['key'], key: `enc:${key}` },
});
const systemAi = native => ({ _id: 'system.ai', type: 'config', common: { name: 'AI' }, native });

test('systemAiSelection: providers of admin, the address only for the custom server', () => {
    assert.equal(systemAiSelection(undefined), null);
    assert.equal(systemAiSelection({ provider: 'mistral' }), null, 'a provider the assistant does not know');
    assert.equal(systemAiSelection({ provider: 'toString' }), null, 'no prototype property');
    assert.deepEqual(systemAiSelection({ provider: 'openrouter', model: ' x/y ', credentialId: 'c', baseUrl: 'u' }), {
        provider: 'openrouter',
        model: 'x/y',
        credentialId: 'c',
        baseUrl: '',
    });
    assert.equal(
        systemAiSelection({ provider: 'custom', baseUrl: 'http://ollama:11434/v1' }).baseUrl,
        'http://ollama:11434/v1',
    );
    for (const provider of ['openai', 'anthropic', 'gemini', 'deepseek', 'openrouter', 'custom']) {
        assert.ok(systemAiSelection({ provider }), provider);
    }
});

test('systemAiFingerprint: only what the assistant uses counts', () => {
    const base = { provider: 'openai', model: 'gpt', credentialId: 'c' };
    assert.equal(systemAiFingerprint({ ...base, hideFab: true }), systemAiFingerprint({ ...base, hideFab: false }));
    assert.notEqual(systemAiFingerprint(base), systemAiFingerprint({ ...base, model: 'other' }));
});

test('usesSystemAi: provider "system", or a provider that needs a key without one', () => {
    assert.equal(usesSystemAi({ provider: 'system', apiKey: 'sk' }), true);
    assert.equal(usesSystemAi({ provider: 'openai', credentialType: 'manual', apiKey: '' }), true);
    assert.equal(usesSystemAi({ provider: 'openai', credentialType: 'manual', apiKey: 'sk' }), false);
    assert.equal(usesSystemAi({ provider: 'anthropic', credentialType: 'manager', credentialIdApiKey: '' }), true);
    assert.equal(usesSystemAi({ provider: 'anthropic', credentialType: 'manager', credentialIdApiKey: 'c' }), false);
    assert.equal(usesSystemAi({ provider: 'custom', apiKey: '' }), false, 'a local server often has no key');
    assert.equal(usesSystemAi({ provider: 'none' }), false);
    assert.equal(usesSystemAi({ provider: 'pi-agent' }), false);
});

test('resolveLlm: provider "system" takes provider, model, key and address of system.ai', async () => {
    const adapter = fakeAdapter({
        'system.ai': systemAi({ provider: 'openrouter', model: 'anthropic/claude-sonnet-5', credentialId: CREDENTIAL }),
        [CREDENTIAL]: credential('sk-or'),
    });
    assert.deepEqual(await resolveLlm(adapter, { provider: 'system', maxTokens: 300 }), {
        provider: 'openrouter',
        apiKey: 'sk-or',
        model: 'anthropic/claude-sonnet-5',
        baseUrl: 'https://openrouter.ai/api/v1',
        system: true,
    });
});

test('resolveLlm: an instance without a key of its own takes system.ai; one with a key keeps its own', async () => {
    const adapter = fakeAdapter({
        'system.ai': systemAi({ provider: 'openrouter', credentialId: CREDENTIAL }),
        [CREDENTIAL]: credential('sk-or'),
    });
    const fallback = await resolveLlm(adapter, {
        provider: 'openai',
        credentialType: 'manual',
        apiKey: '',
        model: 'gpt-4o',
    });
    assert.equal(fallback.provider, 'openrouter');
    assert.equal(fallback.model, 'openai/gpt-4o-mini', 'the default of the system provider, not the own model');
    const own = await resolveLlm(adapter, {
        provider: 'anthropic',
        credentialType: 'manual',
        apiKey: 'sk-ant',
        model: '',
    });
    assert.deepEqual(own, {
        provider: 'anthropic',
        apiKey: 'sk-ant',
        model: 'claude-sonnet-4-6',
        baseUrl: '',
        system: false,
    });
});

test('resolveSystemLlm: says why there is no LLM', async () => {
    const empty = fakeAdapter({});
    assert.match((await resolveSystemLlm(empty, undefined, true)).error, /no provider/);
    assert.match((await resolveSystemLlm(empty, undefined, false)).error, /No API key configured/);
    assert.match(
        (await resolveSystemLlm(empty, { provider: 'openai', credentialId: 'system.credentials.gone' }, true)).error,
        /no API key for openai/,
    );
    assert.match((await resolveSystemLlm(empty, { provider: 'custom' }, true)).error, /without address/);
    const local = await resolveSystemLlm(
        empty,
        { provider: 'custom', baseUrl: 'http://ollama:11434/v1', model: 'qwen' },
        true,
    );
    assert.equal(local.apiKey, 'no-key', 'a local server without a key');
    assert.equal(local.baseUrl, 'http://ollama:11434/v1');
});
