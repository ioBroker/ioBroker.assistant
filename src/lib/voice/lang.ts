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
