/** A detected device as delivered by the adapter's `getDevices` sendTo command. */
export interface DeviceInfo {
    key: string;
    name: string;
    /** Raw `common.smartName`: legacy string, per-language map, or null. */
    smartName?: string | Record<string, string> | null;
    /** Language-independent fallback name (parent/detector) shown when no smartName exists. */
    autoName?: string;
    type: string;
    room: string;
    stateIds: string[];
    writableStateIds: string[];
}

/** Result of resolving a device's name for a specific editing language. */
export interface ResolvedName {
    /** The value to show in the field. */
    value: string;
    /** True if `value` is exactly the smartName in the requested language. */
    exact: boolean;
    /** Where `value` came from: a language code, 'auto' (parent name), or '' (legacy string). */
    from: string;
}

/** The subset of the adapter config the ACL editor reads/writes. */
export interface AssistantAdapterConfig {
    deviceAcl?: Record<string, { read: boolean; write: boolean }>;
    [key: string]: unknown;
}
