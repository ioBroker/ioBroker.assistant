/**
 * Speech recognition in the language of the wake word: a household that speaks two languages gives each one its own
 * wake word ("Alisa" → Russian, "Hey Bro" → German), and the recording after it is recognised in that language.
 * Speech recognition that guesses the language itself (Parakeet, Whisper without a language) often guesses wrong on a
 * short command: German heard as Russian letters ("Листа светерморган" for "Wie ist das Wetter morgen") or as English.
 *
 * A wake word can also have a purpose: "Alisa" runs the house, "Hey Bro" only talks — any topic, from the general
 * knowledge of the model, without the commands of the house (`purpose: 'chat'`).
 */
import { wakeWordBaseName } from './wakeWords';

/** A row of the table `wakeWordLanguages`. */
export interface WakeWordLanguageRow {
    /** The wake word: its phrase ("Hey Bro") or its id ("hey_bro"), case and separators do not matter. */
    wakeWord?: string;
    /** ISO-639-1 code, e.g. `de` or `ru` (`zh-cn` style codes too); empty = the voice language. */
    language?: string;
    /** What the wake word is for: '' = the house and questions (as without the table), `chat` = free questions only. */
    purpose?: string;
}

/**
 * What a wake word is for. `home`: everything, as a wake word without a row — the commands of the house, and questions.
 * `chat`: free questions only — no device commands, no device list, no tools; its own conversation.
 */
export type WakeWordPurpose = 'home' | 'chat';

/** What a row of the table says about its wake word. */
export interface WakeWordProfile {
    /** '' = the voice language */
    language: string;
    purpose: WakeWordPurpose;
}

/** A wake word the device offers, as far as it matters here. */
export interface WakeWordName {
    id: string;
    phrase: string;
}

const LANGUAGE_RE = /^[a-z]{2,3}(-[a-z]{2,4})?$/;

/**
 * Key a wake word is compared by: lower case, letters and digits only. "Hey Bro", "hey_bro" and "Hey-Bro!" are the
 * same key, so an id and its phrase usually match each other too.
 *
 * @param name - Phrase or id of a wake word
 */
export function wakeWordKey(name: string): string {
    return String(name ?? '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Key a wake word is looked up by: the {@link wakeWordKey} of its base name, without the date, time, hash and model
 * type of a trained model. "ioBroker", the phrase "261103_iobroker" of a shipped model and its id
 * "261103_iobroker_2ae6f3f7" are all `iobroker`, so one row covers every version. A name in other than Latin
 * letters is taken whole (the base name only knows those).
 *
 * @param name - Phrase or id of a wake word, or a row of the table
 */
export function wakeWordLookupKey(name: string): string {
    const text = String(name ?? '');
    const base = /^[ -~]*$/.test(text) ? wakeWordBaseName(text) : '';
    return wakeWordKey(base) || wakeWordKey(text);
}

/**
 * The table of the settings as a map key ({@link wakeWordLookupKey}) → language and purpose. Rows without a wake word,
 * and rows that say nothing (no valid language, no purpose), are left out; the first row of a wake word wins.
 *
 * @param rows - `native.wakeWordLanguages`
 */
export function parseWakeWordProfiles(rows: unknown): Map<string, WakeWordProfile> {
    const map = new Map<string, WakeWordProfile>();
    const list = Array.isArray(rows) ? rows : rows && typeof rows === 'object' ? Object.values(rows) : [];
    for (const row of list as WakeWordLanguageRow[]) {
        const key = wakeWordLookupKey(row?.wakeWord ?? '');
        const language = String(row?.language ?? '')
            .trim()
            .toLowerCase();
        const valid = LANGUAGE_RE.test(language);
        const purpose: WakeWordPurpose = String(row?.purpose ?? '').trim() === 'chat' ? 'chat' : 'home';
        if (key && (valid || purpose === 'chat') && !map.has(key)) {
            map.set(key, { language: valid ? language : '', purpose });
        }
    }
    return map;
}

/**
 * The languages of the table: map key ({@link wakeWordLookupKey}) → language, without the rows that only give a purpose.
 *
 * @param rows - `native.wakeWordLanguages`, or what {@link parseWakeWordProfiles} made of it
 */
export function parseWakeWordLanguages(rows: unknown): Map<string, string> {
    const profiles = rows instanceof Map ? (rows as Map<string, WakeWordProfile>) : parseWakeWordProfiles(rows);
    const map = new Map<string, string>();
    for (const [key, profile] of profiles) {
        if (profile.language) {
            map.set(key, profile.language);
        }
    }
    return map;
}

/**
 * The entry of a wake word, undefined when the table does not name it. The device reports the phrase of the wake word
 * that woke it; the table may name the phrase or the id, so the wake words the device offers translate one into the
 * other.
 *
 * @param map - From {@link parseWakeWordLanguages} or {@link parseWakeWordProfiles}
 * @param phrase - Wake word phrase the device reported
 * @param available - Wake words the device offers (id and phrase)
 */
function lookup<T>(map: Map<string, T>, phrase: string, available: WakeWordName[]): T | undefined {
    if (!map.size) {
        return undefined;
    }
    const key = wakeWordLookupKey(phrase);
    if (!key) {
        return undefined;
    }
    const direct = map.get(key);
    if (direct !== undefined) {
        return direct;
    }
    for (const word of available) {
        const id = wakeWordLookupKey(word.id);
        const name = wakeWordLookupKey(word.phrase);
        if (id === key || name === key) {
            return map.get(id) ?? map.get(name);
        }
    }
    return undefined;
}

/**
 * Language of a wake word, '' when the table does not name it (see {@link lookup}).
 *
 * @param map - From {@link parseWakeWordLanguages}
 * @param phrase - Wake word phrase the device reported
 * @param available - Wake words the device offers (id and phrase)
 */
export function wakeWordLanguage(map: Map<string, string>, phrase: string, available: WakeWordName[] = []): string {
    return lookup(map, phrase, available) || '';
}

/**
 * Purpose of a wake word: `home` when the table does not name it (see {@link lookup}).
 *
 * @param map - From {@link parseWakeWordProfiles}
 * @param phrase - Wake word phrase the device reported
 * @param available - Wake words the device offers (id and phrase)
 */
export function wakeWordPurpose(
    map: Map<string, WakeWordProfile>,
    phrase: string,
    available: WakeWordName[] = [],
): WakeWordPurpose {
    return lookup(map, phrase, available)?.purpose || 'home';
}

/**
 * The table for the log: "alisa → ru, heybro → de, free questions only".
 *
 * @param map - From {@link parseWakeWordProfiles} (or {@link parseWakeWordLanguages})
 */
export function describeWakeWordLanguages(map: Map<string, string | WakeWordProfile>): string {
    return [...map]
        .map(([key, entry]) => {
            const { language, purpose } = typeof entry === 'string' ? { language: entry, purpose: 'home' } : entry;
            const parts = [language, purpose === 'chat' ? 'free questions only' : ''].filter(Boolean);
            return `${key} → ${parts.join(', ')}`;
        })
        .join(', ');
}
