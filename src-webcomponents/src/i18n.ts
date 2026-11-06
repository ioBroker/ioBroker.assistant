/**
 * The words the elements show, in the languages of ioBroker.
 *
 * Most of them are those of the chat and the satellites tab of the instance settings (`src-admin/src/i18n/`, keys
 * `custom_assistant_<word>`): the build of a component picks the words its `adminWords.ts` list names out of those
 * files (`vite.config.ts`) - the whole dictionary would be most of the module. The words that the settings do not
 * have, or have in English only, are in `chatWords.ts` and `satellitesWords.ts`, those of the manifests in
 * `manifest.ts`.
 */

/** Picked by the build of the component: language -> word of its `adminWords.ts` list -> text */
declare const __ASSISTANT_ADMIN_WORDS__: Record<string, Record<string, string>>;

/** Once: the build writes the words wherever the name stands */
const ADMIN: Record<string, Record<string, string>> = __ASSISTANT_ADMIN_WORDS__;

/** Own words of an element: language -> word -> text */
export type Dictionary<K extends string> = Record<string, Record<K, string>>;

/** The words of both elements */
const COMMON: Dictionary<'chooseInstance'> = {
    en: {
        chooseInstance: 'Choose an instance of the assistant in the settings',
    },
    de: {
        chooseInstance: 'Instanz des Assistenten in den Einstellungen wählen',
    },
    ru: {
        chooseInstance: 'Выберите экземпляр ассистента в настройках',
    },
    pt: {
        chooseInstance: 'Escolha uma instância do assistente nas configurações',
    },
    nl: {
        chooseInstance: 'Kies een instantie van de assistent in de instellingen',
    },
    fr: {
        chooseInstance: "Choisissez une instance de l'assistant dans les paramètres",
    },
    it: {
        chooseInstance: "Scegli un'istanza dell'assistente nelle impostazioni",
    },
    es: {
        chooseInstance: 'Elija una instancia del asistente en la configuración',
    },
    pl: {
        chooseInstance: 'Wybierz instancję asystenta w ustawieniach',
    },
    uk: {
        chooseInstance: 'Виберіть екземпляр асистента в налаштуваннях',
    },
    'zh-cn': {
        chooseInstance: '请在设置中选择助手实例',
    },
};

/**
 * The words of an element: its own, those of the instance settings the build picked for it, the common ones
 *
 * @param own the own words of the element, `en` complete
 * @param admin the words of the instance settings the build picks for the element (`adminWords.ts`)
 * @returns the words in one language: the text of a word, English if it has none in that language
 */
export function createWords<K extends string, A extends string>(
    own: Dictionary<K>,
    admin: readonly A[],
): (lang: string) => (key: K | A | 'chooseInstance') => string {
    return (lang: string) =>
        (key: K | A | 'chooseInstance'): string => {
            if (key in own.en) {
                return own[lang]?.[key as K] || own.en[key as K];
            }
            if (key === 'chooseInstance') {
                return COMMON[lang]?.chooseInstance || COMMON.en.chooseInstance;
            }
            if (!admin.includes(key as A)) {
                return key;
            }
            return ADMIN[lang]?.[key] || ADMIN.en?.[key] || key;
        };
}

/** The language of the system as a BCP 47 tag, for `Intl` and the speech APIs of the browser */
export function toLocale(lang: string): string {
    const map: Record<string, string> = {
        de: 'de-DE',
        en: 'en-US',
        ru: 'ru-RU',
        pt: 'pt-PT',
        nl: 'nl-NL',
        fr: 'fr-FR',
        it: 'it-IT',
        es: 'es-ES',
        pl: 'pl-PL',
        uk: 'uk-UA',
        'zh-cn': 'zh-CN',
    };
    return map[lang] || lang || 'en-US';
}
