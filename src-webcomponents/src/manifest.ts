/**
 * The manifests of `<iob-assistant-chat>` and `<iob-assistant-satellites>`. Read by the build only
 * (`vite.config.ts`), which writes each as `<name>.json` next to its module - a host reads that file for its
 * palette and its settings without loading the module.
 *
 * The assistant has no vis-2 or devices widget, so the names are new: every host shows both components. A word that
 * the instance settings have in every language (`src-admin/src/i18n/`) is taken from there by the build - `admin()`.
 */
import type { WebComponentManifest, WebComponentText } from '@iobroker/web-components';

// with the extension: `vite.config.ts` imports this file, and Vite may load its config natively
import { CHAT_TAG, getModuleFile, SATELLITES_TAG, type ComponentName } from './constants.ts';

const SCHEMA = 'https://raw.githubusercontent.com/ioBroker/web-components/main/schemas/manifest.json';

/** Relative to the manifest in `admin/webcomponents/`: the icon of the adapter */
const ICON = '../assistant.svg';

const INSTANCE: WebComponentText = {
    en: 'Instance',
    de: 'Instanz',
    ru: 'Экземпляр',
    pt: 'Instância',
    nl: 'Instantie',
    fr: 'Instance',
    it: 'Istanza',
    es: 'Instancia',
    pl: 'Instancja',
    uk: 'Екземпляр',
    'zh-cn': '实例',
};

/**
 * The manifests, with the words of the instance settings
 *
 * @param admin a word of `src-admin/src/i18n/` (without the prefix `custom_assistant_`) in every language
 */
export function buildManifests(admin: (key: string) => WebComponentText): Record<ComponentName, WebComponentManifest> {
    const chat: WebComponentManifest = {
        $schema: SCHEMA,
        manifestVersion: 1,
        tag: CHAT_TAG,
        name: {
            en: 'Assistant chat',
            de: 'Assistent-Chat',
            ru: 'Чат ассистента',
            pt: 'Chat do assistente',
            nl: 'Assistent-chat',
            fr: "Chat de l'assistant",
            it: "Chat dell'assistente",
            es: 'Chat del asistente',
            pl: 'Czat asystenta',
            uk: 'Чат асистента',
            'zh-cn': '助手聊天',
        },
        description: {
            en: 'Talk to the assistant from a dashboard: type a question or speak it, with the answers live',
            de: 'Mit dem Assistenten vom Dashboard aus sprechen: Frage tippen oder sagen, die Antworten live',
            ru: 'Общайтесь с ассистентом с панели: напечатайте или произнесите вопрос, ответы в реальном времени',
            pt: 'Fale com o assistente a partir de um painel: escreva ou diga uma pergunta, com as respostas ao vivo',
            nl: 'Praat vanaf een dashboard met de assistent: typ of spreek een vraag in, met de antwoorden live',
            fr: "Parlez à l'assistant depuis un tableau de bord : tapez ou dites une question, avec les réponses en direct",
            it: "Parla con l'assistente da una dashboard: scrivi o pronuncia una domanda, con le risposte in tempo reale",
            es: 'Hable con el asistente desde un panel: escriba o diga una pregunta, con las respuestas en directo',
            pl: 'Rozmawiaj z asystentem z pulpitu: wpisz lub wypowiedz pytanie, odpowiedzi na żywo',
            uk: 'Спілкуйтеся з асистентом з панелі: надрукуйте або промовте запитання, відповіді в реальному часі',
            'zh-cn': '在仪表板上与助手对话：输入或说出问题，实时显示回答',
        },
        icon: ICON,
        module: getModuleFile('assistant-chat'),
        size: { width: 400, height: 500 },
        settings: {
            type: 'panel',
            items: {
                instance: {
                    type: 'instance',
                    adapter: 'assistant',
                    default: 'assistant.0',
                    label: INSTANCE,
                },
                allRequests: {
                    type: 'checkbox',
                    default: false,
                    label: {
                        en: 'Show all requests',
                        de: 'Alle Anfragen zeigen',
                        ru: 'Показывать все запросы',
                        pt: 'Mostrar todos os pedidos',
                        nl: 'Alle verzoeken tonen',
                        fr: 'Afficher toutes les requêtes',
                        it: 'Mostra tutte le richieste',
                        es: 'Mostrar todas las solicitudes',
                        pl: 'Pokaż wszystkie zapytania',
                        uk: 'Показувати всі запити',
                        'zh-cn': '显示所有请求',
                    },
                    help: {
                        en: 'Also the requests of the satellites, Telegram and scripts - not only those of the chat',
                        de: 'Auch die Anfragen der Satelliten, von Telegram und Skripten - nicht nur die des Chats',
                        ru: 'Также запросы сателлитов, Telegram и скриптов, а не только чата',
                        pt: 'Também os pedidos dos satélites, do Telegram e de scripts - não só os do chat',
                        nl: 'Ook de verzoeken van de satellieten, Telegram en scripts - niet alleen die van de chat',
                        fr: 'Aussi les requêtes des satellites, de Telegram et des scripts - pas seulement celles du chat',
                        it: 'Anche le richieste dei satelliti, di Telegram e degli script - non solo quelle della chat',
                        es: 'También las solicitudes de los satélites, Telegram y scripts, no solo las del chat',
                        pl: 'Także zapytania satelitów, Telegrama i skryptów - nie tylko czatu',
                        uk: 'Також запити сателітів, Telegram і скриптів, а не лише чату',
                        'zh-cn': '也包括卫星、Telegram 和脚本的请求，而不仅是聊天的请求',
                    },
                },
                details: {
                    type: 'checkbox',
                    default: false,
                    label: {
                        en: 'Show processing details',
                        de: 'Verarbeitungsdetails anzeigen',
                        ru: 'Показывать детали обработки',
                        pt: 'Mostrar detalhes do processamento',
                        nl: 'Verwerkingsdetails tonen',
                        fr: 'Afficher les détails du traitement',
                        it: 'Mostra i dettagli di elaborazione',
                        es: 'Mostrar detalles del procesamiento',
                        pl: 'Pokaż szczegóły przetwarzania',
                        uk: 'Показувати деталі обробки',
                        'zh-cn': '显示处理详情',
                    },
                    help: {
                        en: 'Who answered (rule-based NLU, local or cloud model), how long it took and which states it wrote',
                        de: 'Wer geantwortet hat (Regel-NLU, lokales oder Cloud-Modell), wie lange es dauerte und welche Datenpunkte geschrieben wurden',
                        ru: 'Кто ответил (NLU по правилам, локальная или облачная модель), сколько это заняло и какие состояния были записаны',
                        pt: 'Quem respondeu (NLU por regras, modelo local ou na nuvem), quanto tempo demorou e que estados escreveu',
                        nl: 'Wie antwoordde (regelgebaseerde NLU, lokaal of cloudmodel), hoe lang het duurde en welke datapunten werden geschreven',
                        fr: 'Qui a répondu (NLU à règles, modèle local ou cloud), combien de temps cela a pris et quels états ont été écrits',
                        it: 'Chi ha risposto (NLU a regole, modello locale o cloud), quanto tempo ha impiegato e quali stati ha scritto',
                        es: 'Quién respondió (NLU por reglas, modelo local o en la nube), cuánto tardó y qué estados escribió',
                        pl: 'Kto odpowiedział (NLU oparte na regułach, model lokalny lub w chmurze), ile to trwało i jakie stany zapisano',
                        uk: 'Хто відповів (NLU за правилами, локальна чи хмарна модель), скільки це тривало і які стани записано',
                        'zh-cn': '由谁回答（基于规则的 NLU、本地或云端模型）、耗时多久以及写入了哪些状态',
                    },
                },
                speak: {
                    type: 'checkbox',
                    default: false,
                    label: {
                        en: 'Read answers aloud',
                        de: 'Antworten vorlesen',
                        ru: 'Читать ответы вслух',
                        pt: 'Ler as respostas em voz alta',
                        nl: 'Antwoorden voorlezen',
                        fr: 'Lire les réponses à voix haute',
                        it: 'Leggere le risposte ad alta voce',
                        es: 'Leer las respuestas en voz alta',
                        pl: 'Czytaj odpowiedzi na głos',
                        uk: 'Читати відповіді вголос',
                        'zh-cn': '朗读回答',
                    },
                    help: {
                        en: 'With the voice of the satellites if one is configured, else with the voice of the browser',
                        de: 'Mit der Stimme der Satelliten, wenn eine eingerichtet ist, sonst mit der des Browsers',
                        ru: 'Голосом сателлитов, если он настроен, иначе голосом браузера',
                        pt: 'Com a voz dos satélites, se estiver configurada, senão com a voz do navegador',
                        nl: 'Met de stem van de satellieten als die is ingesteld, anders met die van de browser',
                        fr: 'Avec la voix des satellites si elle est configurée, sinon avec celle du navigateur',
                        it: 'Con la voce dei satelliti se configurata, altrimenti con quella del browser',
                        es: 'Con la voz de los satélites si está configurada, si no con la del navegador',
                        pl: 'Głosem satelitów, jeśli jest skonfigurowany, w przeciwnym razie głosem przeglądarki',
                        uk: 'Голосом сателітів, якщо його налаштовано, інакше голосом браузера',
                        'zh-cn': '若已配置则使用卫星的语音，否则使用浏览器的语音',
                    },
                },
            },
        },
    };

    const satellites: WebComponentManifest = {
        $schema: SCHEMA,
        manifestVersion: 1,
        tag: SATELLITES_TAG,
        name: {
            en: 'Voice satellites',
            de: 'Sprach-Satelliten',
            ru: 'Голосовые сателлиты',
            pt: 'Satélites de voz',
            nl: 'Spraaksatellieten',
            fr: 'Satellites vocaux',
            it: 'Satelliti vocali',
            es: 'Satélites de voz',
            pl: 'Satelity głosowe',
            uk: 'Голосові сателіти',
            'zh-cn': '语音卫星',
        },
        description: {
            en: 'The voice satellites of the assistant live - status, room, last seen - with announcements on one or all of them',
            de: 'Die Sprach-Satelliten des Assistenten live - Status, Raum, zuletzt gesehen - mit Ansagen auf einem oder allen',
            ru: 'Голосовые сателлиты ассистента в реальном времени — статус, комната, последняя активность — с объявлениями на одном или на всех',
            pt: 'Os satélites de voz do assistente ao vivo - estado, divisão, última vez visto - com anúncios num ou em todos',
            nl: 'De spraaksatellieten van de assistent live - status, kamer, laatst gezien - met aankondigingen op één of alle',
            fr: "Les satellites vocaux de l'assistant en direct - état, pièce, dernière activité - avec des annonces sur un ou tous",
            it: "I satelliti vocali dell'assistente in tempo reale - stato, stanza, ultimo contatto - con annunci su uno o su tutti",
            es: 'Los satélites de voz del asistente en directo - estado, habitación, última conexión - con anuncios en uno o en todos',
            pl: 'Satelity głosowe asystenta na żywo - stan, pokój, ostatnio widziany - z ogłoszeniami na jednym lub wszystkich',
            uk: 'Голосові сателіти асистента в реальному часі — стан, кімната, остання активність — з оголошеннями на одному або на всіх',
            'zh-cn': '实时显示助手的语音卫星——状态、房间、最后在线——可向单个或全部卫星播报',
        },
        icon: ICON,
        module: getModuleFile('assistant-satellites'),
        size: { width: 440, height: 300 },
        settings: {
            type: 'panel',
            items: {
                instance: {
                    type: 'instance',
                    adapter: 'assistant',
                    default: 'assistant.0',
                    label: INSTANCE,
                },
                announce: {
                    type: 'checkbox',
                    default: true,
                    label: admin('Announcement'),
                    help: {
                        en: 'Speak a text on one satellite or on all of them',
                        de: 'Einen Text auf einem Satelliten oder auf allen ansagen',
                        ru: 'Произнести текст на одном или на всех сателлитах',
                        pt: 'Dizer um texto num satélite ou em todos',
                        nl: 'Een tekst uitspreken op één satelliet of op alle',
                        fr: 'Prononcer un texte sur un satellite ou sur tous',
                        it: 'Pronunciare un testo su un satellite o su tutti',
                        es: 'Decir un texto en un satélite o en todos',
                        pl: 'Wypowiedz tekst na jednym satelicie lub na wszystkich',
                        uk: 'Промовити текст на одному або на всіх сателітах',
                        'zh-cn': '在一个或全部卫星上播报一段文字',
                    },
                },
                showHost: {
                    type: 'checkbox',
                    default: false,
                    label: {
                        en: 'Show host',
                        de: 'Host anzeigen',
                        ru: 'Показывать хост',
                        pt: 'Mostrar host',
                        nl: 'Host tonen',
                        fr: "Afficher l'hôte",
                        it: 'Mostra host',
                        es: 'Mostrar host',
                        pl: 'Pokaż host',
                        uk: 'Показувати хост',
                        'zh-cn': '显示主机',
                    },
                    help: {
                        en: 'The address the satellite runs on',
                        de: 'Die Adresse, unter der der Satellit läuft',
                        ru: 'Адрес, на котором работает сателлит',
                        pt: 'O endereço em que o satélite funciona',
                        nl: 'Het adres waarop de satelliet draait',
                        fr: "L'adresse sur laquelle tourne le satellite",
                        it: "L'indirizzo su cui funziona il satellite",
                        es: 'La dirección en la que funciona el satélite',
                        pl: 'Adres, pod którym działa satelita',
                        uk: 'Адреса, на якій працює сателіт',
                        'zh-cn': '卫星运行所在的地址',
                    },
                },
            },
        },
    };

    return { 'assistant-chat': chat, 'assistant-satellites': satellites };
}
