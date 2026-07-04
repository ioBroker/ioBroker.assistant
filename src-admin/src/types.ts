/** A detected device as delivered by the adapter's `getDevices` sendTo command. */
export interface DeviceInfo {
    key: string;
    name: string;
    type: string;
    room: string;
    stateIds: string[];
    writableStateIds: string[];
}

/** The subset of the adapter config the ACL editor reads/writes. */
export interface AssistantAdapterConfig {
    deviceAcl?: Record<string, { read: boolean; write: boolean }>;
    [key: string]: unknown;
}
