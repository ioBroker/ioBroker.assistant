import type { InProcessMcp } from '@iobroker/mcp-server';

/** An LLM-callable tool: name, description, JSON-schema parameters, and a runner. */
export interface Tool {
    name: string;
    description: string;
    /** JSON schema for the tool arguments. */
    parameters: Record<string, unknown>;
    run(args: Record<string, unknown>): Promise<unknown>;
}

/** Per-device read/write override, keyed by {@link deviceKey}. Absent → governed by the coarse toggles. */
export type DeviceAcl = Record<string, { read: boolean; write: boolean }>;

/** The access toggles from the adapter config that gate which MCP tools the LLM may use. */
export interface ToolAccess {
    allowWriteStates: boolean;
    allowObjectChange: boolean;
    readObjects: 'devices' | 'all';
    allowReadLogs: boolean;
    allowWriteLogs: boolean;
    allowHistory: boolean;
    allowFiles: boolean;
    allowSystemInfo: boolean;
    deviceAcl: DeviceAcl;
}

/** One `list_devices` device entry (as far as we care: its controls' state ids). */
export interface McpDeviceEntry {
    deviceName?: string;
    deviceType?: string;
    controls?: Record<string, { stateId?: string; writable?: boolean }>;
}

/** All control state ids of a `list_devices` device entry. */
export function deviceStateIds(dev: McpDeviceEntry): string[] {
    return Object.values(dev.controls || {})
        .map(c => c?.stateId)
        .filter((x): x is string => !!x);
}

/**
 * Stable per-device key used by both the backend write-guard and the admin ACL editor. Keyed by the
 * device's primary (lexicographically first) control state id — unique per device and independent of the
 * (often non-unique) type-detector name, so two "SET" controls no longer collide on one ACL entry.
 */
export function deviceKey(stateIds: string[]): string {
    return [...stateIds].sort()[0] || '';
}

type ToolCategory =
    | 'stateRead'
    | 'stateWrite'
    | 'devices'
    | 'objectReadAll'
    | 'logRead'
    | 'logWrite'
    | 'history'
    | 'files'
    | 'system'
    | 'objectChange';

/** Maps every known `@iobroker/mcp-server` tool to an access category. */
const TOOL_CATEGORY: Record<string, ToolCategory> = {
    get_states: 'stateRead',
    list_devices: 'devices',
    list_rooms: 'devices',
    list_functions: 'devices',
    set_state: 'stateWrite',
    set_states: 'stateWrite',
    get_object: 'objectReadAll',
    search_objects: 'objectReadAll',
    get_logs: 'logRead',
    write_log: 'logWrite',
    history_query: 'history',
    read_file: 'files',
    list_files: 'files',
    file_exists: 'files',
    system_info: 'system',
    list_hosts: 'system',
    list_instances: 'system',
    list_adapters: 'system',
    search_adapter_repository: 'system',
    ping_host: 'system',
    set_object: 'objectChange',
    delete_object: 'objectChange',
    create_state: 'objectChange',
    create_scene: 'objectChange',
    write_file: 'objectChange',
    delete_file: 'objectChange',
    rename_file: 'objectChange',
    mkdir: 'objectChange',
};

/**
 * Read-only, system-wide-scan tools whose results are stable enough to serve from a short-TTL cache.
 * Each of these runs the ioBroker type-detector over *all* objects (`list_devices` alone does five
 * full `getObjectView` scans), so repeat calls inside one conversation are the main avoidable cost.
 */
const CACHEABLE_TOOLS = new Set(['list_devices', 'list_rooms', 'list_functions']);

/** Default lifetime of a cached device/room/function listing (ms). */
export const LIST_CACHE_TTL_MS = 30_000;

/**
 * Tiny time-based cache: memoizes a tool result per (tool, args) for {@link ttlMs}. Not invalidated on
 * object changes — a freshly added device appears after at most one TTL, which is fine for an assistant.
 * Call {@link ListCache.clear} to force a refresh (e.g. from an `objectChange` subscription).
 */
export class ListCache {
    private readonly store = new Map<string, { at: number; val: string }>();

    constructor(
        private readonly ttlMs: number = LIST_CACHE_TTL_MS,
        private readonly now: () => number = Date.now,
    ) {}

    async run(key: string, produce: () => Promise<string>): Promise<string> {
        const hit = this.store.get(key);
        const now = this.now();
        if (hit && now - hit.at < this.ttlMs) {
            return hit.val;
        }
        const val = await produce();
        this.store.set(key, { at: now, val });
        return val;
    }

    clear(): void {
        this.store.clear();
    }
}

/** Decide whether a tool is allowed by the current access configuration. Unknown tools are denied. */
export function isToolAllowed(name: string, access: ToolAccess): boolean {
    switch (TOOL_CATEGORY[name]) {
        case 'stateRead':
        case 'devices':
            return true; // reading device/state values is always allowed
        case 'stateWrite':
            return access.allowWriteStates;
        case 'objectReadAll':
            return access.readObjects === 'all';
        case 'logRead':
            return access.allowReadLogs;
        case 'logWrite':
            return access.allowWriteLogs;
        case 'history':
            return access.allowHistory;
        case 'files':
            return access.allowFiles;
        case 'system':
            return access.allowSystemInfo;
        case 'objectChange':
            return access.allowObjectChange;
        default:
            return false; // unknown/unmapped tool → deny (safe default for an access list)
    }
}

/** Device types that default to write-disabled (must be explicitly allowed) for safety, e.g. door locks. */
const DEFAULT_WRITE_FALSE_TYPES = new Set(['lock']);

/**
 * Build the stateId → deviceKey map and the set of keys that default to write-disabled (e.g. locks),
 * from the MCP `list_devices` tool (best-effort; empty on any error).
 */
async function loadStateDeviceMap(
    mcp: InProcessMcp,
): Promise<{ stateToKey: Map<string, string>; defaultWriteFalse: Set<string> }> {
    const stateToKey = new Map<string, string>();
    const defaultWriteFalse = new Set<string>();
    try {
        const res = await mcp.callTool('list_devices', {});
        const parsed = JSON.parse(res.text) as {
            data?: { rooms?: { devicesInRoom?: McpDeviceEntry[] }[] };
        };
        for (const room of parsed.data?.rooms || []) {
            for (const dev of room.devicesInRoom || []) {
                const ids = deviceStateIds(dev);
                const key = deviceKey(ids);
                // Every control of the device shares the device's key, so the write-guard resolves any
                // of its states to the same ACL entry.
                for (const id of ids) {
                    stateToKey.set(id, key);
                }
                if (DEFAULT_WRITE_FALSE_TYPES.has(String(dev.deviceType ?? ''))) {
                    defaultWriteFalse.add(key);
                }
            }
        }
    } catch {
        /* no device map → no per-device enforcement */
    }
    return { stateToKey, defaultWriteFalse };
}

/** JSON shape of a `list_devices` result, for post-processing the device names the LLM sees. */
interface ListDevicesResult {
    data?: { rooms?: { devicesInRoom?: McpDeviceEntry[] }[] };
}

/** Device types dropped from `list_devices` so the LLM never treats them as controllable devices. */
const HIDDEN_LLM_TYPES = new Set(['button']);

/**
 * Post-process a `list_devices` result for the LLM: drop hidden types (write-only buttons) and devices
 * the user set to read-disabled (`acl[key].read === false`), and — when a resolver is given — rewrite
 * each `deviceName` to the friendly name (smartName → parent name). Original text on any parse problem.
 */
async function postProcessListDevices(
    text: string,
    acl: DeviceAcl,
    resolveName?: (stateId: string, fallback: string) => Promise<string>,
): Promise<string> {
    let parsed: ListDevicesResult;
    try {
        parsed = JSON.parse(text) as ListDevicesResult;
    } catch {
        return text;
    }
    const rooms = parsed.data?.rooms;
    if (!Array.isArray(rooms)) {
        return text;
    }
    for (const room of rooms) {
        const kept = (room.devicesInRoom || []).filter(d => {
            if (HIDDEN_LLM_TYPES.has(String(d.deviceType ?? ''))) {
                return false;
            }
            const key = deviceKey(deviceStateIds(d));
            return !(key && acl[key]?.read === false); // hide read-disabled devices from the LLM
        });
        const trimmed: McpDeviceEntry[] = [];
        for (const dev of kept) {
            const ids = deviceStateIds(dev);
            const name =
                resolveName && ids.length
                    ? (await resolveName(deviceKey(ids), String(dev.deviceName ?? ''))) || dev.deviceName
                    : dev.deviceName;
            // Keep only what the LLM needs to act (name/type + controlType→{stateId,writable}); drop the
            // verbose role/unit/min/max/ioBrokerValueType/friendlyDeviceNames to cut tokens & latency.
            const controls: Record<string, { stateId?: string; writable?: boolean }> = {};
            for (const [ct, c] of Object.entries(dev.controls || {})) {
                controls[ct] = { stateId: c?.stateId, writable: c?.writable };
            }
            trimmed.push({ deviceName: name, deviceType: dev.deviceType, controls });
        }
        room.devicesInRoom = trimmed;
    }
    return JSON.stringify(parsed);
}

/** Wrap `get_states` so it drops values of devices the user set to read-disabled. */
function guardRead(
    baseRun: (args: Record<string, unknown>) => Promise<unknown>,
    stateToKey: Map<string, string>,
    acl: DeviceAcl,
): (args: Record<string, unknown>) => Promise<unknown> {
    return async (args: Record<string, unknown>): Promise<unknown> => {
        const text = (await baseRun(args)) as string;
        let parsed: { data?: { states?: { id?: string }[] } };
        try {
            parsed = JSON.parse(text) as { data?: { states?: { id?: string }[] } };
        } catch {
            return text;
        }
        const states = parsed.data?.states;
        if (Array.isArray(states) && parsed.data) {
            parsed.data.states = states.filter(s => {
                const key = s?.id ? stateToKey.get(s.id) : undefined;
                return !(key && acl[key]?.read === false);
            });
        }
        return JSON.stringify(parsed);
    };
}

/**
 * Wrap a state-writing tool so it refuses writes to states of devices the user marked read-only.
 * Write is allowed when the explicit ACL entry says so; without an entry, the device type's default
 * applies (write-disabled for {@link DEFAULT_WRITE_FALSE_TYPES} like locks, allowed otherwise).
 */
function guardWrite(
    name: string,
    baseRun: (args: Record<string, unknown>) => Promise<unknown>,
    stateToKey: Map<string, string>,
    acl: DeviceAcl,
    defaultWriteFalse: Set<string>,
): (args: Record<string, unknown>) => Promise<unknown> {
    return async (args: Record<string, unknown>): Promise<unknown> => {
        const ids =
            name === 'set_states'
                ? ((args.states as { id?: string }[] | undefined) || []).map(s => s?.id).filter((x): x is string => !!x)
                : typeof args.id === 'string'
                  ? [args.id]
                  : [];
        for (const id of ids) {
            const key = stateToKey.get(id);
            if (!key) {
                continue;
            }
            const entry = acl[key];
            const writeAllowed = entry ? entry.write !== false : !defaultWriteFalse.has(key);
            if (!writeAllowed) {
                return JSON.stringify({
                    ok: false,
                    error: `Writing "${id}" is not allowed: device "${key}" is read-only in the assistant settings.`,
                });
            }
        }
        return baseRun(args);
    };
}

/**
 * Build the LLM tool set from the in-process ioBroker MCP server, filtered by the access config and
 * enforcing the per-device write ACL.
 *
 * All tools come from `@iobroker/mcp-server` — nothing is duplicated here. Gating layers:
 *  1. `createInProcessMcp({ allowSetState, allowObjectChange })` — which tools exist at all.
 *  2. `isToolAllowed()` — fine-grained category toggles (logs/history/files/object-read scope/…).
 *  3. `guardWrite()` — per-device write ACL (`access.deviceAcl`), e.g. keep a lock read-only.
 */
export async function buildMcpTools(
    mcp: InProcessMcp,
    access: ToolAccess,
    cache: ListCache = new ListCache(),
    resolveName?: (stateId: string, fallback: string) => Promise<string>,
): Promise<{ tools: Tool[]; denied: string[]; cache: ListCache }> {
    const infos = await mcp.listTools();
    const acl = access.deviceAcl || {};
    // Write guard: whenever writing is enabled (explicit ACL + type defaults like locks).
    const enforceWrite = access.allowWriteStates;
    // Read guard: whenever any device is set read-disabled (hide it from list_devices + get_states).
    const enforceRead = Object.values(acl).some(a => a && a.read === false);
    const { stateToKey, defaultWriteFalse } =
        enforceWrite || enforceRead
            ? await loadStateDeviceMap(mcp)
            : { stateToKey: new Map<string, string>(), defaultWriteFalse: new Set<string>() };

    const tools: Tool[] = [];
    const denied: string[] = [];
    for (const info of infos) {
        if (!isToolAllowed(info.name, access)) {
            denied.push(info.name);
            continue;
        }
        const callTool = async (args: Record<string, unknown>): Promise<string> => {
            const text = (await mcp.callTool(info.name, args)).text;
            // For the LLM: drop buttons + read-disabled devices, and use friendly names.
            return info.name === 'list_devices' ? postProcessListDevices(text, acl, resolveName) : text;
        };
        // Serve stable, expensive read-only listings from the short-TTL cache; everything else runs live.
        const baseRun: (args: Record<string, unknown>) => Promise<unknown> = CACHEABLE_TOOLS.has(info.name)
            ? (args): Promise<string> => cache.run(`${info.name}:${JSON.stringify(args ?? {})}`, () => callTool(args))
            : callTool;
        let run = baseRun;
        if (enforceWrite && (info.name === 'set_state' || info.name === 'set_states')) {
            run = guardWrite(info.name, baseRun, stateToKey, acl, defaultWriteFalse);
        } else if (enforceRead && info.name === 'get_states') {
            run = guardRead(baseRun, stateToKey, acl);
        }
        tools.push({ name: info.name, description: info.description || '', parameters: info.inputSchema, run });
    }

    // Synthetic (non-MCP) tool: lets the model bust the device/room cache and re-scan. Useful when a
    // device the user mentions is missing from list_devices (stale cache) or was just added/renamed.
    tools.push({
        name: 'refresh_device_cache',
        description:
            'Clear the cached device, room and function listings so the next list_devices, list_rooms or list_functions call performs a fresh scan. Call this when a device or room the user mentions is not in the list, or when the user says a device was just added, renamed or reassigned, then retry.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: (): Promise<string> => {
            cache.clear();
            return Promise.resolve(JSON.stringify({ ok: true, data: { cleared: true } }));
        },
    });

    return { tools, denied, cache };
}
