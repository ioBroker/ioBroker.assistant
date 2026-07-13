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

test('manual: OpenAI key reuses the main key when provider is openai', async () => {
    const c = await resolveVoiceCredentials(adapter, manual, 'MAINKEY');
    assert.equal(c.openaiKey, 'MAINKEY');
    assert.equal(c.azureKey, 'az');
    assert.equal(c.azureRegion, 'we');
    assert.deepEqual(c.aws, { accessKeyId: 'AK', secretAccessKey: 'SK', region: 'eu' });
});

test('manual: dedicated voice key wins; anthropic without a voice key yields empty', async () => {
    const withKey = await resolveVoiceCredentials(adapter, { ...manual, provider: 'anthropic', voiceApiKey: 'sk-voice' }, 'MAINKEY');
    assert.equal(withKey.openaiKey, 'sk-voice');
    const noKey = await resolveVoiceCredentials(adapter, { ...manual, provider: 'anthropic', voiceApiKey: '' }, 'MAINKEY');
    assert.equal(noKey.openaiKey, '');
});

test('manager with no credential ids falls back to the main key (openai) and empty azure/aws', async () => {
    const c = await resolveVoiceCredentials(
        adapter,
        { voiceCredentialType: 'manager', provider: 'openai', voiceCredentialId: '', azureCredentialId: '', awsCredentialId: '' },
        'MAINKEY',
    );
    assert.equal(c.openaiKey, 'MAINKEY');
    assert.equal(c.azureKey, '');
    assert.equal(c.aws.region, '');
});
