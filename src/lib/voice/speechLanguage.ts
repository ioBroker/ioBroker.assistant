/**
 * The language an answer is spoken in. The transports hand the TTS the language the satellite listens in, but an
 * answer can be in another one (a question asked in Russian on a German satellite, pi-agent answering in the language
 * of the question). A German voice reads Cyrillic letter by letter ("kyrillisch a, kyrillisch b …"), so the TTS
 * takes the language of the text:
 *
 * 1. the language the answering tier reported (pi-agent ≥ 0.10.1 returns `language`), unless the letters contradict it;
 * 2. otherwise the letters: a text in another script than the configured language (Cyrillic, Greek, CJK …) is spoken
 *    in the language of that script. Latin letters do not tell German from English: then the configured language
 *    stays, unless it is itself written in another script (a Russian satellite answering in Latin letters → English).
 *
 * {@link LanguageTts} applies this in front of every TTS engine; {@link VoicePerLanguage} picks the voice of the
 * table "voice per language" for it.
 */
import type { TtsEngine, TtsResult } from './tts';

type Script = 'latin' | 'cyrillic' | 'greek' | 'cjk' | 'hangul' | 'arabic' | 'hebrew';

/** Script of the languages that are not written in Latin letters; everything else is Latin. */
const SCRIPT_OF: Record<string, Script> = {
    ru: 'cyrillic',
    uk: 'cyrillic',
    be: 'cyrillic',
    bg: 'cyrillic',
    sr: 'cyrillic',
    mk: 'cyrillic',
    kk: 'cyrillic',
    el: 'greek',
    zh: 'cjk',
    ja: 'cjk',
    ko: 'hangul',
    ar: 'arabic',
    fa: 'arabic',
    he: 'hebrew',
};

const LETTERS: [Script, RegExp][] = [
    ['latin', /[a-zÀ-ɏ]/gi],
    ['cyrillic', /[Ѐ-ӿ]/g],
    ['greek', /[Ͱ-Ͽ]/g],
    ['cjk', /[぀-ヿ㐀-鿿]/g],
    ['hangul', /[가-힯ᄀ-ᇿ]/g],
    ['arabic', /[؀-ۿ]/g],
    ['hebrew', /[֐-׿]/g],
];

/** Fewer letters than this say nothing about the language ("OK", "5 °C"). */
const MIN_LETTERS = 3;

/** Letters only Ukrainian has among the Cyrillic languages. */
const UKRAINIAN = /[ґєії]/i;
/** Kana: Japanese, not Chinese. */
const KANA = /[぀-ヿ]/;

/** ISO-639-1 code of a language or locale: 'ru-RU' → 'ru', 'zh-cn' → 'zh'. */
export function baseLanguage(lang: string | undefined): string {
    return String(lang || '')
        .trim()
        .split(/[-_]/)[0]
        .toLowerCase();
}

function scriptOf(lang: string): Script {
    return SCRIPT_OF[baseLanguage(lang)] || 'latin';
}

/** The script most letters of the text are in; '' for too few letters. */
function dominantScript(text: string): Script | '' {
    let best: Script | '' = '';
    let most = 0;
    let total = 0;
    for (const [script, re] of LETTERS) {
        const count = (text.match(re) || []).length;
        total += count;
        if (count > most) {
            best = script;
            most = count;
        }
    }
    return total >= MIN_LETTERS ? best : '';
}

/**
 * The language a text is written in as far as its letters tell; '' for Latin letters (German or English?) and for
 * too few letters.
 */
export function scriptLanguage(text: string): string {
    const script = dominantScript(String(text || ''));
    switch (script) {
        case 'cyrillic':
            return UKRAINIAN.test(text) ? 'uk' : 'ru';
        case 'greek':
            return 'el';
        case 'cjk':
            return KANA.test(text) ? 'ja' : 'zh';
        case 'hangul':
            return 'ko';
        case 'arabic':
            return 'ar';
        case 'hebrew':
            return 'he';
        default:
            return '';
    }
}

/** Short words only English or only German uses, as they come in spoken commands and questions. */
const ENGLISH_WORDS = new Set([
    'the',
    'is',
    'it',
    "it's",
    'what',
    "what's",
    'how',
    'which',
    'are',
    'of',
    'to',
    'turn',
    'switch',
    'set',
    'off',
    'on',
    'please',
    'time',
    'today',
    'date',
    'lights',
    'minutes',
    'hours',
    'cancel',
    'my',
    'me',
    'tell',
    'much',
]);
const GERMAN_WORDS = new Set([
    'der',
    'die',
    'das',
    'den',
    'dem',
    'ist',
    'es',
    'wie',
    'was',
    'welche',
    'welcher',
    'sind',
    'von',
    'zu',
    'auf',
    'an',
    'aus',
    'ein',
    'schalte',
    'schalt',
    'mach',
    'mache',
    'bitte',
    'uhr',
    'spät',
    'heute',
    'minuten',
    'stunden',
    'licht',
    'viel',
    'im',
    'mir',
    'sag',
    'wieviel',
    'wird',
]);

/**
 * German or English for a text in Latin letters, by its short words ("what time is it" → en, "Schalte das Licht
 * aus" → de); '' when they do not tell. Device and room names in the other language do not count.
 */
export function latinLanguage(text: string): string {
    let en = 0;
    let de = 0;
    for (const word of String(text || '')
        .toLowerCase()
        .split(/[^a-zäöüß']+/)) {
        if (ENGLISH_WORDS.has(word)) {
            en++;
        } else if (GERMAN_WORDS.has(word)) {
            de++;
        }
    }
    return en > de ? 'en' : de > en ? 'de' : '';
}

/** Languages the rule-based NLU has answer texts for. */
const NLU_LANGUAGES = ['de', 'en', 'ru'];

/**
 * The language the rule-based NLU answers a question in when it is not the voice language: a Russian question on a
 * German satellite gets "Сейчас 20:13." instead of "Es ist 20:13 Uhr.". '' = the voice language (Latin letters do
 * not tell German from English, and the NLU has no texts for other languages).
 *
 * @param question what the user said
 * @param voiceLanguage the language of the satellites
 */
export function nluAnswerLanguage(question: string, voiceLanguage: string): string {
    const asked = scriptLanguage(question) || latinLanguage(question);
    return NLU_LANGUAGES.includes(asked) && asked !== baseLanguage(voiceLanguage) ? asked : '';
}

/**
 * The language to speak a text in.
 *
 * @param text what is spoken
 * @param configured the language the caller asked for (the satellite's language)
 * @param reported the language the answering tier reported ('' = none)
 * @returns ISO-639-1 code, or `configured` unchanged when nothing speaks against it
 */
export function speechLanguage(text: string, configured: string, reported?: string): string {
    const script = dominantScript(String(text || ''));
    const said = /^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(String(reported || '').trim()) ? baseLanguage(reported) : '';
    // a report is believed unless the letters contradict it (a "de" mark on a Cyrillic answer)
    if (said && (!script || scriptOf(said) === script)) {
        // the configured language in its own form ('de-DE'): same voice, same cache entry
        return said === baseLanguage(configured) ? configured : said;
    }
    if (!script) {
        return configured;
    }
    const byLetters = scriptLanguage(text);
    if (scriptOf(configured) === script) {
        // the letters fit the configured language; only Ukrainian letters say more than "Cyrillic"
        return byLetters === 'uk' && baseLanguage(configured) !== 'uk' ? 'uk' : configured;
    }
    // Latin letters while the satellite speaks Russian: English is the best guess
    return byLetters || 'en';
}

/**
 * Can this voice speak the language? Told by the locale at the start of its name (`de_DE-thorsten-medium`,
 * `de-DE-KatjaNeural`, `de-DE-Klaus:MAI-Voice-2`); a name without a locale (OpenAI `alloy`, Gemini `Kore`) and a
 * multilingual Azure voice can speak every language.
 */
export function voiceFitsLanguage(voice: string, lang: string): boolean {
    const iso = baseLanguage(lang);
    const locale = /^([a-z]{2,3})[-_][A-Z]{2}(?![a-z])/.exec(String(voice || '').trim());
    if (!iso || !locale || /multilingual/i.test(voice)) {
        return true;
    }
    return locale[1] === iso;
}

/** Parse the config table "voice per language" into ISO code → voice; rows without both are skipped. */
export function parseVoiceTable(rows: unknown): Record<string, string> {
    const table: Record<string, string> = {};
    if (!Array.isArray(rows)) {
        return table;
    }
    for (const row of rows as { language?: unknown; voice?: unknown }[]) {
        const lang = baseLanguage(typeof row?.language === 'string' ? row.language : '');
        const voice = typeof row?.voice === 'string' ? row.voice.trim() : '';
        if (lang && voice) {
            table[lang] = voice;
        }
    }
    return table;
}

/** Log of the TTS layer. */
interface Logger {
    debug(msg: string): void;
}

/**
 * The outermost TTS layer: speaks every text in its own language ({@link speechLanguage}). `reported` looks up the
 * language the answering tier gave for exactly this text.
 */
export class LanguageTts implements TtsEngine {
    constructor(
        private readonly inner: TtsEngine,
        private readonly reported: ((text: string) => string | undefined) | undefined,
        private readonly log: Logger,
    ) {}

    /** The language `text` is spoken in when the caller asks for `lang`. */
    languageFor(text: string, lang: string): string {
        const spoken = speechLanguage(text, lang, this.reported?.(text));
        if (spoken !== lang) {
            this.log.debug(`TTS in '${spoken}' instead of '${lang}': "${String(text).slice(0, 40)}"`);
        }
        return spoken;
    }

    synthesize(text: string, lang: string): Promise<TtsResult> {
        return this.inner.synthesize(text, this.languageFor(text, lang));
    }

    synthesizeSsml(ssml: string, lang: string): Promise<TtsResult> {
        const spoken = this.languageFor(ssml.replace(/<[^>]*>/g, ' '), lang);
        return this.inner.synthesizeSsml
            ? this.inner.synthesizeSsml(ssml, spoken)
            : this.inner.synthesize(ssml, spoken);
    }

    prepare(lang: string): Promise<void> {
        return this.inner.prepare ? this.inner.prepare(lang) : Promise.resolve();
    }

    warm(phrases: string[], lang: string): Promise<number> {
        return this.inner.warm ? this.inner.warm(phrases, lang) : Promise.resolve(0);
    }
}

/**
 * The voices of the table "voice per language": one engine per row, the default engine for every other language.
 * Each engine has its own cache (the directory is per voice).
 */
export class VoicePerLanguage implements TtsEngine {
    constructor(
        private readonly fallback: TtsEngine,
        private readonly byLanguage: Record<string, TtsEngine>,
    ) {}

    private engineFor(lang: string): TtsEngine {
        return this.byLanguage[baseLanguage(lang)] || this.fallback;
    }

    synthesize(text: string, lang: string): Promise<TtsResult> {
        return this.engineFor(lang).synthesize(text, lang);
    }

    synthesizeSsml(ssml: string, lang: string): Promise<TtsResult> {
        const engine = this.engineFor(lang);
        return engine.synthesizeSsml ? engine.synthesizeSsml(ssml, lang) : engine.synthesize(ssml, lang);
    }

    /** The configured language and every language of the table: a Piper voice is a download of ~60 MB. */
    async prepare(lang: string): Promise<void> {
        await this.engineFor(lang).prepare?.(lang);
        for (const [code, engine] of Object.entries(this.byLanguage)) {
            if (code !== baseLanguage(lang)) {
                await engine.prepare?.(code);
            }
        }
    }

    warm(phrases: string[], lang: string): Promise<number> {
        return this.engineFor(lang).warm?.(phrases, lang) ?? Promise.resolve(0);
    }
}
