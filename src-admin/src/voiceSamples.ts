/**
 * Sentence to try a voice with, per language. The backend speaks a text in the language its letters tell, so a
 * language without a sentence here gets the English one — and then the English voice, not the one of its row.
 */
export const SAMPLES: Record<string, string> = {
    de: 'Hallo, ich bin dein ioBroker-Assistent. Im Wohnzimmer sind es 21,5 Grad.',
    en: "Hello, I'm your ioBroker assistant. It is 21.5 degrees in the living room.",
    ru: 'Привет, я твой ассистент ioBroker. В гостиной 21,5 градуса.',
    fr: 'Bonjour, je suis ton assistant ioBroker. Il fait 21,5 degrés dans le salon.',
    it: 'Ciao, sono il tuo assistente ioBroker. In soggiorno ci sono 21,5 gradi.',
    es: 'Hola, soy tu asistente de ioBroker. En el salón hace 21,5 grados.',
    nl: 'Hallo, ik ben je ioBroker-assistent. In de woonkamer is het 21,5 graden.',
    pl: 'Cześć, jestem twoim asystentem ioBroker. W salonie jest 21,5 stopnia.',
    pt: 'Olá, sou o teu assistente ioBroker. Na sala estão 21,5 graus.',
    uk: 'Привіт, я твій асистент ioBroker. У вітальні 21,5 градуса.',
    'zh-cn': '你好，我是你的 ioBroker 助手。客厅现在是 21.5 度。',
    zh: '你好，我是你的 ioBroker 助手。客厅现在是 21.5 度。',
    ja: 'こんにちは、ioBroker アシスタントです。リビングは 21.5 度です。',
    el: 'Γεια σου, είμαι ο βοηθός σου ioBroker. Στο σαλόνι έχει 21,5 βαθμούς.',
    tr: 'Merhaba, ben ioBroker asistanınım. Oturma odasında sıcaklık 21,5 derece.',
    cs: 'Ahoj, jsem tvůj asistent ioBroker. V obývacím pokoji je 21,5 stupně.',
    sv: 'Hej, jag är din ioBroker-assistent. I vardagsrummet är det 21,5 grader.',
};

/** The test sentence of a language ('de-DE' → 'de'), English when there is none */
export function sampleFor(language: string): string {
    const lang = String(language || '')
        .trim()
        .toLowerCase();
    return SAMPLES[lang] || SAMPLES[lang.split(/[-_]/)[0]] || SAMPLES.en;
}
