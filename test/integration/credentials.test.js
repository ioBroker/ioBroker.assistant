'use strict';
// Integration test: voice credential resolution (manual mode + manager fallbacks).
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
