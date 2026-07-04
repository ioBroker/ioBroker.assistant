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

/** Stable key for a detected device across backend enforcement and the admin ACL editor. */
export function deviceKey(room: string, name: string, type: string): string {
    return `${room}|${name}|${type}`;
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

/** Build stateId -> deviceKey map from the MCP `list_devices` tool (best-effort; empty on any error). */
async function loadStateDeviceMap(mcp: InProcessMcp): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
        const res = await mcp.callTool('list_devices', {});
        const parsed = JSON.parse(res.text) as {
            data?: { rooms?: { roomName: string; devicesInRoom?: { deviceName?: string; deviceType?: string; controls?: Record<string, { stateId?: string }> }[] }[] };
        };
        for (const room of parsed.data?.rooms || []) {
            for (const dev of room.devicesInRoom || []) {
                const key = deviceKey(room.roomName, String(dev.deviceName ?? ''), String(dev.deviceType ?? ''));
                for (const control of Object.values(dev.controls || {})) {
                    if (control?.stateId) {
                        map.set(control.stateId, key);
                    }
                }
            }
        }
    } catch {
        /* no device map → no per-device enforcement */
    }
    return map;
}

/** Wrap a state-writing tool so it refuses writes to states of devices the user marked read-only. */
function guardWrite(
    name: string,
    baseRun: (args: Record<string, unknown>) => Promise<unknown>,
    stateToKey: Map<string, string>,
    acl: DeviceAcl,
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
            if (key && acl[key]?.write === false) {
                return JSON.stringify({
                    ok: false,
                    error: `Writing "${id}" is not allowed: device "${key}" is set to read-only in the assistant settings.`,
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
export async function buildMcpTools(mcp: InProcessMcp, access: ToolAccess): Promise<{ tools: Tool[]; denied: string[] }> {
    const infos = await mcp.listTools();
    const acl = access.deviceAcl || {};
    const aclActive = access.allowWriteStates && Object.values(acl).some(a => a && a.write === false);
    const stateToKey = aclActive ? await loadStateDeviceMap(mcp) : new Map<string, string>();

    const tools: Tool[] = [];
    const denied: string[] = [];
    for (const info of infos) {
        if (!isToolAllowed(info.name, access)) {
            denied.push(info.name);
            continue;
        }
        const baseRun = async (args: Record<string, unknown>): Promise<unknown> => (await mcp.callTool(info.name, args)).text;
        const run =
            aclActive && (info.name === 'set_state' || info.name === 'set_states')
                ? guardWrite(info.name, baseRun, stateToKey, acl)
                : baseRun;
        tools.push({ name: info.name, description: info.description || '', parameters: info.inputSchema, run });
    }
    return { tools, denied };
}
