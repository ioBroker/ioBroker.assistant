export interface AdapterConfig {
    provider: 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'custom';
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
    /** Per-device read/write override, keyed by the device's primary state id. Absent → coarse toggles. */
    deviceAcl: Record<string, { read: boolean; write: boolean }>;
    systemPrompt: string;
    /** Tier-0: try the built-in rule-based NLU before the LLM (fast, offline, free) for simple commands. */
    useLocalNlu: boolean;
    /** Tier-1a: use an on-demand-installed local LLM (node-llama-cpp) between NLU and the cloud LLM. */
    useLocalLlm: boolean;
    /** Direct URL of the GGUF model for the local LLM ('' → built-in default, Qwen2.5-1.5B). */
    localLlmModelUrl: string;

    // ── Voice / satellites (V1: cloud STT/TTS via OpenAI) ───────────────────────
    /** Start the UDP voice server for satellites (Hannah-compatible protocol). */
    voiceEnabled: boolean;
    /**
     * UDP port the voice server binds to (satellites send audio/control here). Named `port` so the
     * admin's "port in use" check picks it up.
     */
    port: number;
    /**
     * Interface the voice server binds to ('0.0.0.0' = all interfaces, or a specific host IP). Named
     * `bind` for the same admin convention.
     */
    bind: string;
    /** Also expose a Wyoming TCP endpoint (HA Voice PE / wyoming-satellite / ESPHome voice). */
    wyomingEnabled: boolean;
    /** TCP port for the Wyoming endpoint (default 10700). */
    wyomingPort: number;
    /** Global voice language (ISO-639-1, '' = adapter/system language). Drives STT hint + TTS. */
    voiceLanguage: string;
    /** Dedicated OpenAI key for STT/TTS; empty → reuse the main key when provider === 'openai'. */
    voiceApiKey: string;
    /** OpenAI TTS voice id (alloy/echo/fable/onyx/nova/shimmer). */
    ttsVoice: string;
    /** OpenAI STT model ('' → 'whisper-1'; e.g. 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'). */
    sttModel: string;
    /** OpenAI TTS model ('' → 'tts-1'; e.g. 'gpt-4o-mini-tts', 'tts-1-hd'). */
    ttsModel: string;

    /** Speech provider for recognition / synthesis (independently selectable). Vosk/Piper run locally. */
    sttProvider: 'openai' | 'azure' | 'aws' | 'vosk';
    ttsProvider: 'openai' | 'azure' | 'aws' | 'piper';
    /** Azure Speech subscription key + region (used when a provider is 'azure'). */
    azureSpeechKey: string;
    azureSpeechRegion: string;
    /** Azure TTS voice name, e.g. 'de-DE-KatjaNeural' ('' → pick by language). */
    azureVoice: string;
    /** AWS credentials + region (used when a provider is 'aws'). */
    awsAccessKeyId: string;
    awsSecretAccessKey: string;
    awsRegion: string;
    /** AWS Polly voice id, e.g. 'Vicki' ('' → default per language). */
    awsVoice: string;

    /** Local Vosk model name/dir ('' → small default per language, auto-downloaded). */
    voskModel: string;
    /** Local Piper voice name, e.g. 'de_DE-thorsten-medium' ('' → default per language). */
    piperVoice: string;

    /**
     * Where the speech credentials come from:
     *  - 'manual':  the encrypted key/region fields above
     *  - 'manager': the central credential store, picked via the *CredentialId fields below
     */
    voiceCredentialType: 'manual' | 'manager';
    /** Store credential id (type 'ai') for OpenAI speech (manager mode). values: { key }. */
    voiceCredentialId: string;
    /** Store credential id (type 'azure') for Azure speech (manager mode). values: { key, region }. */
    azureCredentialId: string;
    /** Store credential id (type 'aws') for AWS speech (manager mode). values: { accessKeyId, secretAccessKey, region }. */
    awsCredentialId: string;
}
