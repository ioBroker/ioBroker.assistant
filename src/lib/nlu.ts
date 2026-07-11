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
    /** controlType → ioBroker value type ('boolean'|'number'|'string'|…), to pick the right control. */
    types: Record<string, string>;
    /** controlType → ioBroker role (e.g. 'switch.light', 'level.dimmer'), to find the on/off switch. */
    roles?: Record<string, string>;
}

export type NluActionType =
    | 'on'
    | 'off'
    | 'level'
    | 'color'
    | 'query'
    | 'listByState'
    | 'timerSet'
    | 'timerQuery'
    | 'timerCancel'
    | 'alarmSet'
    | 'alarmQuery'
    | 'alarmCancel';

export interface NluIntent {
    action: NluActionType;
    /** Single-device actions (on/off/level/color/query). */
    device?: NluDevice;
    /** State id to act on (writable for on/off/level/color, readable for query). */
    stateId?: string;
    /** Value to write (bool for on/off, number for level, hex/temp string for color). */
    value?: boolean | number | string;
    /**
     * Secondary write applied after the primary one — used to also flip a dimmer's on/off switch when
     * setting its level ("30%" → level 30 **and** switch on), when the device has a separate switch control.
     */
    also?: { stateId: string; value: boolean };
    /** Matched room display name, if any. */
    room?: string;
    confidence: number;
    // ── Aggregate query (action 'listByState'), e.g. "which windows are open" ──
    /** All devices of the queried category (e.g. every window). */
    devices?: NluDevice[];
    /** The queried device category, e.g. 'window'. */
    category?: string;
    /** Which state to report on, e.g. 'open'. */
    stateFilter?: string;
    // ── Timer intents (timerSet/timerQuery/timerCancel) ──
    /** Duration in seconds for `timerSet`. */
    durationSec?: number;
    /** Optional timer/alarm label (e.g. "die Nudeln"), or a match hint for `timerCancel`/`alarmCancel`. */
    label?: string;
    // ── Alarm intents (alarmSet/alarmQuery/alarmCancel) ──
    /** Hour 0–23 for `alarmSet`. */
    hour?: number;
    /** Minute 0–59 for `alarmSet`. */
    minute?: number;
    /** Weekdays (0 = Sunday … 6 = Saturday) for `alarmSet`; empty = one-shot next occurrence. */
    weekdays?: number[];
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

/** type-detector types that count as "windows" for the "which windows are open" aggregate query. */
const WINDOW_TYPES = new Set(['window', 'windowTilt']);
/** Words (de/en/ru, stemmed) that name a window. */
const WINDOW_WORDS = ['fenster', 'window', 'windows', 'окно', 'окна', 'окон'];
/** Words (de/en/ru, stemmed) that mean "open". */
const OPEN_WORDS = ['offen', 'geoeffnet', 'geoffnet', 'auf', 'open', 'открыт', 'открыта', 'открыты', 'открытые'];

/** Words (de/en/ru, stemmed) that make a query an on/off question ("is the light on?"). */
const ON_OFF_QUERY_WORDS = [
    'an',
    'ein',
    'aus',
    'eingeschaltet',
    'ausgeschaltet',
    'on',
    'off',
    'включен',
    'включена',
    'включено',
    'выключен',
    'выключена',
    'работает',
];

/**
 * State-id suffixes of pure measurements/indicators — never the on/off switch or level (but note ACTUAL
 * is NOT here: it is a valid read-back for "is it on"). Used to keep pickControl off metering states.
 */
const METER_SUFFIX =
    /(CONSUMPTION|ELECTRIC_POWER|CURRENT|VOLTAGE|ENERGY|POWER|LOWBAT|BATTERY|UNREACH|RSSI|TEMPERATURE)$/i;

// ── Timers / reminders (de/en/ru) ───────────────────────────────────────────
/**
 * Marks a command as being about a countdown timer. Never fires on the bare word "time" ("what time is
 * it") — it needs the full "timer". "timers?" carries no leading word boundary so German compounds
 * ("Küchentimer", "Eieruhr"-style) and the plural still match; the prefix forms keep a boundary.
 */
const TIMER_RE = /(?:(?<![\p{L}])(reminder|remind|erinner\p{L}*|таймер\p{L}*|напомн\p{L}*)|timers?)(?![\p{L}])/iu;
/** Words that turn a timer command into "cancel/stop the timer" (de/en/ru). */
const TIMER_CANCEL_RE =
    /(?<![\p{L}])(abbrech\p{L}*|beend\p{L}*|stopp?\p{L}*|loesch\p{L}*|cancel|delete|remove|clear|отмен\p{L}*|удал\p{L}*|сброс\p{L}*|стоп)(?![\p{L}])/iu;
/** Number words → digits (normalized: umlauts expanded), de/en/ru, plus common fractions. */
const NUMBER_WORDS: Record<string, string> = {
    ein: '1', eine: '1', einen: '1', eins: '1', zwei: '2', drei: '3', vier: '4', fuenf: '5', sechs: '6',
    sieben: '7', acht: '8', neun: '9', zehn: '10', elf: '11', zwoelf: '12',
    anderthalb: '1.5', eineinhalb: '1.5', halbe: '0.5', halb: '0.5', viertel: '0.25', dreiviertel: '0.75',
    one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
    ten: '10', eleven: '11', twelve: '12', half: '0.5', quarter: '0.25',
    один: '1', одну: '1', два: '2', две: '2', три: '3', четыре: '4', пять: '5', шесть: '6', семь: '7',
    восемь: '8', девять: '9', десять: '10',
};
/** Fixed phrases replaced up front so their fractions don't collide with the general number-word pass. */
const DURATION_PHRASES: [RegExp, string][] = [
    [/(?<![\p{L}])dreiviertelstunde(?![\p{L}])/iu, '45 minuten'],
    [/(?<![\p{L}])viertelstunde(?![\p{L}])/iu, '15 minuten'],
    [/(?<![\p{L}])eine? halbe stunde(?![\p{L}])/iu, '30 minuten'],
    [/(?<![\p{L}])halbe stunde(?![\p{L}])/iu, '30 minuten'],
    [/half an hour/iu, '30 minutes'],
    [/a half hour/iu, '30 minutes'],
    [/quarter of an hour/iu, '15 minutes'],
    [/quarter hour/iu, '15 minutes'],
    [/(?<![\p{L}])полтора часа(?![\p{L}])/iu, '90 минут'],
    [/(?<![\p{L}])полчаса(?![\p{L}])/iu, '30 минут'],
];
const HOUR_RE = /(\d+(?:[.,]\d+)?)\s*(?:stunden?|hours?|hrs?|h|час(?:а|ов)?)(?![\p{L}])/giu;
const MIN_RE = /(\d+(?:[.,]\d+)?)\s*(?:minuten?|mins?|minutes?|минут[уы]?)(?![\p{L}])/giu;
const SEC_RE = /(\d+(?:[.,]\d+)?)\s*(?:sekunden?|secs?|seconds?|секунд[уы]?)(?![\p{L}])/giu;
/** Duration/number tokens stripped from a timer label ("timer für 5 minuten für die Nudeln" → "die Nudeln"). */
const LABEL_STOP_WORDS = new Set([
    'in', 'im', 'mich', 'me', 'my', 'den', 'die', 'das', 'der', 'the', 'a', 'an', 'auf', 'noch', 'ein',
    'eine', 'einen', 'timer', 'reminder', 'remind', 'таймер', 'на', 'через', 'про', 'about', 'to', 'for',
    'fuer', 'stunde', 'stunden', 'minute', 'minuten', 'min', 'sekunde', 'sekunden', 'sec', 'hour', 'hours',
    'minutes', 'seconds', 'second', 'час', 'часа', 'часов', 'минут', 'минуту', 'минуты', 'секунд',
    'секунду', 'секунды',
]);
/** Marker words after which a timer label follows ("… an die Nudeln", "remind me to call mom"). */
const LABEL_MARKERS = new Set(['an', 'fuer', 'for', 'to', 'about', 'про']);

// ── Alarms / wake-ups at a fixed clock time (de/en/ru) ──────────────────────
/**
 * Marks a command as being about an alarm / wake-up ("Wecker", "weck mich", "alarm", "будильник"). Like
 * {@link TIMER_RE}, "alarms?"/"wecker" carry no leading boundary so compounds ("Küchenwecker") and the
 * plural still match; the verb-prefix forms ("weck…", "разбуд…") keep a boundary.
 */
const ALARM_RE = /(?:(?<![\p{L}])(weck\p{L}*|wake|буд\p{L}*|разбуд\p{L}*)|alarms?|wecker)(?![\p{L}])/iu;
/** Hour number words → digits (no fractions — those are handled by the clock regexes). de/en/ru, 1–12. */
const HOUR_WORDS: Record<string, string> = {
    ein: '1', eine: '1', einen: '1', eins: '1', zwei: '2', drei: '3', vier: '4', fuenf: '5', sechs: '6',
    sieben: '7', acht: '8', neun: '9', zehn: '10', elf: '11', zwoelf: '12',
    one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
    ten: '10', eleven: '11', twelve: '12',
    один: '1', два: '2', три: '3', четыре: '4', пять: '5', шесть: '6', семь: '7', восемь: '8', девять: '9',
    десять: '10', одиннадцать: '11', двенадцать: '12',
};
/** Weekday word (normalized, prefix-matched for inflection) → 0 (Sun) … 6 (Sat). */
const WEEKDAYS: [RegExp, number][] = [
    [/(?<![\p{L}])(montag|monday|понедельник)/iu, 1],
    [/(?<![\p{L}])(dienstag|tuesday|вторник)/iu, 2],
    [/(?<![\p{L}])(mittwoch|wednesday|сред)/iu, 3],
    [/(?<![\p{L}])(donnerstag|thursday|четверг)/iu, 4],
    [/(?<![\p{L}])(freitag|friday|пятниц)/iu, 5],
    [/(?<![\p{L}])(samstag|sonnabend|saturday|суббот)/iu, 6],
    [/(?<![\p{L}])(sonntag|sunday|воскресень)/iu, 0],
];

/**
 * Parse a clock time from free text (de/en/ru): "7:30", "7 Uhr", "7 Uhr 30", "halb acht" (7:30),
 * "viertel nach sieben" (7:15), "viertel vor acht"/"dreiviertel acht" (7:45), "half past seven",
 * "quarter past/to", "в 7 часов", plus am/pm. Returns {hour 0-23, minute 0-59} or null.
 */
export function parseClockTime(text: string): { hour: number; minute: number } | null {
    let t = normalize(text);
    // Substitute hour number words → digits ("halb acht" → "halb 8"), leaving fraction words intact.
    t = t
        .split(/\s+/)
        .map(w => (Object.prototype.hasOwnProperty.call(HOUR_WORDS, w) ? HOUR_WORDS[w] : w))
        .join(' ');

    const pm = /(?<![\p{L}])(pm|nachmittags|abends|вечера)(?![\p{L}])/u.test(t);
    const am = /(?<![\p{L}])(am|morgens|vormittags|utra|утра|nachts)(?![\p{L}])/u.test(t);
    const applyMeridiem = (h: number): number => {
        if (pm && h < 12) {
            return h + 12;
        }
        if (am && h === 12) {
            return 0;
        }
        return h;
    };
    const ok = (h: number, m: number): { hour: number; minute: number } | null =>
        h >= 0 && h <= 23 && m >= 0 && m <= 59 ? { hour: h, minute: m } : null;

    let m: RegExpMatchArray | null;
    // HH:MM
    if ((m = t.match(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/))) {
        return ok(applyMeridiem(+m[1]), +m[2]);
    }
    // "viertel nach H" → H:15 ; "viertel vor H" / "dreiviertel H" → (H-1):45
    if ((m = t.match(/viertel\s+nach\s+(\d{1,2})/))) {
        return ok(applyMeridiem(+m[1]), 15);
    }
    if ((m = t.match(/(?:viertel\s+vor|dreiviertel)\s+(\d{1,2})/))) {
        return ok(applyMeridiem((+m[1] + 23) % 24), 45);
    }
    if ((m = t.match(/quarter\s+past\s+(\d{1,2})/))) {
        return ok(applyMeridiem(+m[1]), 15);
    }
    if ((m = t.match(/quarter\s+to\s+(\d{1,2})/))) {
        return ok(applyMeridiem((+m[1] + 23) % 24), 45);
    }
    // "halb H" (German) → (H-1):30 ; "half past H" (English) → H:30
    if ((m = t.match(/half\s+past\s+(\d{1,2})/))) {
        return ok(applyMeridiem(+m[1]), 30);
    }
    if ((m = t.match(/(?<![\p{L}])halb\s+(\d{1,2})/u))) {
        return ok(applyMeridiem((+m[1] + 23) % 24), 30);
    }
    // "H Uhr MM" / "H Uhr" / "H часов MM"
    if ((m = t.match(/(\d{1,2})\s*(?:uhr|часов|часа|час)\s*(\d{1,2})(?![\p{L}])/u))) {
        return ok(applyMeridiem(+m[1]), +m[2]);
    }
    if ((m = t.match(/(\d{1,2})\s*(?:uhr|o.?clock|часов|часа|час)(?![\p{L}])/u))) {
        return ok(applyMeridiem(+m[1]), 0);
    }
    // "um/at/в H" (bare hour after an explicit time preposition) — but not when a duration unit follows,
    // so "Timer um 5 Minuten" is not misread as 5 o'clock.
    if ((m = t.match(/(?<![\p{L}])(?:um|at|в|во)\s+(\d{1,2})(?![\d:])(?!\s*(?:minut|stund|sekund|min|sek|hour|second))/u))) {
        return ok(applyMeridiem(+m[1]), 0);
    }
    // Bare hour qualified only by am/pm ("7 pm", "8 am").
    if ((pm || am) && (m = t.match(/(?<![\d.])(\d{1,2})(?![\d.:])/))) {
        return ok(applyMeridiem(+m[1]), 0);
    }
    return null;
}

/**
 * Parse recurrence from free text → weekday numbers (0 = Sun … 6 = Sat). "täglich"/"jeden Tag"/"daily"
 * → all 7; "wochentags"/"werktags"/"weekdays" → Mon–Fri; "wochenende"/"weekend" → Sat+Sun; otherwise the
 * union of the named weekdays. Empty array = one-shot.
 */
export function parseWeekdays(text: string): number[] {
    const t = normalize(text);
    if (/(?<![\p{L}])(taeglich|jeden tag|daily|every day|ежедневно|каждый день)(?![\p{L}])/u.test(t)) {
        return [0, 1, 2, 3, 4, 5, 6];
    }
    if (/(?<![\p{L}])(wochentags|werktags|weekdays|по будням|будни)(?![\p{L}])/u.test(t)) {
        return [1, 2, 3, 4, 5];
    }
    if (/(?<![\p{L}])(wochenende|weekend|выходн\p{L}*)(?![\p{L}])/u.test(t)) {
        return [0, 6];
    }
    const days = new Set<number>();
    for (const [re, day] of WEEKDAYS) {
        if (re.test(t)) {
            days.add(day);
        }
    }
    return [...days].sort();
}

/**
 * Parse a free-text duration ("1 Stunde 30 Minuten", "in 5 minuten", "полтора часа") into seconds; null
 * if none is found. With `assumeMinutes`, a bare number with no unit ("timer 5") counts as minutes.
 */
export function parseDurationSeconds(text: string, assumeMinutes = false): number | null {
    let t = normalize(text);
    for (const [re, rep] of DURATION_PHRASES) {
        t = t.replace(re, rep);
    }
    // Replace standalone number words with digits so "fünf minuten" → "5 minuten".
    t = t
        .split(/\s+/)
        .map(w => (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, w) ? NUMBER_WORDS[w] : w))
        .join(' ');

    let total = 0;
    let matched = false;
    const sum = (re: RegExp, factor: number): void => {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(t))) {
            total += parseFloat(m[1].replace(',', '.')) * factor;
            matched = true;
        }
    };
    sum(HOUR_RE, 3600);
    sum(MIN_RE, 60);
    sum(SEC_RE, 1);

    if (!matched && assumeMinutes) {
        const bare = t.match(/(?<![\d.])(\d+(?:[.,]\d+)?)(?![\d.])/);
        if (bare) {
            total = parseFloat(bare[1].replace(',', '.')) * 60;
            matched = true;
        }
    }
    return matched && total > 0 ? Math.round(total) : null;
}

/**
 * "Make it stop" words (de/en/ru), used to silence a ringing timer/alarm. Kept separate from the device
 * TURN_OFF set (no "aus") so it only reacts to an explicit stop/quiet phrase, not "turn the light off".
 */
const STOP_RE =
    /(?<![\p{L}])(stopp?\p{L}*|halt|aufhoer\p{L}*|ruhe|ruhig|genug|schluss|abbrech\p{L}*|beend\p{L}*|ende|still|cancel|enough|quiet|dismiss|silence|стоп|хватит|тихо|довольно|прекрат\p{L}*|отмен\p{L}*|замолч\p{L}*|тишин\p{L}*)(?![\p{L}])/iu;

/** True if the text is a "stop / be quiet" command (used to silence a ringing timer/alarm). */
export function isStopCommand(text: string): boolean {
    return STOP_RE.test(normalize(text));
}

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

        // Timer / alarm intents ("timer 5 minuten", "weck mich um 7 Uhr", "wie lange noch") — before
        // window/device matching, and device-independent.
        const schedule = this.parseSchedule(raw, norm, joined);
        if (schedule) {
            return schedule;
        }

        // Aggregate query first ("which windows are open") — before single-device matching.
        const windowsQuery = this.parseWindowsOpen(joined);
        if (windowsQuery) {
            return windowsQuery;
        }

        const roomName = this.findRoom(joined);
        const device = this.findDevice(joined, roomName);
        if (!device) {
            return null; // no device → let the LLM handle it
        }

        const action = this.findAction(tokenSet); // 'on' | 'off' | null
        const level = this.findLevel(norm); // number | null
        const color = this.findColor(joined);
        const isQuery = tokens.some(t => QUERY_WORDS.has(t)) || raw.trim().endsWith('?');

        // A question ("ist das Licht an?") must never trigger a write — only the query branch below.
        // 1. Set level (dimmer/blind …) — needs a numeric level-like control.
        if (level !== null && !isQuery) {
            const stateId = this.pickControl(device, ['level', 'brightness', 'dimmer'], true, 'number');
            if (stateId) {
                const intent: NluIntent = { action: 'level', device, stateId, value: level, room: roomName, confidence: 0.9 };
                // Many dimmers have a separate on/off switch that setting the level does not flip — so also
                // turn it on (level > 0) / off (0%) if the device has one. Devices without a switch are
                // unaffected. The switch is found by role/type, not by name (not every device names it ON_SET).
                const sw = this.findSwitch(device, stateId);
                if (sw) {
                    intent.also = { stateId: sw, value: level > 0 };
                }
                return intent;
            }
        }

        // 2. Set color — only a hex color on a color-capable device (warm/cold color-temp is out of scope for v1).
        if (color && color.startsWith('#') && COLOR_TYPES.has(device.type) && !isQuery) {
            const stateId = this.pickControl(device, ['rgb', 'color', 'hue', 'cie', 'ct'], true);
            if (stateId) {
                return { action: 'color', device, stateId, value: color, room: roomName, confidence: 0.85 };
            }
        }

        // 3. Turn on / off — prefer a writable boolean switch (never a metering state like CONSUMPTION).
        if (action && !isQuery) {
            const stateId = this.pickControl(device, ['power', 'switch', 'on', 'level'], true, 'boolean');
            if (stateId) {
                // If only a numeric (dimmer/level) control is available, on/off means full/zero level, not a
                // boolean 1/0 (writing `true` to a 0–100 state would land on ~1%).
                const numeric = this.valueTypeOf(device, stateId) === 'number';
                return {
                    action,
                    device,
                    stateId,
                    value: numeric ? (action === 'on' ? 100 : 0) : action === 'on',
                    room: roomName,
                    confidence: 0.9,
                };
            }
        }

        // 4. Status query — read the right control: an on/off question ("is the light on?") reads the
        //    boolean switch/feedback; a value question ("what temperature?") reads the actual value.
        if (isQuery) {
            const onOff = ON_OFF_QUERY_WORDS.some(w => wordInText(w, joined));
            const order = onOff ? ['power', 'switch', 'on', 'actual', 'level'] : ['actual', 'value', 'level', 'power'];
            const stateId = this.pickControl(device, order, false, onOff ? 'boolean' : undefined);
            if (stateId) {
                return { action: 'query', device, stateId, room: roomName, confidence: 0.7 };
            }
        }

        return null;
    }

    /**
     * Timer (countdown) / alarm (fixed clock time) command (de/en/ru). Requires a timer or alarm keyword,
     * then classifies in priority order:
     *  - a cancel word → `timerCancel` / `alarmCancel`,
     *  - a parseable clock time → `alarmSet` (with weekdays / label / room),
     *  - an explicit duration with a unit ("5 Minuten") → `timerSet` (so "weck mich in 5 Minuten" is a
     *    countdown, not a clock time),
     *  - a bare number: an hour in the alarm domain ("Wecker auf 8"), else minutes → `timerSet`,
     *  - otherwise → `timerQuery` / `alarmQuery` (list what is running).
     */
    private parseSchedule(raw: string, norm: string, joined: string): NluIntent | null {
        const isTimer = TIMER_RE.test(norm);
        const isAlarm = ALARM_RE.test(norm);
        if (!isTimer && !isAlarm) {
            return null;
        }
        // Prefer the alarm reading only when it is the sole keyword (so "erinnere mich um 7" → alarm, but
        // "timer …" stays a timer even if it also mentions "wecker").
        const alarmDomain = isAlarm && !isTimer;
        const room = this.findRoom(joined) || undefined;
        const label = (): string | undefined => this.findTimerLabel(norm) || undefined;
        const alarm = (hour: number, minute: number, confidence: number): NluIntent => ({
            action: 'alarmSet',
            hour,
            minute,
            weekdays: parseWeekdays(norm),
            label: label(),
            room,
            confidence,
        });

        if (TIMER_CANCEL_RE.test(norm)) {
            return { action: alarmDomain ? 'alarmCancel' : 'timerCancel', label: label(), room, confidence: 0.9 };
        }

        // Clock time first (parsed from the raw text — the normalized `norm` has ':' stripped, which would
        // turn "6:30" into "6 30"). The "um H" rule already refuses a following duration unit, and the ru
        // "H часов" o'clock form is resolved here before it could be mistaken for "H hours".
        const clock = parseClockTime(raw);
        if (clock) {
            return alarm(clock.hour, clock.minute, 0.9);
        }

        // Explicit duration with a unit ("5 Minuten", "1 Stunde") → a countdown timer, even for "Wecker in …".
        const explicit = parseDurationSeconds(norm, false);
        if (explicit) {
            return { action: 'timerSet', durationSec: explicit, label: label(), room, confidence: 0.9 };
        }

        // A bare number: an hour for an alarm ("Wecker auf 8"), otherwise minutes for a timer ("Timer 5").
        const bare = parseDurationSeconds(norm, true);
        if (bare) {
            const hour = Math.round(bare / 60);
            if (alarmDomain && hour >= 0 && hour <= 23) {
                return alarm(hour, 0, 0.8);
            }
            return { action: 'timerSet', durationSec: bare, label: label(), room, confidence: 0.9 };
        }
        return { action: alarmDomain ? 'alarmQuery' : 'timerQuery', room, confidence: 0.7 };
    }

    /**
     * Extract a timer label: the text after the last marker word ("an", "for", "to", "про", …), stripped
     * of duration/number/filler tokens. "erinnere mich in 5 minuten an den ofen" → "ofen"; "timer für 5
     * minuten" → "" (no label). Operates on the normalized text (lowercased) — fine for a spoken reply.
     */
    private findTimerLabel(norm: string): string {
        const tokens = norm.split(/\s+/).filter(Boolean);
        let start = -1;
        for (let i = 0; i < tokens.length; i++) {
            if (LABEL_MARKERS.has(tokens[i])) {
                start = i + 1;
            }
        }
        if (start < 0 || start >= tokens.length) {
            return '';
        }
        const words = tokens
            .slice(start)
            .filter(w => !LABEL_STOP_WORDS.has(w) && !/^\d+([.,]\d+)?$/.test(w));
        return words.join(' ').trim();
    }

    /**
     * "Which windows are open?" (de/en/ru) → an aggregate query over all window devices. Matches when the
     * text mentions a window word AND an "open" word; optionally restricted to a matched room.
     */
    private parseWindowsOpen(text: string): NluIntent | null {
        if (!WINDOW_WORDS.some(w => wordInText(w, text)) || !OPEN_WORDS.some(w => wordInText(w, text))) {
            return null;
        }
        const roomName = this.findRoom(text);
        const windows = this.devices.filter(d => WINDOW_TYPES.has(d.type) && (!roomName || d.room === roomName));
        if (!windows.length) {
            return null; // no window devices known → let the LLM handle it
        }
        return {
            action: 'listByState',
            category: 'window',
            stateFilter: 'open',
            devices: windows,
            room: roomName || undefined,
            confidence: 0.9,
        };
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

    /**
     * Pick a control state id. Tries the ordered controlType keys (preferring `preferType`, then any type),
     * then falls back to any usable **non-metering** control — so a query/command never lands on a
     * CONSUMPTION/CURRENT/… measurement. `mustWrite` additionally requires the control to be writable.
     */
    private pickControl(device: NluDevice, order: string[], mustWrite: boolean, preferType?: string): string {
        const types = device.types || {};
        const usable = (key: string): boolean => !!device.controls[key] && (!mustWrite || !!device.writable[key]);
        if (preferType) {
            // 1. an ordered key of the preferred value type (e.g. a boolean switch for on/off).
            for (const key of order) {
                if (usable(key) && types[key] === preferType) {
                    return device.controls[key];
                }
            }
            // 2. ANY control of the preferred type (non-metering). Catches a boolean switch stored under a
            //    non-standard control key (e.g. `ON_SET`), so on/off never lands on a numeric level/dimmer
            //    control when a real boolean switch exists on the device.
            for (const [key, id] of Object.entries(device.controls)) {
                if (usable(key) && types[key] === preferType && !METER_SUFFIX.test(id)) {
                    return id;
                }
            }
        }
        // 3. an ordered key of any type.
        for (const key of order) {
            if (usable(key)) {
                return device.controls[key];
            }
        }
        // 4. fallback: any usable non-metering control.
        for (const [key, id] of Object.entries(device.controls)) {
            if (usable(key) && !METER_SUFFIX.test(id)) {
                return id;
            }
        }
        return '';
    }

    /** The ioBroker value type ('boolean'|'number'|…) of a device control by its state id, '' if unknown. */
    private valueTypeOf(device: NluDevice, stateId: string): string {
        for (const [key, id] of Object.entries(device.controls)) {
            if (id === stateId) {
                return device.types[key] || '';
            }
        }
        return '';
    }

    /**
     * The device's on/off switch control (state id) other than `excludeStateId`, so a level command can also
     * power the device on. Role-based: a writable control with a `switch…` role wins; otherwise any writable
     * boolean, non-metering control; '' if the device has no separate switch.
     */
    private findSwitch(device: NluDevice, excludeStateId: string): string {
        const roles = device.roles || {};
        let fallback = '';
        for (const [key, id] of Object.entries(device.controls)) {
            if (id === excludeStateId || !device.writable[key] || METER_SUFFIX.test(id)) {
                continue;
            }
            const role = roles[key] || '';
            if (/^switch(\.|$)/i.test(role)) {
                return id; // a role-confirmed switch is the best match
            }
            if (!fallback && device.types[key] === 'boolean') {
                fallback = id; // any writable boolean control as a fallback
            }
        }
        return fallback;
    }
}
