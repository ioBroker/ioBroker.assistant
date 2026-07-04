export interface AdapterConfig {
    provider: 'openai' | 'anthropic' | 'custom';
    /**
     * Where the API key comes from:
     *  - 'manual':  stored directly in `apiKey` (encryptedNative/protectedNative)
     *  - 'manager': `credentialIdApiKey` holds the ID of a credential in the central
     *               ioBroker store (`system.credentials.*`), resolved at runtime
     */
    credentialType: 'manual' | 'manager';
    apiKey: string;
    credentialIdApiKey: string;
    model: string;
    baseUrl: string;
    maxTokens: number;
    allowWriteStates: boolean;
    allowObjectChange: boolean;
    readObjects: 'devices' | 'all';
    allowReadLogs: boolean;
    allowWriteLogs: boolean;
    allowHistory: boolean;
    allowFiles: boolean;
    allowSystemInfo: boolean;
    /** Per-device read/write override, keyed by `room|name|type`. Absent → governed by the coarse toggles. */
    deviceAcl: Record<string, { read: boolean; write: boolean }>;
    systemPrompt: string;
}
