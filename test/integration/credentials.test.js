'use strict';
// Integration test: voice credential resolution (manual mode + manager fallbacks).
//
// credentials.js imports @iobroker/adapter-core, which resolves the js-controller directory the moment it
// is loaded and calls process.exit(10) if none is found — fatal for this pure unit test on a bare CI. Since
// adapter-core >= 3.4.2, IOBROKER_CONTROLLER_DIR short-circuits that lookup, so we point it at the installed
// controller (or, as a last resort, any existing dir) BEFORE requiring the module. The test never touches
// the controller, so the exact path is irrelevant — it only has to make the load-time lookup succeed.
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
const { resolveVoiceCredentials } = require('../../build/lib/credentials.js');

const adapter = { log: { warn() {}, error() {}, info() {}, debug() {} } };

const manual = {
    voiceCredentialType: 'manual',
    provider: 'openai',
    voiceApiKey: '',
    azureSpeechKey: 'az',
    azureSpeechRegion: 'we',
    awsAccessKeyId: 'AK',
    awsSecretAccessKey: 'SK',
    awsRegion: 'eu',
};

const OPENAI_LLM = { provider: 'openai', apiKey: 'MAINKEY' };

test('manual: OpenAI key reuses the main key when the LLM is OpenAI', async () => {
    const c = await resolveVoiceCredentials(adapter, manual, OPENAI_LLM);
    assert.equal(c.openaiKey, 'MAINKEY');
    assert.equal(c.azureKey, 'az');
    assert.equal(c.azureRegion, 'we');
    assert.deepEqual(c.aws, { accessKeyId: 'AK', secretAccessKey: 'SK', region: 'eu' });
});

test('manual: dedicated voice key wins; anthropic without a voice key yields empty', async () => {
    const anthropic = { provider: 'anthropic', apiKey: 'sk-ant' };
    const withKey = await resolveVoiceCredentials(adapter, { ...manual, provider: 'anthropic', voiceApiKey: 'sk-voice' }, anthropic);
    assert.equal(withKey.openaiKey, 'sk-voice');
    const noKey = await resolveVoiceCredentials(adapter, { ...manual, provider: 'anthropic', voiceApiKey: '' }, anthropic);
    assert.equal(noKey.openaiKey, '');
});

test('manager with no credential ids falls back to the main key (openai) and empty azure/aws', async () => {
    const c = await resolveVoiceCredentials(
        adapter,
        { voiceCredentialType: 'manager', provider: 'openai', voiceCredentialId: '', azureCredentialId: '', awsCredentialId: '' },
        OPENAI_LLM,
    );
    assert.equal(c.openaiKey, 'MAINKEY');
    assert.equal(c.azureKey, '');
    assert.equal(c.aws.region, '');
});

test('OpenRouter speech: own key wins, otherwise the key of an OpenRouter LLM, never that of another vendor', async () => {
    const openrouter = { provider: 'openrouter', apiKey: 'sk-or-llm' };
    const own = await resolveVoiceCredentials(adapter, { ...manual, openrouterSpeechKey: ' sk-or-own ' }, openrouter);
    assert.equal(own.openrouterKey, 'sk-or-own');
    const fromLlm = await resolveVoiceCredentials(adapter, { ...manual, openrouterSpeechKey: '' }, openrouter);
    assert.equal(fromLlm.openrouterKey, 'sk-or-llm');
    assert.equal(fromLlm.openaiKey, '', 'an OpenRouter key is no OpenAI key');
    const otherVendor = await resolveVoiceCredentials(adapter, { ...manual, openrouterSpeechKey: '' }, OPENAI_LLM);
    assert.equal(otherVendor.openrouterKey, '');
    const manager = await resolveVoiceCredentials(
        adapter,
        { voiceCredentialType: 'manager', openrouterCredentialId: '', voiceCredentialId: '', azureCredentialId: '', awsCredentialId: '' },
        openrouter,
    );
    assert.equal(manager.openrouterKey, 'sk-or-llm');
    assert.equal((await resolveVoiceCredentials(adapter, manual, null)).openaiKey, '', 'no LLM');
});
