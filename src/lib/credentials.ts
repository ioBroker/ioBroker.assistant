/**
 * Resolve the LLM API key from the adapter config.
 *
 * Two modes (`config.credentialType`):
 *  - 'manual':  the key is stored directly in the (encrypted) adapter config (`config.apiKey`).
 *  - 'manager': the config only stores the ID of a credential in the central ioBroker
 *               credential store (`system.credentials.*`); the real key is resolved at runtime
 *               via the Credentials API.
 *
 * The central Credentials API (`Credentials.getCredentials`) is only available with
 * js-controller >= 7.2 / a recent \@iobroker/adapter-core. We access it defensively so the
 * adapter still compiles and runs (in `manual` mode) on older controllers.
 */
import Credentials from '@iobroker/adapter-core/credentials';
import type { AdapterConfig } from '../types';
import type { VoiceCredentials } from './voice/engines';

/** Read and decrypt a single credential's key from the central store; '' (and a warning) on error. */
export async function readCentralKey(adapter: ioBroker.Adapter, id: string): Promise<string> {
    if (!id) {
        return '';
    }
    if (!Credentials?.getCredentials) {
        adapter.log.warn(`Cannot read credential "${id}": the central Credentials API needs js-controller >= 7.2`);
        return '';
    }
    try {
        const cred = await Credentials.getCredentials(adapter, id);
        return ((cred?.values?.key as string) || '').trim();
    } catch (e) {
        adapter.log.warn(`Cannot read credential "${id}": ${(e as Error).message}`);
        return '';
    }
}

/**
 * Resolve the effective API key for the configured provider.
 * `overrideKey`/`overrideCredentialId` win over the stored config (used by the settings-dialog
 * Test button, where unsaved form values should be used).
 */
export async function resolveApiKey(
    adapter: ioBroker.Adapter,
    config: AdapterConfig,
    override?: { credentialType?: 'manual' | 'manager'; apiKey?: string; credentialId?: string },
): Promise<string> {
    const mode = override?.credentialType || config.credentialType || 'manual';
    if (mode === 'manager') {
        const id = (override?.credentialId || config.credentialIdApiKey || '').trim();
        return readCentralKey(adapter, id);
    }
    return (override?.apiKey || config.apiKey || '').trim();
}

/** Read and decrypt all fields of a credential from the central store; {} (and a warning) on error. */
export async function readCentralValues(adapter: ioBroker.Adapter, id: string): Promise<Record<string, unknown>> {
    if (!id) {
        return {};
    }
    if (!Credentials?.getCredentials) {
        adapter.log.warn(`Cannot read credential "${id}": the central Credentials API needs js-controller >= 7.2`);
        return {};
    }
    try {
        const cred = await Credentials.getCredentials(adapter, id);
        return cred?.values || {};
    } catch (e) {
        adapter.log.warn(`Cannot read credential "${id}": ${(e as Error).message}`);
        return {};
    }
}

/** Safe stringify of a credential/config field (values are strings/numbers/booleans). */
function str(v: unknown): string {
    if (typeof v === 'string') {
        return v.trim();
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
        return String(v);
    }
    return '';
}

/**
 * Resolve the speech (STT/TTS) credentials for OpenAI, Azure and AWS.
 *  - 'manual':  the encrypted key/region config fields.
 *  - 'manager': the central credential store, keyed by the *CredentialId fields
 *               (azure values: { key, region }; aws values: { accessKeyId, secretAccessKey, region }).
 * `mainApiKey` is reused for OpenAI speech when no dedicated OpenAI speech credential is set and the
 * LLM provider is already OpenAI.
 */
export async function resolveVoiceCredentials(
    adapter: ioBroker.Adapter,
    config: AdapterConfig,
    mainApiKey: string,
): Promise<VoiceCredentials> {
    const openaiFallback = config.provider === 'openai' ? mainApiKey : '';

    if (config.voiceCredentialType === 'manager') {
        const openaiKey = config.voiceCredentialId
            ? await readCentralKey(adapter, config.voiceCredentialId)
            : openaiFallback;
        const azure = config.azureCredentialId ? await readCentralValues(adapter, config.azureCredentialId) : {};
        const aws = config.awsCredentialId ? await readCentralValues(adapter, config.awsCredentialId) : {};
        return {
            openaiKey,
            azureKey: str(azure.key),
            azureRegion: str(azure.region),
            aws: {
                accessKeyId: str(aws.accessKeyId),
                secretAccessKey: str(aws.secretAccessKey),
                region: str(aws.region),
            },
        };
    }

    return {
        openaiKey: str(config.voiceApiKey) || openaiFallback,
        azureKey: str(config.azureSpeechKey),
        azureRegion: str(config.azureSpeechRegion),
        aws: {
            accessKeyId: str(config.awsAccessKeyId),
            secretAccessKey: str(config.awsSecretAccessKey),
            region: str(config.awsRegion),
        },
    };
}
