/**
 * Routines — a phrase that runs a list of actions. "Gute Nacht" switches off five things and locks the
 * door; "Filmabend" dims the living room and closes the blinds.
 *
 * Deliberately **not** the LLM's job: a routine is a fixed macro the user wrote down, so matching it has
 * to be deterministic, instant and free. It also has to beat the rule-based NLU, which would otherwise
 * find the word "Licht" in "Gute Nacht, Licht aus bitte" and do only half of it.
 *
 * The actions are {@link TriggerAction}s, the same shape the proactive triggers use, so both share one
 * executor in the adapter — a routine is simply a trigger whose condition is a spoken phrase.
 *
 * Ported from the Python original (`C:\iot\Hannah`, `core/hannah/routines.py`), whose matching rule
 * (normalise, then look for the phrase anywhere in the utterance) is kept: people say "mach mal Gute
 * Nacht", not just "Gute Nacht".
 */
import type { TriggerAction } from './triggers';

/** One routine. */
export interface Routine {
    name: string;
    /** Phrases that trigger it, already normalised (see {@link normalizePhrase}). */
    phrases: string[];
    actions: TriggerAction[];
    /** What to answer. Empty = answer nothing (the confirmation tone, if enabled, still plays). */
    reply: string;
}

/** One row of the settings table (everything arrives as text). */
export interface RoutineRow {
    name?: string;
    phrases?: string;
    actions?: TriggerAction[] | string;
    reply?: string;
}

/**
 * Fold a phrase to what matching compares: lower case, umlauts spelled out, punctuation gone, single
 * spaces. "Gute Nacht!" and "gute nacht" are the same thing, and so are "Büro" and "Buero" — people type
 * one and say the other.
 */
export function normalizePhrase(text: unknown): string {
    if (typeof text !== 'string') {
        return '';
    }
    return text
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

/** Split the phrase column: one per line, or comma/semicolon separated. */
export function splitPhrases(phrases: unknown): string[] {
    if (Array.isArray(phrases)) {
        return phrases.map(p => normalizePhrase(p)).filter(Boolean);
    }
    if (typeof phrases !== 'string') {
        return [];
    }
    return phrases
        .split(/[\r\n,;]+/)
        .map(p => normalizePhrase(p))
        .filter(Boolean);
}

/**
 * Turn settings-table rows into routines. The action column is JSON, parsed here so a typo surfaces as
 * one warning instead of a routine that quietly does nothing; a row without phrases or without anything
 * to do is skipped.
 */
export function parseRoutineRows(
    rows: RoutineRow[] | undefined,
    opts: { warn?: (message: string) => void } = {},
): Routine[] {
    const out: Routine[] = [];
    for (const row of rows || []) {
        const name = String(row?.name ?? '').trim();
        const phrases = splitPhrases(row?.phrases);
        if (!phrases.length) {
            continue;
        }
        let actions: TriggerAction[] = [];
        const raw = row?.actions;
        if (Array.isArray(raw)) {
            actions = raw;
        } else if (typeof raw === 'string' && raw.trim()) {
            try {
                const parsed: unknown = JSON.parse(raw);
                actions = Array.isArray(parsed) ? (parsed as TriggerAction[]) : [];
            } catch (e) {
                opts.warn?.(
                    `routine '${name || phrases[0]}': actions is not valid JSON (${(e as Error).message}) — skipped`,
                );
                continue;
            }
        }
        actions = actions.filter(a => a && (a.say || a.setState));
        const reply = String(row?.reply ?? '').trim();
        if (!actions.length && !reply) {
            opts.warn?.(`routine '${name || phrases[0]}': nothing to do (no actions, no reply) — skipped`);
            continue;
        }
        out.push({ name: name || phrases[0], phrases, actions, reply });
    }
    return out;
}

/**
 * Find the routine an utterance triggers, or null. The **longest** matching phrase wins, so a specific
 * "gute nacht alle" beats a general "gute nacht" instead of depending on the table's order.
 */
export function matchRoutine(text: string, routines: Routine[]): Routine | null {
    const haystack = normalizePhrase(text);
    if (!haystack) {
        return null;
    }
    let best: Routine | null = null;
    let bestLength = 0;
    for (const routine of routines) {
        for (const phrase of routine.phrases) {
            if (phrase.length > bestLength && contains(haystack, phrase)) {
                best = routine;
                bestLength = phrase.length;
            }
        }
    }
    return best;
}

/** Whole-word containment: "licht" must not match "lichtschalter" and turn a question into a macro. */
function contains(haystack: string, phrase: string): boolean {
    let from = 0;
    for (;;) {
        const at = haystack.indexOf(phrase, from);
        if (at < 0) {
            return false;
        }
        const before = at === 0 || haystack[at - 1] === ' ';
        const afterIndex = at + phrase.length;
        const after = afterIndex === haystack.length || haystack[afterIndex] === ' ';
        if (before && after) {
            return true;
        }
        from = at + 1;
    }
}
