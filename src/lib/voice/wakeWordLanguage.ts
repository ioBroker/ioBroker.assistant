/**
 * Speech recognition in the language of the wake word: a household that speaks two languages gives each one its own
 * wake word ("Alisa" → Russian, "Hey Bro" → German), and the recording after it is recognised in that language.
 * Speech recognition that guesses the language itself (Parakeet, Whisper without a language) often guesses wrong on a
 * short command: German heard as Russian letters ("Листа светерморган" for "Wie ist das Wetter morgen") or as English.
 */

/** A row of the table `wakeWordLanguages`. */
export interface WakeWordLanguageRow {
    /** The wake word: its phrase ("Hey Bro") or its id ("hey_bro"), case and separators do not matter. */
    wakeWord?: string;
    /** ISO-639-1 code, e.g. `de` or `ru` (`zh-cn` style codes too). */
    language?: string;
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
 * The table of the settings as a map key → language. Rows without a wake word or with an invalid language are left
 * out; the first row of a wake word wins.
 *
 * @param rows - `native.wakeWordLanguages`
 */
export function parseWakeWordLanguages(rows: unknown): Map<string, string> {
    const map = new Map<string, string>();
    const list = Array.isArray(rows) ? rows : rows && typeof rows === 'object' ? Object.values(rows) : [];
    for (const row of list as WakeWordLanguageRow[]) {
        const key = wakeWordKey(row?.wakeWord ?? '');
        const language = String(row?.language ?? '')
            .trim()
            .toLowerCase();
        if (key && LANGUAGE_RE.test(language) && !map.has(key)) {
            map.set(key, language);
        }
    }
    return map;
}

/**
 * Language of a wake word, '' when the table does not name it. The device reports the phrase of the wake word that
 * woke it; the table may name the phrase or the id, so the wake words the device offers translate one into the other.
 *
 * @param map - From {@link parseWakeWordLanguages}
 * @param phrase - Wake word phrase the device reported
 * @param available - Wake words the device offers (id and phrase)
 */
export function wakeWordLanguage(map: Map<string, string>, phrase: string, available: WakeWordName[] = []): string {
    if (!map.size) {
        return '';
    }
    const key = wakeWordKey(phrase);
    if (!key) {
        return '';
    }
    const direct = map.get(key);
    if (direct) {
        return direct;
    }
    for (const word of available) {
        const id = wakeWordKey(word.id);
        const name = wakeWordKey(word.phrase);
        if (id === key || name === key) {
            return map.get(id) || map.get(name) || '';
        }
    }
    return '';
}

/**
 * The table for the log: "alisa → ru, heybro → de".
 *
 * @param map - From {@link parseWakeWordLanguages}
 */
export function describeWakeWordLanguages(map: Map<string, string>): string {
    return [...map].map(([key, language]) => `${key} → ${language}`).join(', ');
}
