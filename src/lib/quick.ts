/**
 * Quick commands for the families of the shared catalog (`HELP.md`), understood without a model: "Ruf Anna an"
 * (`phone.call`), "Zeige die Haustür auf dem Küchendisplay" (`screen.show`), "Schick mir ein Bild der Haustür"
 * (`camera.snapshot` → `message.send`). The parsers only split the sentence; which names exist (screens, cameras,
 * recipients) is asked from the instances by the caller, and a sentence whose names fit nothing goes on to the
 * other tiers.
 */

export type QuickLanguage = 'de' | 'en' | 'ru';

/** A word of the sentence: as written (for names and texts) and lower case (for matching). */
interface Word {
    raw: string;
    low: string;
}

function words(text: string): Word[] {
    return [...text.matchAll(/[\p{L}\p{N}+#*]+(?:['’-][\p{L}\p{N}]+)*/gu)].map(m => ({
        raw: m[0],
        low: m[0].toLowerCase().replace(/ё/g, 'е'),
    }));
}

const join = (list: Word[]): string => list.map(w => w.raw).join(' ');

/** Polite words, taken away at the start and the end. */
const POLITE = new Set([
    'bitte',
    'mal',
    'doch',
    'kannst',
    'du',
    'könntest',
    'please',
    'can',
    'could',
    'you',
    'пожалуйста',
    'можешь',
    'ну',
]);
const ARTICLES = new Set(['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'the', 'a', 'an']);

function trimPolite(list: Word[]): Word[] {
    let a = 0;
    let b = list.length;
    while (a < b && POLITE.has(list[a].low)) {
        a++;
    }
    while (b > a && POLITE.has(list[b - 1].low)) {
        b--;
    }
    return list.slice(a, b);
}

function trimArticles(list: Word[]): Word[] {
    let a = 0;
    while (a < list.length && ARTICLES.has(list[a].low)) {
        a++;
    }
    return list.slice(a);
}

/**
 * A said name fits a known one: the same without case, or every said word is a word of the name up to an ending
 * ("Anne"/"Anna", "Küche"/"Küchendisplay" does not, "кухню"/"Кухня" does).
 *
 * @param said as said
 * @param name as known
 */
export function nameFits(said: string, name: string): boolean {
    const a = said
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
    const b = name
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
    if (!a || !b) {
        return false;
    }
    if (a === b || a.replace(/ /g, '') === b.replace(/ /g, '')) {
        return true;
    }
    const saidWords = a.split(' ');
    const nameWords = b.split(' ');
    return saidWords.every(s => nameWords.some(n => sameStem(s, n)));
}

/** One word for another up to an inflected ending of at most two letters ("кухню"/"кухня", "Annas"/"Anna"). */
function sameStem(a: string, b: string): boolean {
    if (a === b) {
        return true;
    }
    const short = a.length < b.length ? a : b;
    const long = a.length < b.length ? b : a;
    if (short.length < 3 || long.length - short.length > 2) {
        return false;
    }
    let common = 0;
    while (common < short.length && short[common] === long[common]) {
        common++;
    }
    return common >= Math.max(3, short.length - 1);
}

/**
 * The best of several named things for a said name: an exact name, then an exact room, then a fitting name, then a
 * fitting room. Several fit equally → all of them (the caller asks back).
 */
export function pickNamed<T extends { id: string; name: string; room?: string }>(items: T[], said: string): T[] {
    const s = said.trim();
    if (!s) {
        return [];
    }
    const low = s.toLowerCase();
    const rules: ((i: T) => boolean)[] = [
        i => i.name.toLowerCase() === low || i.id.toLowerCase() === low,
        i => !!i.room && i.room.toLowerCase() === low,
        i => nameFits(s, i.name),
        i => !!i.room && nameFits(s, i.room),
    ];
    for (const rule of rules) {
        const hits = items.filter(rule);
        if (hits.length) {
            return hits;
        }
    }
    return [];
}

// ── phone.call ──────────────────────────────────────────────────────────────

export interface CallCommand {
    /** A name or a number, as said */
    to: string;
    language: QuickLanguage;
}

/**
 * "Ruf Anna an", "Rufe bitte die Küche an", "Anna anrufen", "Verbinde mich mit der Tür", "Call Anna", "Connect me
 * with the door", "Позвони Анне", "Набери 0171 2345". Null for anything else ("Wer hat angerufen?").
 */
export function parseCallCommand(text: string): CallCommand | null {
    const w = trimPolite(words(text));
    if (w.length < 2) {
        return null;
    }
    const first = w[0].low;
    const last = w[w.length - 1].low;
    let target: Word[] | null = null;
    let language: QuickLanguage = 'de';
    if ((first === 'ruf' || first === 'rufe') && last === 'an' && w.length >= 3) {
        target = w.slice(1, -1);
    } else if (last === 'anrufen' && w.length >= 2 && !['wer', 'wen', 'kann', 'soll'].includes(first)) {
        target = w.slice(0, -1);
    } else if (first === 'verbinde' && w[1]?.low === 'mich' && w[2]?.low === 'mit') {
        target = w.slice(3);
    } else if (first === 'telefoniere' && w[1]?.low === 'mit') {
        target = w.slice(2);
    } else if (first === 'waehle' || first === 'wähle') {
        target = w.slice(1);
    } else if (['call', 'phone', 'ring', 'dial'].includes(first)) {
        language = 'en';
        target = w.slice(1);
    } else if (first === 'connect' && w[1]?.low === 'me' && ['with', 'to'].includes(w[2]?.low)) {
        language = 'en';
        target = w.slice(3);
    } else if (['позвони', 'позвонить', 'набери', 'звони', 'вызови'].includes(first)) {
        language = 'ru';
        target = w.slice(1);
    } else if (first === 'соедини' && w[1]?.low === 'меня' && ['с', 'со'].includes(w[2]?.low)) {
        language = 'ru';
        target = w.slice(3);
    }
    if (!target) {
        return null;
    }
    target = trimArticles(trimPolite(target));
    if (!target.length || target.length > 5) {
        return null;
    }
    // "call me back", "ruf mich an": no target
    if (['me', 'mich', 'uns', 'us', 'мне', 'меня', 'back'].includes(target[0].low)) {
        return null;
    }
    const said = join(target);
    // a number with spaces: "0171 234 56"
    const to = /^[+\d][\d ]+$/.test(said) ? said.replace(/ /g, '') : said;
    return { to, language };
}

// ── screen.show ─────────────────────────────────────────────────────────────

export interface ShowOnCommand {
    /** What to show, as said ("die Haustür", "die Kamera Einfahrt", "die Ansicht Wetter") */
    what: string;
    /** Where, as said ("Küchendisplay", "Wohnzimmer"); '' = not said */
    screen: string;
    language: QuickLanguage;
}

const SHOW_VERBS: Record<string, QuickLanguage> = {
    zeig: 'de',
    zeige: 'de',
    zeigen: 'de',
    show: 'en',
    display: 'en',
    покажи: 'ru',
    показать: 'ru',
    выведи: 'ru',
    отобрази: 'ru',
};
const SHOW_FILLERS = new Set(['mir', 'uns', 'me', 'us', 'мне', 'нам']);
/** The preposition before the screen: "auf dem Fernseher", "im Wohnzimmer", "on the TV", "на телевизоре". */
const SCREEN_PREPOSITIONS = new Set(['auf', 'im', 'am', 'on', 'на', 'в', 'во']);

/**
 * "Zeige die Haustür auf dem Küchendisplay", "Zeig mir die Kamera Einfahrt im Wohnzimmer", "Show the front door on
 * the TV", "Покажи камеру у входа на телевизоре". The last preposition before a screen splits the sentence (the
 * camera "an der Haustür" stays in `what`). Null without a show verb or without anything to show.
 */
export function parseShowOnCommand(text: string): ShowOnCommand | null {
    const w = trimPolite(words(text));
    const language = w.length ? SHOW_VERBS[w[0].low] : undefined;
    if (!language) {
        return null;
    }
    let rest = w.slice(1);
    while (rest.length && (SHOW_FILLERS.has(rest[0].low) || POLITE.has(rest[0].low))) {
        rest = rest.slice(1);
    }
    rest = trimPolite(rest);
    let split = -1;
    for (let i = rest.length - 1; i > 0; i--) {
        if (SCREEN_PREPOSITIONS.has(rest[i].low) || (rest[i].low === 'in' && i > 0)) {
            split = i;
            break;
        }
    }
    const whatWords = trimArticles(split > 0 ? rest.slice(0, split) : rest);
    const screenWords = split > 0 ? trimArticles(rest.slice(split + 1)) : [];
    if (!whatWords.length) {
        return null;
    }
    return { what: join(whatWords), screen: join(screenWords), language };
}

/** What a show request names: a camera, a view or a text; the name is without the kind word. */
export interface ShowTarget {
    kind: 'camera' | 'view' | 'text' | 'unknown';
    name: string;
}

const CAMERA_WORDS = /^(kamera|kameras|camera|cam|livebild|videobild|камер\p{L}*|видеокамер\p{L}*)$/u;
const VIEW_WORDS = /^(ansicht|seite|view|page|screen|вид|страниц\p{L}*|экран)$/u;
const TEXT_WORDS = /^(text|nachricht|message|текст|сообщение|надпись)$/u;
const LINK_WORDS = new Set(['von', 'vom', 'der', 'des', 'of', 'from', 'the', 'с', 'со', 'у', 'из']);

/**
 * What kind of thing a show request names: "Kamera Einfahrt" / "die Einfahrt-Kamera" / "камеру у входа" = camera,
 * "die Ansicht Wetter" = view, "den Text Essen ist fertig" = text (as written); else unknown with the whole name
 * (the caller looks it up among cameras and views).
 */
export function showTarget(what: string): ShowTarget {
    const w = trimArticles(words(what));
    if (!w.length) {
        return { kind: 'unknown', name: '' };
    }
    if (TEXT_WORDS.test(w[0].low)) {
        // the text as said, punctuation included
        const m = what.match(/^\s*(?:(?:der|die|das|den|the)\s+)?\S+\s+(.*)$/iu);
        return { kind: 'text', name: (m?.[1] || '').trim() };
    }
    /** The words without the one that says the kind (and "von", "of", "у" …); null when no word says it. */
    const without = (re: RegExp): string | null => {
        const i = w.findIndex(x => re.test(x.low));
        return i < 0 ? null : join(w.filter((x, j) => j !== i && !LINK_WORDS.has(x.low) && !ARTICLES.has(x.low)));
    };
    const camera = without(CAMERA_WORDS);
    if (camera !== null) {
        return { kind: 'camera', name: camera };
    }
    // "die Einfahrt-Kamera", "die Einfahrtkamera": the word without the kind
    const compound = w.findIndex(x => /^\p{L}{3,}-?(kamera|camera|cam)$/u.test(x.low));
    if (compound >= 0) {
        const own = w[compound].raw.replace(/-?(kamera|camera|cam)$/iu, '');
        const others = w.filter((x, j) => j !== compound && !LINK_WORDS.has(x.low) && !ARTICLES.has(x.low));
        return {
            kind: 'camera',
            name: join([...others.slice(0, compound), { raw: own, low: own }, ...others.slice(compound)]),
        };
    }
    const view = without(VIEW_WORDS);
    if (view !== null) {
        return { kind: 'view', name: view };
    }
    return { kind: 'unknown', name: join(w) };
}

// ── camera.snapshot → message.send ──────────────────────────────────────────

export interface PictureCommand {
    /** `me` = the one who asks, else a name as said */
    recipient: string;
    /** The camera, as said ("Haustür", "Einfahrt") */
    camera: string;
    /** A word like "Kamera" was said: an unknown name gets an honest answer instead of going on */
    cameraWord: boolean;
    language: QuickLanguage;
}

const SEND_VERBS: Record<string, QuickLanguage> = {
    schick: 'de',
    schicke: 'de',
    sende: 'de',
    send: 'en',
    text: 'en',
    пришли: 'ru',
    отправь: 'ru',
    скинь: 'ru',
    пошли: 'ru',
    вышли: 'ru',
};
const PICTURE_WORDS =
    /^(bild|bilder|foto|fotos|schnappschuss|snapshot|aufnahme|picture|photo|image|pic|фото|фотку|фотографию|снимок|картинку|изображение|кадр)$/u;
const ME = new Set(['mir', 'uns', 'me', 'us', 'мне', 'нам']);

/**
 * "Schick mir ein Bild der Haustür", "Sende Anna ein Foto von der Einfahrt", "Send me a picture of the front door
 * camera", "Пришли мне фото с камеры у входа". Null without a send verb and a picture word.
 */
export function parsePictureCommand(text: string): PictureCommand | null {
    const w = trimPolite(words(text));
    const language = w.length ? SEND_VERBS[w[0].low] : undefined;
    if (!language) {
        return null;
    }
    const pic = w.findIndex((x, i) => i > 0 && PICTURE_WORDS.test(x.low));
    if (pic < 1) {
        return null;
    }
    const who = trimArticles(w.slice(1, pic)).filter(
        x => !['ein', 'eine', 'einen', 'a', 'an', 'the', 'das'].includes(x.low),
    );
    let recipient = 'me';
    if (who.length && !(who.length === 1 && ME.has(who[0].low))) {
        recipient = join(who.filter(x => !ME.has(x.low)));
    }
    // "… ein Bild der Haustür per Telegram": the messenger is not part of the camera
    let tail = w.slice(pic + 1);
    const via = tail.findIndex(x => ['per', 'über', 'ueber', 'via', 'по', 'через'].includes(x.low));
    if (via > 0) {
        tail = tail.slice(0, via);
    }
    while (tail.length && (LINK_WORDS.has(tail[0].low) || ARTICLES.has(tail[0].low))) {
        tail = tail.slice(1);
    }
    if (!tail.length) {
        return null;
    }
    const target = showTarget(join(tail));
    const camera = target.kind === 'camera' || target.kind === 'unknown' ? target.name : join(tail);
    return camera ? { recipient, camera, cameraWord: target.kind === 'camera', language } : null;
}

// ── Replies ─────────────────────────────────────────────────────────────────

export type QuickReplyKey =
    | 'calling'
    | 'callFailed'
    | 'unknownCallee'
    | 'whichCallee'
    | 'showing'
    | 'showFailed'
    | 'unknownScreen'
    | 'whichScreen'
    | 'cannotShow'
    | 'pictureSent'
    | 'pictureFailed'
    | 'unknownCamera'
    | 'whichCamera'
    | 'unknownRecipient'
    | 'noControl';

export interface QuickReplyValues {
    name?: string;
    what?: string;
    names?: string[];
    error?: string;
}

const list = (lang: QuickLanguage, names: string[] = []): string => {
    const and = lang === 'de' ? 'oder' : lang === 'ru' ? 'или' : 'or';
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} ${and} ${names[names.length - 1]}` : names[0] || '';
};

/** The answer of a quick command, in the language of the question. */
export function quickReply(language: string, key: QuickReplyKey, v: QuickReplyValues = {}): string {
    const lang: QuickLanguage = language === 'de' || language === 'ru' ? language : 'en';
    const n = v.name || '';
    const what = v.what || '';
    const names = list(lang, v.names);
    const known = names
        ? lang === 'de'
            ? ` Ich kenne: ${names}.`
            : lang === 'ru'
              ? ` Есть: ${names}.`
              : ` I know: ${names}.`
        : '';
    const err = v.error ? `: ${v.error}` : '.';
    const texts: Record<QuickLanguage, Record<QuickReplyKey, string>> = {
        de: {
            calling: `Ich rufe ${n} an.`,
            callFailed: `Der Anruf bei ${n} ging nicht${err}`,
            unknownCallee: `Ich kenne ${n} nicht.${known}`,
            whichCallee: `Wen meinst du: ${names}?`,
            showing: `Ich zeige ${what} auf ${n}.`,
            showFailed: `${n} hat ${what} nicht gezeigt${err}`,
            unknownScreen: `Den Bildschirm ${n} kenne ich nicht.${known}`,
            whichScreen: `Auf welchem Bildschirm: ${names}?`,
            cannotShow: `${n} kann das nicht zeigen.`,
            pictureSent: `Ich habe ${n || 'dir'} das Bild von ${what} geschickt.`,
            pictureFailed: `Das Bild von ${what} kam nicht${err}`,
            unknownCamera: `Die Kamera ${n} kenne ich nicht.${known}`,
            whichCamera: `Welche Kamera meinst du: ${names}?`,
            unknownRecipient: `An ${n} kann ich nichts schicken.${known}`,
            noControl: 'Das Steuern von Geräten ist in den Einstellungen nicht erlaubt.',
        },
        en: {
            calling: `Calling ${n}.`,
            callFailed: `The call to ${n} did not work${err}`,
            unknownCallee: `I don't know ${n}.${known}`,
            whichCallee: `Whom do you mean: ${names}?`,
            showing: `Showing ${what} on ${n}.`,
            showFailed: `${n} did not show ${what}${err}`,
            unknownScreen: `I don't know the screen ${n}.${known}`,
            whichScreen: `On which screen: ${names}?`,
            cannotShow: `${n} cannot show that.`,
            pictureSent: `I sent ${n || 'you'} the picture of ${what}.`,
            pictureFailed: `The picture of ${what} did not come${err}`,
            unknownCamera: `I don't know the camera ${n}.${known}`,
            whichCamera: `Which camera do you mean: ${names}?`,
            unknownRecipient: `I cannot send anything to ${n}.${known}`,
            noControl: 'Controlling devices is not allowed in the settings.',
        },
        ru: {
            calling: `Звоню: ${n}.`,
            callFailed: `Позвонить (${n}) не получилось${err}`,
            unknownCallee: `Не знаю, кто такой ${n}.${known}`,
            whichCallee: `Кого ты имеешь в виду: ${names}?`,
            showing: `Показываю ${what} на экране ${n}.`,
            showFailed: `Экран ${n} не показал ${what}${err}`,
            unknownScreen: `Экран ${n} мне неизвестен.${known}`,
            whichScreen: `На каком экране: ${names}?`,
            cannotShow: `${n} не умеет это показывать.`,
            pictureSent: `Отправила ${n ? `(${n})` : 'тебе'} снимок: ${what}.`,
            pictureFailed: `Снимок (${what}) не пришёл${err}`,
            unknownCamera: `Камера ${n} мне неизвестна.${known}`,
            whichCamera: `Какую камеру ты имеешь в виду: ${names}?`,
            unknownRecipient: `Не могу ничего отправить: ${n}.${known}`,
            noControl: 'Управление устройствами запрещено в настройках.',
        },
    };
    return texts[lang][key];
}
