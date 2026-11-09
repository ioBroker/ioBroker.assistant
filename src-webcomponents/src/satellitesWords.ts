/**
 * The words `<iob-assistant-satellites>` shows that the satellites tab of the instance settings does not have, or
 * has in English only - the others are picked by the build out of `src-admin/src/i18n/` (`SATELLITES_ADMIN_WORDS`
 * in `adminWords.ts`).
 */
import { SATELLITES_ADMIN_WORDS } from './adminWords';
import { createWords, type Dictionary } from './i18n';

const EN = {
    online: 'online',
    offline: 'offline',
    status_idle: 'idle',
    status_listening: 'listening',
    status_processing: 'processing',
    status_speaking: 'speaking',
    whatToSay: 'What to say',
};

const SATELLITES_WORDS: Dictionary<keyof typeof EN> = {
    en: EN,
    de: {
        online: 'online',
        offline: 'offline',
        status_idle: 'bereit',
        status_listening: 'hört zu',
        status_processing: 'verarbeitet',
        status_speaking: 'spricht',
        whatToSay: 'Was gesagt werden soll',
    },
    ru: {
        online: 'в сети',
        offline: 'не в сети',
        status_idle: 'ожидание',
        status_listening: 'слушает',
        status_processing: 'обработка',
        status_speaking: 'говорит',
        whatToSay: 'Что сказать',
    },
    pt: {
        online: 'online',
        offline: 'offline',
        status_idle: 'em espera',
        status_listening: 'a ouvir',
        status_processing: 'a processar',
        status_speaking: 'a falar',
        whatToSay: 'O que dizer',
    },
    nl: {
        online: 'online',
        offline: 'offline',
        status_idle: 'inactief',
        status_listening: 'luistert',
        status_processing: 'verwerkt',
        status_speaking: 'spreekt',
        whatToSay: 'Wat er gezegd moet worden',
    },
    fr: {
        online: 'en ligne',
        offline: 'hors ligne',
        status_idle: 'en attente',
        status_listening: 'écoute',
        status_processing: 'traitement',
        status_speaking: 'parle',
        whatToSay: 'Ce qu’il faut dire',
    },
    it: {
        online: 'online',
        offline: 'offline',
        status_idle: 'inattivo',
        status_listening: 'in ascolto',
        status_processing: 'elaborazione',
        status_speaking: 'parla',
        whatToSay: 'Cosa dire',
    },
    es: {
        online: 'en línea',
        offline: 'sin conexión',
        status_idle: 'en espera',
        status_listening: 'escuchando',
        status_processing: 'procesando',
        status_speaking: 'hablando',
        whatToSay: 'Qué decir',
    },
    pl: {
        online: 'online',
        offline: 'offline',
        status_idle: 'bezczynny',
        status_listening: 'słucha',
        status_processing: 'przetwarza',
        status_speaking: 'mówi',
        whatToSay: 'Co powiedzieć',
    },
    uk: {
        online: 'у мережі',
        offline: 'не в мережі',
        status_idle: 'очікування',
        status_listening: 'слухає',
        status_processing: 'обробка',
        status_speaking: 'говорить',
        whatToSay: 'Що сказати',
    },
    'zh-cn': {
        online: '在线',
        offline: '离线',
        status_idle: '空闲',
        status_listening: '聆听中',
        status_processing: '处理中',
        status_speaking: '播报中',
        whatToSay: '播报内容',
    },
};

/** The words of the element in the language of the system: its own, those of the instance settings, the common ones */
export const getSatellitesWords = createWords(SATELLITES_WORDS, SATELLITES_ADMIN_WORDS);

/** The words of the element in one language */
export type SatellitesWords = ReturnType<typeof getSatellitesWords>;
