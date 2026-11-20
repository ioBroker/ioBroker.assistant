/**
 * "Zeig Unterdeck" for the 3D floor plan of ioBroker.home3d: every open 3D view flies to a floor, a room or a device
 * when `home3d.N.show` is written with its name, and confirms with ack and the name it shows. `home3d.N.places`,
 * written by an open 3D view, lists the names it knows: `{"floors": {floor: [rooms]}, "devices": [{"name", "room"}]}`.
 *
 * The rule takes a sentence only when what follows the verb is one of those names (or the whole house), so
 * "zeig das Video …", "zeig mir die Temperatur" and everything else go on to the other tiers as before.
 */
import { fold, sameWord, similarName } from './youtube';

/** A name the 3D view knows. */
export interface Home3dPlace {
    name: string;
    kind: 'floor' | 'room' | 'device';
}

/** What to show: `target` is written to `home3d.N.show`. */
export interface ShowCommand {
    target: string;
    kind: Home3dPlace['kind'] | 'house';
}

/** What the 3D view understands as the whole house. */
export const HOUSE_TARGET = 'Haus';

/** The verbs and the language they are said in: the answer comes in it ("Zeige Unterdeck" on a Russian system). */
const VERB_LANGUAGE: Record<string, string> = {
    zeig: 'de',
    zeige: 'de',
    zeigen: 'de',
    show: 'en',
    покажи: 'ru',
    показать: 'ru',
    покажите: 'ru',
};
const VERBS = new Set(Object.keys(VERB_LANGUAGE));
const POLITE = new Set(['bitte', 'mal', 'please', 'пожалуйста', 'kannst', 'du', 'can', 'you', 'could']);
const FILLERS = new Set(['mir', 'uns', 'me', 'us', 'мне', 'нам', 'das', 'den', 'die', 'der', 'dem', 'the', 'a', 'an']);
/** Where it is shown: said after the name, never part of it. */
const TAILS = [
    'in der 3d ansicht',
    'in der 3 d ansicht',
    'in 3d',
    'im 3d',
    'in 3 d',
    'auf dem plan',
    'im plan',
    'on the plan',
    'in the plan',
    'on the map',
    'в 3d',
    'на плане',
    'на схеме',
    'bitte',
    'please',
    'пожалуйста',
    'an',
];
const HOUSE = new Set([
    'haus',
    'ganze haus',
    'ganzes haus',
    'uebersicht',
    'alles',
    'house',
    'whole house',
    'home',
    'overview',
    'дом',
    'весь дом',
    'обзор',
]);

/** The names of a `home3d.N.places` value: floors, rooms and devices; empty for anything else. */
export function parsePlaces(value: unknown): Home3dPlace[] {
    let data: unknown = value;
    if (typeof value === 'string') {
        try {
            data = JSON.parse(value);
        } catch {
            return [];
        }
    }
    if (!data || typeof data !== 'object') {
        return [];
    }
    const out: Home3dPlace[] = [];
    const seen = new Set<string>();
    const add = (name: unknown, kind: Home3dPlace['kind']): void => {
        if (typeof name !== 'string' || !name.trim()) {
            return;
        }
        const key = `${kind}:${fold(name)}`;
        if (!seen.has(key)) {
            seen.add(key);
            out.push({ name: name.trim(), kind });
        }
    };
    const { floors, devices } = data as { floors?: unknown; devices?: unknown };
    if (floors && typeof floors === 'object' && !Array.isArray(floors)) {
        for (const [floor, rooms] of Object.entries(floors as Record<string, unknown>)) {
            add(floor, 'floor');
            if (Array.isArray(rooms)) {
                rooms.forEach(r => add(r, 'room'));
            }
        }
    }
    if (Array.isArray(devices)) {
        devices.forEach(d => add((d as { name?: unknown } | null)?.name, 'device'));
    }
    return out;
}

/** Whether a sentence starts with a "show" verb (after a polite word): only then are the places read. */
export function isShowRequest(text: string): boolean {
    const words = fold(text).split(' ');
    const first = words.find(w => !POLITE.has(w));
    return !!first && VERBS.has(first);
}

/**
 * The language of the "show" verb, else `fallback`: a sentence of two words is too short for the detection of the
 * question's language, but its verb says it.
 */
export function showLanguage(text: string, fallback: string): string {
    const first = fold(text)
        .split(' ')
        .find(w => w && !POLITE.has(w));
    return (first && VERB_LANGUAGE[first]) || fallback;
}

/** The words after the verb, without "mir", articles and where it is shown. */
function spokenTarget(text: string): string | null {
    const words = fold(text).split(' ').filter(Boolean);
    let i = 0;
    while (i < words.length && POLITE.has(words[i])) {
        i++;
    }
    if (i >= words.length || !VERBS.has(words[i])) {
        return null;
    }
    i++;
    while (i < words.length && (FILLERS.has(words[i]) || POLITE.has(words[i]))) {
        i++;
    }
    let rest = words.slice(i).join(' ');
    for (let changed = true; changed;) {
        changed = false;
        for (const tail of TAILS) {
            if (rest.endsWith(` ${tail}`)) {
                rest = rest.slice(0, -tail.length - 1);
                changed = true;
            }
        }
    }
    return rest.trim() || null;
}

/** One word for another, up to its ending ("кухню"/"Кухня", "гостиную"/"Гостиная", "Bads"/"Bad"). */
function wordMatch(a: string, b: string): boolean {
    if (a === b || sameWord(a, b)) {
        return true;
    }
    if (Math.abs(a.length - b.length) > 1) {
        return false;
    }
    const cut = Math.min(a.length, b.length) >= 6 ? 2 : Math.min(a.length, b.length) >= 4 ? 1 : 0;
    return cut > 0 && a.slice(0, -cut) === b.slice(0, -cut);
}

/** The spoken words name this place: all its words in order, each up to its ending, or the name with a typo. */
function names(said: string, name: string): boolean {
    const a = said.split(' ');
    const b = fold(name).split(' ').filter(Boolean);
    if (a.length === b.length && a.every((w, k) => wordMatch(w, b[k]))) {
        return true;
    }
    return similarName(said, name);
}

const ORDER: Record<Home3dPlace['kind'], number> = { floor: 0, room: 1, device: 2 };

/**
 * "Zeig Unterdeck", "zeig mir das Bad vorne", "show the galley", "покажи кухню", "zeig das ganze Haus": the place
 * to show, or null when the sentence names none of `places` (it then goes on to the other tiers). A floor wins over
 * a room and a room over a device of the same name; the exact name over one heard with a typo.
 */
export function parseShowCommand(text: string, places: readonly Home3dPlace[]): ShowCommand | null {
    const said = spokenTarget(text);
    if (!said || !places.length) {
        return null;
    }
    if (HOUSE.has(said)) {
        return { target: HOUSE_TARGET, kind: 'house' };
    }
    const sorted = [...places].sort((p, q) => ORDER[p.kind] - ORDER[q.kind]);
    const hit = sorted.find(p => fold(p.name) === said) ?? sorted.find(p => names(said, p.name));
    return hit ? { target: hit.name, kind: hit.kind } : null;
}

/** The answer: what the 3D view shows (the name it confirmed), or that no view showed it. */
export function showReply(lang: string, shown: string | null, target: string): string {
    const l = lang.slice(0, 2);
    if (shown) {
        return l === 'ru' ? `Показываю: ${shown}.` : l === 'de' ? `Ich zeige ${shown}.` : `Showing ${shown}.`;
    }
    return l === 'ru'
        ? `Не вижу открытого 3D-вида, который показал бы «${target}».`
        : l === 'de'
          ? `Keine offene 3D-Ansicht hat „${target}“ gezeigt.`
          : `No open 3D view showed "${target}".`;
}
