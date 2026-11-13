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
 * Words that say a Latin-script question is English or German. Only words of one of the two: "in", "an", "die",
 * "was", "will", "so", "man" are both and say nothing. Kept to what short spoken commands and questions use.
 */
const FUNCTION_WORDS: Record<'en' | 'de', ReadonlySet<string>> = {
    en: new Set(
        (
            "the what what's whats is are it it's its how turn switch please light lights time me my of to and you your " +
            'on off set tell which where when who open close this that temperature weather today tomorrow now much many ' +
            'does do can could would there all up down timer alarm minutes hours at for be play stop'
        ).split(' '),
    ),
    de: new Set(
        (
            'der den dem des das ist wie wer wo welche welcher welches schalte schalt mach mache ein eine einen aus bitte ' +
            'licht spät uhr und im es mir mein meine ich du sind auf zu wieviel viel wetter heute morgen jetzt gibt ' +
            'alle stelle stell setze öffne schließe temperatur minuten stunden wecker um nach noch lange sag sage mal ' +
            'kannst spiele spiel'
        ).split(' '),
    ),
};

/** Function words of `lang` in the words of a text; 0 for a language without a list. */
function functionWords(words: string[], lang: string): number {
    const list = FUNCTION_WORDS[lang as 'en' | 'de'];
    return list ? words.filter(w => list.has(w)).length : 0;
}

/**
 * The language a question is asked in, for the fixed answers of the rule NLU ("скажи, сколько сейчас времени" on a
 * German satellite was answered in German). Another script than the configured language's tells it by the letters
 * (like {@link speechLanguage}); for Latin letters English and German are told apart by function words — only with
 * at least two of them and more than twice as many as of the configured language, so a German command with an
 * English device name stays German and a French question on a French system is not taken for German.
 *
 * @returns ISO-639-1 code, or `configured` unchanged when nothing speaks against it
 */
export function questionLanguage(text: string, configured: string): string {
    const question = String(text || '');
    const script = dominantScript(question);
    if (!script) {
        return configured;
    }
    if (script !== 'latin') {
        return speechLanguage(question, configured);
    }
    const words = question.toLowerCase().match(/[\p{L}']+/gu) || [];
    const base = baseLanguage(configured);
    let best = '';
    let most = 0;
    for (const lang of ['en', 'de']) {
        const hits = functionWords(words, lang);
        if (hits > most) {
            best = lang;
            most = hits;
        }
    }
    if (!best || best === base || most < 2 || most <= 2 * functionWords(words, base)) {
        return configured;
    }
    return best;
}

/** How many answers {@link AnswerLanguages} remembers. */
const KEPT_LANGUAGES = 50;

/**
 * The language of recent answers, by their text. An answer travels as plain text through the tiers and transports to
 * the TTS; this finds its language again there. The key is the text without control markers ([[LISTEN]], [[DONE]]):
 * the assistant takes them out before speaking.
 */
export class AnswerLanguages {
    private readonly byText = new Map<string, string>();

    private static key(text: string): string {
        return String(text || '')
            .replace(/\[\[[A-Z]+\]\]/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /** Remember the language of an answer; anything but an ISO code (`ru`, `en-us`) is ignored. */
    remember(text: string, language: string): void {
        const lang = String(language || '')
            .trim()
            .toLowerCase();
        const key = AnswerLanguages.key(text);
        if (!key || !/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(lang)) {
            return;
        }
        this.byText.delete(key);
        this.byText.set(key, lang);
        if (this.byText.size > KEPT_LANGUAGES) {
            this.byText.delete(this.byText.keys().next().value as string);
        }
    }

    /** The language remembered for this answer, '' for none. */
    languageOf(text: string): string {
        return this.byText.get(AnswerLanguages.key(text)) || '';
    }
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

/** A row of the table "voice per language": the voice and/or the TTS model ('' = the ones set above). */
export interface LanguageVoice {
    voice: string;
    model: string;
}

/** Parse the config table "voice per language" into ISO code → voice and model; rows without either are skipped. */
export function parseVoiceTable(rows: unknown): Record<string, LanguageVoice> {
    const table: Record<string, LanguageVoice> = {};
    if (!Array.isArray(rows)) {
        return table;
    }
    for (const row of rows as { language?: unknown; voice?: unknown; model?: unknown }[]) {
        const lang = baseLanguage(typeof row?.language === 'string' ? row.language : '');
        const voice = typeof row?.voice === 'string' ? row.voice.trim() : '';
        const model = typeof row?.model === 'string' ? row.model.trim() : '';
        if (lang && (voice || model)) {
            table[lang] = { voice, model };
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
