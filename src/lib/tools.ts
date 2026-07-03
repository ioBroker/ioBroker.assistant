/**
 * Tools the LLM can call. Each is backed by the native ioBroker adapter API,
 * so the assistant can read and control ANY state — no virtual-device tree,
 * no rule-based NLU. The LLM decides which tool to use.
 */
import type { AdapterConfig } from '../types';

export interface Tool {
    name: string;
    description: string;
    /** JSON schema for the tool arguments. */
    parameters: Record<string, unknown>;
    run(args: Record<string, unknown>): Promise<unknown>;
}

export function createTools(adapter: ioBroker.Adapter, config: AdapterConfig): Tool[] {
    return [
        {
            name: 'list_rooms',
            description: 'List all rooms defined in ioBroker (enum.rooms) with their member object ids.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            run: async () => listEnum(adapter, 'rooms'),
        },
        {
            name: 'list_functions',
            description:
                'List all functions/categories in ioBroker (enum.functions), e.g. light, heating, blinds, with their member object ids.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            run: async () => listEnum(adapter, 'functions'),
        },
        {
            name: 'find_states',
            description:
                'Find ioBroker states, optionally filtered by room and/or function (enum) and/or a text query on id/name. ' +
                'Returns id, name, current value, unit, role and writable flag. Use this to answer questions about devices and sensors.',
            parameters: {
                type: 'object',
                properties: {
                    room: { type: 'string', description: 'room enum id or name substring (optional)' },
                    func: {
                        type: 'string',
                        description: 'function enum id or name substring, e.g. "light" (optional)',
                    },
                    query: { type: 'string', description: 'substring to match in the state id or name (optional)' },
                },
                additionalProperties: false,
            },
            run: async args => findStates(adapter, args),
        },
        {
            name: 'get_state',
            description: 'Read the current value of a specific ioBroker state id.',
            parameters: {
                type: 'object',
                properties: { id: { type: 'string' } },
                required: ['id'],
                additionalProperties: false,
            },
            run: async args => {
                const id = String(args.id);
                const st = await adapter.getForeignStateAsync(id);
                return { id, value: st ? st.val : null, ack: st ? st.ack : null, ts: st ? st.ts : null };
            },
        },
        {
            name: 'set_state',
            description:
                'Control an ioBroker state (writes with ack=false, i.e. a command to a device). Only use for actual device control.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    value: { description: 'boolean | number | string' },
                },
                required: ['id', 'value'],
                additionalProperties: false,
            },
            run: async args => {
                if (!config.allowControl) {
                    return { ok: false, error: 'controlling states is disabled in the adapter settings' };
                }
                const id = String(args.id);
                await adapter.setForeignStateAsync(id, args.value as ioBroker.StateValue, false);
                return { ok: true, id, value: args.value };
            },
        },
    ];
}

// ── helpers ─────────────────────────────────────────────────────────────────

interface EnumInfo {
    id: string;
    name: string;
    members: string[];
}

function nameOf(obj: ioBroker.AnyObject | null | undefined): string {
    const n = obj?.common?.name;
    if (!n) {
        return '';
    }
    if (typeof n === 'string') {
        return n;
    }
    return n.en || n.de || Object.values(n)[0] || '';
}

async function listEnum(adapter: ioBroker.Adapter, kind: 'rooms' | 'functions'): Promise<EnumInfo[]> {
    const objs = await adapter.getForeignObjectsAsync(`enum.${kind}.*`, 'enum');
    return Object.entries(objs).map(([id, e]) => ({
        id,
        name: nameOf(e),
        members: (e.common.members as string[]) || [],
    }));
}

async function membersFor(adapter: ioBroker.Adapter, kind: 'rooms' | 'functions', needle: string): Promise<string[]> {
    const objs = await adapter.getForeignObjectsAsync(`enum.${kind}.*`, 'enum');
    const nl = needle.toLowerCase();
    const set = new Set<string>();
    for (const [id, e] of Object.entries(objs)) {
        if (id.toLowerCase().includes(nl) || nameOf(e).toLowerCase().includes(nl)) {
            for (const m of (e.common.members as string[]) || []) {
                set.add(m);
            }
        }
    }
    return [...set];
}

interface StateInfo {
    id: string;
    name: string;
    value: ioBroker.StateValue | null;
    unit?: string;
    role?: string;
    writable: boolean;
}

async function findStates(
    adapter: ioBroker.Adapter,
    { room, func, query }: { room?: string; func?: string; query?: string },
): Promise<StateInfo[]> {
    let ids: string[] | null = null;
    if (room) {
        ids = await membersFor(adapter, 'rooms', room);
    }
    if (func) {
        const f = await membersFor(adapter, 'functions', func);
        ids = ids ? ids.filter(id => f.includes(id)) : f;
    }

    let objects: Record<string, ioBroker.Object>;
    if (ids) {
        objects = {};
        for (const id of ids) {
            const o = await adapter.getForeignObjectAsync(id);
            if (o) {
                objects[id] = o;
            }
        }
    } else {
        objects = await adapter.getForeignObjectsAsync(query ? `*${query}*` : '*', 'state');
    }

    const out: StateInfo[] = [];
    const q = query ? query.toLowerCase() : '';
    for (const [id, o] of Object.entries(objects)) {
        if (!o || o.type !== 'state') {
            continue;
        }
        if (q && !(id.toLowerCase().includes(q) || nameOf(o).toLowerCase().includes(q))) {
            continue;
        }
        const st = await adapter.getForeignStateAsync(id);
        out.push({
            id,
            name: nameOf(o),
            value: st ? st.val : null,
            unit: o.common?.unit,
            role: o.common?.role,
            writable: !!o.common?.write,
        });
        if (out.length >= 60) {
            break;
        } // keep the payload small for the LLM context
    }
    return out;
}
