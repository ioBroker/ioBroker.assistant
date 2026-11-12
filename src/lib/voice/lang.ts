/**
 * Map an ISO-639-1 language code (or an already-qualified locale) to a BCP-47 locale,
 * as required by Azure Speech and AWS (Polly/Transcribe). OpenAI/Whisper uses the bare
 * ISO code, so those engines strip the region again.
 */
const LOCALES: Record<string, string> = {
    de: 'de-DE',
    en: 'en-US',
    ru: 'ru-RU',
    fr: 'fr-FR',
    it: 'it-IT',
    es: 'es-ES',
    nl: 'nl-NL',
    pl: 'pl-PL',
    pt: 'pt-PT',
    uk: 'uk-UA',
    zh: 'zh-CN',
};

export function isoToLocale(lang: string, fallback = 'en-US'): string {
    if (!lang) {
        return fallback;
    }
    if (lang.includes('-')) {
        // Already a locale (e.g. 'zh-cn') — normalise casing to 'zh-CN'.
        const [l, r] = lang.split('-');
        return `${l.toLowerCase()}-${r.toUpperCase()}`;
    }
    return LOCALES[lang.toLowerCase()] || fallback;
}

/** Letters only Ukrainian has among the Cyrillic languages the adapter speaks. */
const UKRAINIAN = /[ґєії]/i;
const CYRILLIC = /[\u0400-\u04ff]/g;
const LATIN = /[a-z\u00c0-\u024f]/gi;
const CJK = /[\u3040-\u30ff\u3400-\u9fff]/g;

/**
 * The language a text is written in as far as its letters tell: Cyrillic (Ukrainian by its own letters) and Chinese;
 * '' for Latin letters, which do not tell German from English.
 */
export function scriptLanguage(text: string): string {
    const cyrillic = (text.match(CYRILLIC) || []).length;
    const latin = (text.match(LATIN) || []).length;
    const cjk = (text.match(CJK) || []).length;
    if (cjk > latin && cjk > cyrillic) {
        return 'zh';
    }
    if (cyrillic > latin) {
        return UKRAINIAN.test(text) ? 'uk' : 'ru';
    }
    return '';
}

/**
 * The language to speak an answer in. A satellite listening in German can get a Russian answer (speech recognition
 * returned Russian text, or the user asked in Russian); a German voice would spell its letters one by one.
 *
 * @param text the answer
 * @param configured the voice language of the adapter
 * @param hint the language the answering model reported (pi-agent: `language` of the answer), '' when unknown
 */
export function speechLanguage(text: string, configured: string, hint = ''): string {
    const base = (configured || '').split('-')[0].toLowerCase();
    const reported = (hint || '').trim().toLowerCase();
    if (/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(reported)) {
        return reported.split('-')[0] === base ? configured : reported;
    }
    const seen = scriptLanguage(text);
    return seen && seen !== base ? seen : configured;
}
