/**
 * Named announcement targets — groups of rooms ("upstairs") and people ("Denis").
 *
 * Both are the same thing mechanically: a name standing for a set of satellites. A group is "every
 * speaker up there", a person is "every speaker that is mine" — so one table serves both, and `kind` only
 * exists to tell the LLM whether a name is a place or a human ("tell Denis dinner is ready" has to reach
 * his speakers, not the kitchen).
 *
 * Ported from the Python original (`C:\iot\Hannah`, `core/main.py:717` `_resolve_targets`), including the
 * resolution order that matters: a real satellite or room wins over a group of the same name, so a
 * speaker can never be made unreachable by naming a group after it.
 */

/** What a name stands for. Only used to describe the target to the LLM. */
export type TargetKind = 'group' | 'person';

/** One named target. */
export interface TargetGroup {
    name: string;
    /** Satellite state ids, room names or device names. Resolved by the caller, which knows the satellites. */
    members: string[];
    kind: TargetKind;
}

/** One row of the settings table (everything arrives as text). */
export interface TargetRow {
    name?: string;
    members?: string;
    kind?: string;
}

/** Split a member list as typed into the table: comma or semicolon separated, blanks dropped. */
export function splitMembers(members: unknown): string[] {
    if (Array.isArray(members)) {
        return members.map(m => String(m).trim()).filter(Boolean);
    }
    if (typeof members !== 'string') {
        return []; // a structured value is not a member list, and stringifying it would read "[object Object]"
    }
    return members
        .split(/[,;]/)
        .map(m => m.trim())
        .filter(Boolean);
}

/** Turn settings-table rows into named targets; rows without a name or without members are skipped. */
export function parseTargetRows(rows: TargetRow[] | undefined): TargetGroup[] {
    const out: TargetGroup[] = [];
    const seen = new Set<string>();
    for (const row of rows || []) {
        const name = String(row?.name ?? '').trim();
        const members = splitMembers(row?.members);
        if (!name || !members.length) {
            continue; // half-filled row: nothing to resolve, and an empty group would silently match
        }
        const key = name.toLowerCase();
        if (seen.has(key)) {
            continue; // first definition wins, so a duplicate cannot shadow it
        }
        seen.add(key);
        out.push({
            name,
            members,
            kind:
                String(row.kind ?? '')
                    .trim()
                    .toLowerCase() === 'person'
                    ? 'person'
                    : 'group',
        });
    }
    return out;
}

/** Find a named target, ignoring case and surrounding space (people type "denis", not "Denis"). */
export function findTarget(name: string, groups: TargetGroup[]): TargetGroup | null {
    const wanted = String(name ?? '')
        .trim()
        .toLowerCase();
    if (!wanted) {
        return null;
    }
    return groups.find(g => g.name.toLowerCase() === wanted) ?? null;
}

/** True for the name that means "every satellite" (`all`, or nothing at all). */
export function isBroadcast(name: string | null | undefined): boolean {
    const v = String(name ?? '')
        .trim()
        .toLowerCase();
    return v === '' || v === 'all';
}

/**
 * One line naming the configured targets, for the `announce` tool description — without it the model has
 * no way of knowing that "Denis" is a valid target. Empty when nothing is configured.
 */
export function describeTargets(groups: TargetGroup[]): string {
    if (!groups.length) {
        return '';
    }
    const people = groups.filter(g => g.kind === 'person').map(g => g.name);
    const rooms = groups.filter(g => g.kind === 'group').map(g => g.name);
    const parts: string[] = [];
    if (people.length) {
        parts.push(`people: ${people.join(', ')}`);
    }
    if (rooms.length) {
        parts.push(`groups: ${rooms.join(', ')}`);
    }
    return parts.join('; ');
}
