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
 * js-controller >= 7.2 / a recent @iobroker/adapter-core. We access it defensively so the
 * adapter still compiles and runs (in `manual` mode) on older controllers.
 */
import * as adapterCore from '@iobroker/adapter-core';
import type { AdapterConfig } from '../types';

interface CredentialsApi {
    getCredentials?: (
        adapter: unknown,
        id: string,
    ) => Promise<{ values?: { key?: string } } | null | undefined>;
}

const Credentials: CredentialsApi | undefined = (
    adapterCore as unknown as { Credentials?: CredentialsApi }
).Credentials;

/** Read and decrypt a single credential's key from the central store; '' (and a warning) on error. */
export async function readCentralKey(adapter: ioBroker.Adapter, id: string): Promise<string> {
    if (!id) {
        return '';
    }
    if (!Credentials?.getCredentials) {
        adapter.log.warn(
            `Cannot read credential "${id}": the central Credentials API needs js-controller >= 7.2`,
        );
        return '';
    }
    try {
        const cred = await Credentials.getCredentials(adapter, id);
        return (cred?.values?.key || '').trim();
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
