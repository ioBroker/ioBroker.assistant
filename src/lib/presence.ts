/**
 * Who is at home — the context that makes the difference between a useful answer and a silly one
 * ("switch off everything" vs. announcing into an empty flat).
 *
 * Deliberately **not** tied to one adapter: presence lives in a different place in every installation
 * (the `residents` adapter, a `ping.0.<phone>.alive`, a UniFi/Fritz!Box client state, a `0_userdata` flag),
 * and ioBroker has no standard device type for it — `@iobroker/type-detector` knows `motion` and
 * `location`, but no `presence`. So the user points at the states they already have and names the person,
 * exactly like `weatherInstance` lets them pick their weather source.
 *
 * Presence values are installation-specific too, so {@link interpretHome} understands the common forms and
 * every entry can override the value that means "home". The numeric default (`1`) follows the Python
 * original (`C:\iot\Hannah`, `core/hannah/residents/Resident.py`, `HOME_PRESENCE_STATE = 1`), which had the
 * same problem; there it was a global config option, here it is per entry, because one household can mix a
 * boolean phone ping with a numeric residents state.
 */

/** What kind of presence an entry tracks. Pets never count towards "is anyone home". */
export type PresenceKind = 'person' | 'guest' | 'pet';

/** One configured presence source. */
export interface PresenceEntry {
    /** State id that tells whether this person is at home. */
    id: string;
    /** Display name, used in the spoken context and the states. */
    name: string;
    kind: PresenceKind;
    /** Value that means "home" ('' = recognise the usual forms, see {@link interpretHome}). */
    homeValue?: string;
}

/** A configured source plus what we currently know about it. */
export interface PresenceInfo extends PresenceEntry {
    /** true = home, false = away, null = not read yet / value not understood. */
    home: boolean | null;
}

/** One row of the settings table (everything arrives as text). */
export interface PresenceRow {
    id?: string;
    name?: string;
    kind?: string;
    homeValue?: string;
}

const KINDS: PresenceKind[] = ['person', 'guest', 'pet'];

/** Words that mean "at home" in a string state (de/en/ru), beyond the obvious `true`/`1`. */
const HOME_WORDS = new Set(['home', 'present', 'yes', 'true', '1', 'da', 'zuhause', 'anwesend', 'дома']);
/** Words that mean "away". Anything else leaves the presence unknown rather than guessing. */
const AWAY_WORDS = new Set(['away', 'absent', 'no', 'false', '0', 'weg', 'abwesend', 'нет', 'не дома']);

/**
 * Is this value "at home"? Returns null when we cannot tell — an unknown value must not be read as "away",
 * because that would quietly announce someone's absence we never established.
 */
export function interpretHome(value: unknown, homeValue?: string): boolean | null {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    // Only a scalar can mean presence; a state holding an object tells us nothing (and stringifying it
    // would compare against "[object Object]").
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        return null;
    }
    const wanted = (homeValue || '').trim();
    if (wanted) {
        // An explicit mapping wins and is compared loosely: a state may hold 1 where the config says "1".
        return String(value).trim().toLowerCase() === wanted.toLowerCase();
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return value === 1; // see the module header
    }
    const v = value.trim().toLowerCase();
    if (HOME_WORDS.has(v)) {
        return true;
    }
    if (AWAY_WORDS.has(v)) {
        return false;
    }
    return null;
}

/** Turn settings-table rows into entries: trimmed, with a valid kind, skipping rows without a state id. */
export function parsePresenceRows(rows: PresenceRow[] | undefined): PresenceEntry[] {
    const out: PresenceEntry[] = [];
    const seen = new Set<string>();
    for (const row of rows || []) {
        const id = String(row?.id ?? '').trim();
        if (!id || seen.has(id)) {
            continue; // an empty row is just empty; the same state twice would double-count the person
        }
        seen.add(id);
        const kind = String(row.kind ?? '')
            .trim()
            .toLowerCase();
        out.push({
            id,
            name: String(row.name ?? '').trim() || id.split('.').pop() || id,
            kind: (KINDS as string[]).includes(kind) ? (kind as PresenceKind) : 'person',
            homeValue: String(row.homeValue ?? '').trim(),
        });
    }
    return out;
}

export interface PresenceTrackerOptions {
    entries: PresenceEntry[];
    /** Someone came home (fired on the transition, never on the first value we read). */
    onArrival?: (who: PresenceInfo) => void;
    /** Someone left. */
    onDeparture?: (who: PresenceInfo) => void;
    /** Any change, for the state mirror. */
    onChange?: (list: PresenceInfo[]) => void;
    log?: Pick<ioBroker.Log, 'debug' | 'info' | 'warn'>;
}

/** Tracks who is at home, from the configured states. */
export class PresenceTracker {
    private readonly people = new Map<string, PresenceInfo>();

    constructor(private readonly opts: PresenceTrackerOptions) {
        for (const entry of opts.entries) {
            this.people.set(entry.id, { ...entry, home: null });
        }
    }

    /** The state ids to subscribe to. */
    stateIds(): string[] {
        return [...this.people.keys()];
    }

    /**
     * Feed a state value in. Returns what happened, so the caller can announce it — `null` for "nothing
     * changed", which also covers the very first value of a state: there is no previous state to compare
     * against, and greeting someone on every adapter restart would be worse than staying quiet.
     */
    update(id: string, value: unknown): 'arrived' | 'left' | null {
        const who = this.people.get(id);
        if (!who) {
            return null;
        }
        const before = who.home;
        const now = interpretHome(value, who.homeValue);
        if (now === before) {
            return null;
        }
        who.home = now;
        this.opts.onChange?.(this.list());
        if (before === null || now === null) {
            this.opts.log?.debug(`presence: ${who.name} is now ${now === null ? 'unknown' : now ? 'home' : 'away'}`);
            return null;
        }
        const event = now ? 'arrived' : 'left';
        this.opts.log?.info(`presence: ${who.name} ${now ? 'came home' : 'left'}`);
        try {
            (now ? this.opts.onArrival : this.opts.onDeparture)?.({ ...who });
        } catch (e) {
            this.opts.log?.warn(`presence callback failed: ${(e as Error).message}`);
        }
        return event;
    }

    /** Everyone configured, in configuration order. */
    list(): PresenceInfo[] {
        return [...this.people.values()].map(p => ({ ...p }));
    }

    /** Those known to be at home (pets included — filter by `kind` if that matters). */
    home(): PresenceInfo[] {
        return this.list().filter(p => p.home === true);
    }

    /** Those known to be away (an unknown presence is neither home nor away). */
    away(): PresenceInfo[] {
        return this.list().filter(p => p.home === false);
    }

    /**
     * Is a human at home? Pets do not count — the point of this flag is whether an announcement would
     * reach anybody, and the cat will not pass it on. With nothing configured it is `false`, so a caller
     * must treat "no presence configured" as "do not gate" rather than "nobody home".
     */
    anyoneHome(): boolean {
        return this.list().some(p => p.home === true && p.kind !== 'pet');
    }

    /** Whether any presence source is configured at all. */
    get configured(): boolean {
        return this.people.size > 0;
    }
}

/**
 * One line for the LLM: who is home and who is not, localized (de/en/ru). Empty when nothing is known
 * yet — an empty list would otherwise read like "nobody is home", which is a different statement.
 *
 * Goes into the user turn, never into the (prompt-cached) system prompt: it changes with every arrival.
 */
export function buildPresencePrompt(list: PresenceInfo[], lang: string): string {
    const l = lang === 'ru' ? 'ru' : lang === 'de' ? 'de' : 'en';
    const label = (p: PresenceInfo): string => {
        if (p.kind === 'guest') {
            return `${p.name} (${l === 'ru' ? 'гость' : l === 'de' ? 'Gast' : 'guest'})`;
        }
        if (p.kind === 'pet') {
            return `${p.name} (${l === 'ru' ? 'питомец' : l === 'de' ? 'Haustier' : 'pet'})`;
        }
        return p.name;
    };
    const home = list.filter(p => p.home === true).map(label);
    const away = list.filter(p => p.home === false).map(label);
    if (!home.length && !away.length) {
        return '';
    }
    const parts: string[] = [];
    if (home.length) {
        parts.push(`${l === 'ru' ? 'Дома' : l === 'de' ? 'Zuhause' : 'At home'}: ${home.join(', ')}`);
    } else {
        parts.push(l === 'ru' ? 'Дома никого нет' : l === 'de' ? 'Niemand ist zuhause' : 'Nobody is at home');
    }
    if (away.length) {
        parts.push(`${l === 'ru' ? 'нет дома' : l === 'de' ? 'nicht zuhause' : 'away'}: ${away.join(', ')}`);
    }
    return `${parts.join('; ')}.`;
}
