/**
 * The system-wide AI settings of admin (`system.ai`, System settings → tab "AI") as the source of the
 * cloud LLM: provider, model, key — always an entry of the central credential store — and the address of
 * a custom endpoint.
 *
 * Used with the provider `system`, and by an instance that has no key of its own: an assistant nobody
 * configured takes what was set up once for the whole system (the same rule as `@iobroker/ai-core`'s
 * `usesSystemAiSettings`). The maximum answer length stays the assistant's own (`maxTokens`), because a
 * spoken answer needs far fewer tokens than the admin chat.
 */
import type { AdapterConfig } from '../types';
import { readCentralKey, resolveApiKey } from './credentials';
import { PROVIDER_PRESETS, effectiveApiKey, resolveProvider, type Provider } from './llm';

/** ID of the object with the system-wide AI settings */
export const SYSTEM_AI_ID = 'system.ai';

/** Fields of `system.ai` the assistant uses — a change of the others (like admin's chat button) needs no restart */
const USED_FIELDS = ['provider', 'model', 'credentialId', 'baseUrl'] as const;

/** Where to set them up, for the log */
const WHERE = 'admin → System settings → tab "AI"';

/** Provider, model, credential and address out of `system.ai` */
export interface SystemAiSelection {
    provider: Provider;
    model: string;
    credentialId: string;
    /** Only for `custom` */
    baseUrl: string;
}

/** The cloud LLM the instance works with, whether configured here or in `system.ai` */
export interface ResolvedLlm {
    provider: Provider;
    apiKey: string;
    model: string;
    baseUrl: string;
    /** Taken from `system.ai` */
    system: boolean;
}

function text(value: unknown): string {
    return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

/**
 * Provider, model, credential and address of `system.ai`; `null` if it names no provider the assistant knows.
 *
 * @param native the `native` of `system.ai`
 */
export function systemAiSelection(native: Record<string, unknown> | null | undefined): SystemAiSelection | null {
    const provider = text(native?.provider);
    if (!provider || !Object.prototype.hasOwnProperty.call(PROVIDER_PRESETS, provider)) {
        return null;
    }
    return {
        provider: provider as Provider,
        model: text(native?.model),
        credentialId: text(native?.credentialId),
        baseUrl: provider === 'custom' ? text(native?.baseUrl) : '',
    };
}

/**
 * What of `system.ai` the assistant depends on; a change of it restarts the instance.
 *
 * @param native the `native` of `system.ai`
 */
export function systemAiFingerprint(native: Record<string, unknown> | null | undefined): string {
    return JSON.stringify(USED_FIELDS.map(field => text(native?.[field])));
}

/**
 * Whether the instance takes the cloud LLM from `system.ai`: provider `system`, or a provider that needs a key
 * without one (neither in the adapter nor a credential) — the custom endpoint often works without a key.
 *
 * @param cfg the configuration of the instance
 */
export function usesSystemAi(
    cfg: Pick<AdapterConfig, 'provider' | 'credentialType' | 'apiKey' | 'credentialIdApiKey'>,
): boolean {
    const provider = cfg.provider || 'openai';
    if (provider === 'system') {
        return true;
    }
    if (provider === 'none' || provider === 'pi-agent' || provider === 'custom') {
        return false;
    }
    return cfg.credentialType === 'manager' ? !text(cfg.credentialIdApiKey) : !text(cfg.apiKey);
}

/**
 * Read `system.ai`; a missing object (or one the adapter may not read) gives `undefined`.
 *
 * @param adapter the adapter
 */
export async function readSystemAi(adapter: ioBroker.Adapter): Promise<Record<string, unknown> | undefined> {
    try {
        const obj = await adapter.getForeignObjectAsync(SYSTEM_AI_ID);
        return obj?.native;
    } catch {
        return undefined;
    }
}

/**
 * The cloud LLM of `system.ai`, or why there is none.
 *
 * @param adapter the adapter (reads the credential)
 * @param native the `native` of `system.ai`
 * @param explicit the provider `system` was chosen (otherwise the instance only has no key of its own)
 */
export async function resolveSystemLlm(
    adapter: ioBroker.Adapter,
    native: Record<string, unknown> | null | undefined,
    explicit: boolean,
): Promise<ResolvedLlm | { error: string }> {
    const sel = systemAiSelection(native);
    if (!sel) {
        return {
            error: explicit
                ? `The system-wide AI settings have no provider — set one up in ${WHERE} or choose a provider here.`
                : `No API key configured — enter one in the adapter settings or set up the system-wide AI settings in ${WHERE}.`,
        };
    }
    if (sel.provider === 'custom' && !sel.baseUrl) {
        return { error: `The system-wide AI settings use an OpenAI-compatible server without address (${WHERE}).` };
    }
    const apiKey = effectiveApiKey(sel.provider, await readCentralKey(adapter, sel.credentialId));
    if (!apiKey) {
        return { error: `The system-wide AI settings have no API key for ${sel.provider} (${WHERE}).` };
    }
    const preset = resolveProvider(sel.provider, sel.baseUrl);
    return {
        provider: sel.provider,
        apiKey,
        model: sel.model || preset.defaultModel,
        baseUrl: preset.baseUrl,
        system: true,
    };
}

/**
 * The cloud LLM of the instance: its own provider and key, or those of `system.ai` (see {@link usesSystemAi}).
 * Not for the providers `none` and `pi-agent`, which have no LLM of their own.
 *
 * @param adapter the adapter
 * @param cfg the configuration of the instance
 */
export async function resolveLlm(
    adapter: ioBroker.Adapter,
    cfg: AdapterConfig,
): Promise<ResolvedLlm | { error: string }> {
    if (usesSystemAi(cfg)) {
        return resolveSystemLlm(adapter, await readSystemAi(adapter), cfg.provider === 'system');
    }
    const provider = (cfg.provider || 'openai') as Provider;
    const apiKey = effectiveApiKey(provider, await resolveApiKey(adapter, cfg));
    const preset = resolveProvider(provider, cfg.baseUrl);
    return { provider, apiKey, model: cfg.model || preset.defaultModel, baseUrl: preset.baseUrl, system: false };
}
