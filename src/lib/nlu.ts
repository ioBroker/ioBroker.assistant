/**
 * Tier-0 rule-based NLU (no model, no install, offline) — a TypeScript port of the proven matching
 * approach from the Python assistant "Hannah" (`core/hannah/nlu.py`), reduced to the intents this
 * adapter needs: turn on/off, set level, set color, and status queries.
 *
 * It matches a free-text command against the known rooms and devices (room + device + action, longest
 * match wins) and returns a structured {@link NluIntent} the caller executes directly via the ioBroker
 * API — bypassing the LLM entirely for the common commands. Anything it cannot confidently resolve
 * returns `null`, so the caller falls through to the local/cloud LLM.
 */

/** A device as the NLU needs to see it: friendly name, room, type and its controls (controlType → stateId). */
export interface NluDevice {
    name: string;
    room: string;
    /** type-detector type, e.g. 'light', 'socket', 'dimmer', 'rgb', 'thermostat'. */
    type: string;
    /** controlType → state id (e.g. `power`, `level`, `brightness`, `actual`, …). */
    controls: Record<string, string>;
    /** controlType → writable flag. */
    writable: Record<string, boolean>;
}

export type NluActionType = 'on' | 'off' | 'level' | 'color' | 'query';

export interface NluIntent {
    action: NluActionType;
    device: NluDevice;
    /** State id to act on (writable for on/off/level/color, readable for query). */
    stateId: string;
    /** Value to write (bool for on/off, number for level, hex/temp string for color). */
    value?: boolean | number | string;
    /** Matched room display name, if any. */
    room?: string;
    confidence: number;
}

const TURN_ON = new Set([
    // de/en
    'an',
    'ein',
    'einschalten',
    'anschalten',
    'anmachen',
    'aktiviere',
    'aktivieren',
    'starte',
    'start',
    'on',
    // ru
    'включи',
    'включить',
    'вруби',
    'врубить',
    'зажги',
    'запусти',
]);
const TURN_OFF = new Set([
    // de/en
    'aus',
    'ausschalten',
    'abschalten',
    'ausmachen',
    'deaktiviere',
    'deaktivieren',
    'stoppe',
    'stop',
    'off',
    // ru
    'выключи',
    'выключить',
    'выруби',
    'вырубить',
    'погаси',
    'потуши',
    'отключи',
]);
const QUERY_WORDS = new Set([
    // de/en
    'wie',
    'was',
    'ist',
    'sind',
    'status',
    'wieviel',
    'welche',
    'welcher',
    'zeig',
    'zeige',
    'laeuft',
    'how',
    'what',
    'is',
    'are',
    'show',
    // ru
    'какая',
    'какой',
    'какое',
    'сколько',
    'покажи',
    'что',
    'статус',
]);
/** Filler words removed before matching (so "mach das Licht an" → ["licht","an"]). */
const FILLER = new Set([
    // de/en
    'bitte',
    'mal',
    'doch',
    'denn',
    'einfach',
    'kannst',
    'du',
    'koenntest',
    'mach',
    'die',
    'das',
    'den',
    'der',
    'the',
    'please',
    'und',
    'im',
    'in',
    'auf',
    'zum',
    'zur',
    // ru
    'пожалуйста',
    'давай',
    'ну',
    'мне',
    'на',
    'в',
    'и',
]);
/** Color names (de + ru) → hex, or a special token for color temperature. */
const COLORS: Record<string, string> = {
    rot: '#FF0000',
    gruen: '#00FF00',
    blau: '#0000FF',
    gelb: '#FFFF00',
    orange: '#FF8000',
    lila: '#8000FF',
    pink: '#FF69B4',
    magenta: '#FF00FF',
    cyan: '#00FFFF',
    tuerkis: '#00CED1',
    weiss: '#FFFFFF',
    warmweiss: 'warm',
    kaltweiss: 'cold',
    красный: '#FF0000',
    зеленый: '#00FF00',
    синий: '#0000FF',
    голубой: '#00BFFF',
    желтый: '#FFFF00',
    оранжевый: '#FF8000',
    фиолетовый: '#8000FF',
    розовый: '#FF69B4',
    белый: '#FFFFFF',
};
/** Device types that accept a color. */
const COLOR_TYPES = new Set(['rgb', 'rgbSingle', 'rgbwSingle', 'hue', 'cie', 'ct']);

/** Normalize for matching: lowercase, German umlauts → ascii, ß → ss, Russian ё → е. */
export function normalize(s: string): string {
    return s
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .replace(/ё/g, 'е');
}

const STRIP = /[.,!?;:()[\]]/g;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does a name word appear in the text? Matches on a Unicode word boundary and allows a differing
 * suffix (crude stemming) so inflected forms match too — essential for Russian ("подсветку" for
 * "подсветка", "кокпита" for "кокпит"). Longer words drop more trailing characters.
 */
function wordInText(word: string, text: string): boolean {
    const stem =
        word.length >= 6 ? word.slice(0, word.length - 2) : word.length >= 5 ? word.slice(0, word.length - 1) : word;
    try {
        return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(stem)}`, 'u').test(text);
    } catch {
        return text.includes(stem);
    }
}

export class Nlu {
    private readonly rooms: string[];
    private readonly devices: NluDevice[];

    constructor(rooms: string[], devices: NluDevice[]) {
        this.rooms = rooms.filter(Boolean);
        this.devices = devices;
    }

    /** Parse a command; returns a structured intent or null if nothing could be resolved confidently. */
    parse(text: string): NluIntent | null {
        const raw = text;
        const norm = normalize(text.replace(STRIP, ' '));
        const tokens = norm.split(/\s+/).filter(t => t && !FILLER.has(t));
        if (!tokens.length) {
            return null;
        }
        const joined = tokens.join(' ');
        const tokenSet = new Set(tokens);

        const roomName = this.findRoom(joined);
        const device = this.findDevice(joined, roomName);
        if (!device) {
            return null; // no device → let the LLM handle it
        }

        const action = this.findAction(tokenSet); // 'on' | 'off' | null
        const level = this.findLevel(norm); // number | null
        const color = this.findColor(joined);
        const isQuery = tokens.some(t => QUERY_WORDS.has(t)) || raw.trim().endsWith('?');

        // 1. Set level (dimmer/blind …) — needs a level-like control.
        if (level !== null) {
            const stateId = this.pickControl(device, ['level', 'brightness', 'dimmer'], true);
            if (stateId) {
                return { action: 'level', device, stateId, value: level, room: roomName, confidence: 0.9 };
            }
        }

        // 2. Set color — only a hex color on a color-capable device (warm/cold color-temp is out of scope for v1).
        if (color && color.startsWith('#') && COLOR_TYPES.has(device.type)) {
            const stateId = this.pickControl(device, ['rgb', 'color', 'hue', 'cie', 'ct'], true);
            if (stateId) {
                return { action: 'color', device, stateId, value: color, room: roomName, confidence: 0.85 };
            }
        }

        // 3. Turn on / off — needs a writable power/switch control.
        if (action) {
            const stateId = this.pickControl(device, ['power', 'switch', 'on', 'level'], true);
            if (stateId) {
                return {
                    action,
                    device,
                    stateId,
                    value: action === 'on',
                    room: roomName,
                    confidence: 0.9,
                };
            }
        }

        // 4. Status query — pick a readable state.
        if (isQuery) {
            const stateId =
                this.pickControl(device, ['actual', 'power', 'level', 'value'], false) ||
                Object.values(device.controls)[0];
            if (stateId) {
                return { action: 'query', device, stateId, room: roomName, confidence: 0.7 };
            }
        }

        return null;
    }

    /** The room whose significant words all appear in the text (stem-tolerant); longest name wins. */
    private findRoom(text: string): string {
        let best = '';
        let bestLen = 0;
        for (const name of this.rooms) {
            const n = normalize(name);
            const words = n.split(/\s+/).filter(w => w.length >= 3);
            if (!words.length) {
                continue;
            }
            if (words.every(w => wordInText(w, text)) && n.length > bestLen) {
                best = name;
                bestLen = n.length;
            }
        }
        return best;
    }

    /**
     * Device whose significant name words all appear in the text (stem-tolerant for inflection).
     * Prefers devices in the matched room; the longest matching name wins.
     */
    private findDevice(text: string, roomName: string): NluDevice | null {
        const normRoom = roomName ? normalize(roomName) : '';
        const spaces: NluDevice[][] = [];
        if (roomName) {
            spaces.push(this.devices.filter(d => d.room === roomName));
        }
        spaces.push(this.devices.filter(d => !roomName || d.room !== roomName));

        for (const space of spaces) {
            let best: NluDevice | null = null;
            let bestLen = 0;
            for (const dev of space) {
                const nk = normalize(dev.name);
                if (!nk || (normRoom && normRoom.includes(nk))) {
                    continue; // skip a device whose name is part of the room name
                }
                const words = nk.split(/\s+/).filter(w => w.length >= 3);
                if (!words.length) {
                    continue;
                }
                if (words.every(w => wordInText(w, text)) && nk.length > bestLen) {
                    best = dev;
                    bestLen = nk.length;
                }
            }
            if (best) {
                return best;
            }
        }
        return null;
    }

    private findAction(tokens: Set<string>): 'on' | 'off' | null {
        for (const t of tokens) {
            if (TURN_OFF.has(t)) {
                return 'off';
            }
            if (TURN_ON.has(t)) {
                return 'on';
            }
        }
        return null;
    }

    private findLevel(text: string): number | null {
        const m = text.match(/(\d+(?:[.,]\d+)?)\s*(?:prozent|процент\w*|%)/u);
        return m ? parseFloat(m[1].replace(',', '.')) : null;
    }

    private findColor(text: string): string | null {
        for (const [name, hex] of Object.entries(COLORS)) {
            if (wordInText(name, text)) {
                return hex;
            }
        }
        return null;
    }

    /** First control (by controlType priority) that exists and, if `mustWrite`, is writable. */
    private pickControl(device: NluDevice, order: string[], mustWrite: boolean): string {
        for (const key of order) {
            const id = device.controls[key];
            if (id && (!mustWrite || device.writable[key])) {
                return id;
            }
        }
        if (mustWrite) {
            // any writable control as a last resort
            for (const [key, id] of Object.entries(device.controls)) {
                if (device.writable[key]) {
                    return id;
                }
            }
        }
        return '';
    }
}
