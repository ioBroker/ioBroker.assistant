/**
 * YouTube on the TV: "spiele den Kanal Sailing OceanAir ab" → find the channel, switch the TV on, play it.
 *
 * Playing goes through the `youtube-remote` adapter (YouTube Lounge API, "Link with TV"): its `youtube` state
 * takes a video id, a playlist id (`PL…`), a channel id (`UC…`, plays the uploads) or a URL. What it cannot
 * do is turn a spoken name into one of those — handles and names need a search. That search lives here and
 * uses InnerTube, the JSON API the YouTube web page itself talks to: no API key and no quota, unlike the Data
 * API (100 units per search, 10 000 a day). The price is that Google does not document it; the parser
 * therefore walks the whole response for the renderer objects it knows instead of following one fixed path,
 * so a reshuffled page layout still yields results.
 *
 * Which player is meant comes from a settings table (name, player, power state, room). A request without a
 * name goes to the player in the room it came from, then to the first row — "the TV" in a one-TV household.
 * A row normally names a youtube-remote **instance**, not its device: the device id comes from the TV's
 * screen id and changes when the TV is paired again, so the device is looked up at runtime
 * ({@link pickDevice}).
 */

/** What to search for. `video` is also the kind of a plain "play X on YouTube". */
export type YouTubeKind = 'channel' | 'video' | 'playlist';

/** One configured YouTube player. */
export interface YouTubePlayer {
    /** As configured; '' until the device of an instance row was found (then the device name). */
    name: string;
    /** The youtube-remote instance the row names (`youtube-remote.0`), '' if the row names a device. */
    instance: string;
    /** Device object of the player, e.g. `youtube-remote.0.tv_8198d994`; '' until resolved. */
    base: string;
    /** The state that takes what to play (`<base>.youtube`); '' until resolved. */
    target: string;
    /** State that switches the TV on (`switch.power`), '' = none. */
    power: string;
    room: string;
    /** Seconds to give the TV after it reported "on" before the YouTube app can take a command. */
    delaySec: number;
}

/** One row of the settings table (everything arrives as text, the number column as number). */
export interface YouTubePlayerRow {
    name?: string;
    id?: string;
    power?: string;
    room?: string;
    delay?: number | string;
}

/** One search result. */
export interface YouTubeHit {
    kind: YouTubeKind;
    /** Video id, playlist id or channel id — exactly what the `youtube` state of the player takes. */
    id: string;
    title: string;
    /** Channel of a video or playlist. */
    channel?: string;
    /** `@handle` of a channel, if the result shows it. */
    handle?: string;
}

/** A play request the rule-based path understood. */
export interface YouTubeCommand {
    /** `auto` = nothing said what it is: a channel of that name if there is one, else videos. */
    kind: YouTubeKind | 'auto';
    query: string;
    /** Player name as configured, if the request named one. */
    player?: string;
}

/** Default boot time of a TV between "power reports on" and "YouTube app answers". */
export const DEFAULT_POWER_DELAY_SEC = 8;

/** Fold a word or name for comparing: lower case, umlauts spelled out, punctuation gone, single spaces. */
export function fold(text: unknown): string {
    if (typeof text !== 'string') {
        return '';
    }
    return text
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .replace(/ё/g, 'е')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

/** Same word up to an inflected ending ("Wohnzimmer"/"Wohnzimmers", "телевизор"/"телевизоре"). */
function sameWord(a: string, b: string): boolean {
    if (a === b) {
        return true;
    }
    const short = a.length < b.length ? a : b;
    const long = a.length < b.length ? b : a;
    return short.length >= 4 && long.startsWith(short) && long.length - short.length <= 2;
}

/** `youtube-remote.0` — an instance, as opposed to one of its devices. */
export function isInstanceId(id: string): boolean {
    return /^[\w-]+\.\d+$/.test(id);
}

/**
 * Turn settings-table rows into players; rows without a player are skipped, the first name wins. A row may
 * name the instance (the usual case) or, for an instance with several TVs, one device or its `youtube` state.
 */
export function parsePlayerRows(rows: YouTubePlayerRow[] | undefined): YouTubePlayer[] {
    const out: YouTubePlayer[] = [];
    const seen = new Set<string>();
    for (const row of rows || []) {
        const id = String(row?.id ?? '')
            .trim()
            .replace(/\.youtube$/, '');
        if (!id) {
            continue;
        }
        const instance = isInstanceId(id) ? id : '';
        const room = String(row?.room ?? '').trim();
        // An instance row without name and room is named after its device once that is found.
        const name = String(row?.name ?? '').trim() || room || (instance ? '' : id.split('.').pop() || id);
        const key = fold(name);
        if (key && seen.has(key)) {
            continue;
        }
        seen.add(key);
        const delay = Number(row?.delay);
        out.push({
            name,
            instance,
            base: instance ? '' : id,
            target: instance ? '' : `${id}.youtube`,
            power: String(row?.power ?? '').trim(),
            room,
            delaySec:
                row?.delay === undefined || row.delay === '' || !Number.isFinite(delay)
                    ? DEFAULT_POWER_DELAY_SEC
                    : Math.min(120, Math.max(0, delay)),
        });
    }
    return out;
}

/** A paired device of a youtube-remote instance. */
export interface YouTubeDevice {
    id: string;
    name: string;
}

/**
 * The device an instance row means: the one named like the row (name or room), else the first — with one
 * TV per instance, which is the normal case, simply that one. `null` while nothing is paired.
 */
export function pickDevice(
    devices: YouTubeDevice[],
    player: Pick<YouTubePlayer, 'name' | 'room'>,
): YouTubeDevice | null {
    if (!devices.length) {
        return null;
    }
    const sorted = [...devices].sort((a, b) => a.id.localeCompare(b.id));
    return (
        // Every word of the row must be in the device name: a row "Schlafzimmer TV" is not the device "TV".
        sorted.find(d => !!player.name && nameMatches(player.name, d.name)) ||
        sorted.find(d => !!player.room && nameMatches(player.room, d.name)) ||
        sorted[0]
    );
}

/** Does a configured name (all its words) match what was said? */
function nameMatches(name: string, wanted: string): boolean {
    const a = fold(name);
    const b = fold(wanted);
    if (!a || !b) {
        return false;
    }
    if (a === b) {
        return true;
    }
    const nameWords = a.split(' ');
    const saidWords = b.split(' ');
    return nameWords.every(n => saidWords.some(s => sameWord(n, s)));
}

/**
 * Which player is meant: the named one (name, then room), else the one in the room the request came from,
 * else the first row. A name that matches nothing is `null` — playing on the wrong TV is worse than asking.
 */
export function findPlayer(players: YouTubePlayer[], wanted?: string, room?: string): YouTubePlayer | null {
    if (!players.length) {
        return null;
    }
    const name = (wanted || '').trim();
    if (name) {
        return (
            players.find(p => fold(p.name) === fold(name)) ||
            players.find(p => p.room && fold(p.room) === fold(name)) ||
            players.find(p => nameMatches(p.name, name) || (!!p.room && nameMatches(p.room, name))) ||
            null
        );
    }
    if (room) {
        const here = players.find(p => (p.room && fold(p.room) === fold(room)) || fold(p.name) === fold(room));
        if (here) {
            return here;
        }
    }
    return players[0];
}

/** Does a value of a power state mean "on"? */
export function isPowerOn(value: unknown): boolean {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return value > 0;
    }
    return typeof value === 'string' && /^(on|true|1|an|ein|power_?on|вкл)$/i.test(value.trim());
}

/**
 * The query as something the player takes without a search: a youtube.com/youtu.be URL, a channel id, a
 * playlist id, or — when a video is asked for — an 11-character video id. `null` = needs a search.
 */
export function directYouTubeTarget(query: string, kind: YouTubeKind): string | null {
    const q = query.trim();
    if (/^(https?:\/\/)?((www|m|music)\.)?(youtube\.com|youtu\.be)\//i.test(q)) {
        return q;
    }
    if (/^UC[\w-]{22}$/.test(q) || /^(PL|UU|OL|FL)[\w-]{10,}$/.test(q)) {
        return q;
    }
    // A plain word of 11 letters ("Tagesschaus") is no id: a real one nearly always mixes in digits,
    // capitals or -/_.
    if (kind === 'video' && /^[\w-]{11}$/.test(q) && /[\d_A-Z-]/.test(q.slice(1))) {
        return q;
    }
    return null;
}

/** InnerTube search filter (`sp` parameter of the results page): only channels / videos / playlists. */
const SEARCH_FILTER: Record<YouTubeKind, string> = {
    video: 'EgIQAQ==',
    channel: 'EgIQAg==',
    playlist: 'EgIQAw==',
};

/** Text of an InnerTube text object (`{simpleText}` or `{runs:[{text}]}`). */
function textOf(node: unknown): string {
    if (!node || typeof node !== 'object') {
        return '';
    }
    const n = node as { simpleText?: unknown; runs?: { text?: unknown }[]; content?: unknown };
    if (typeof n.simpleText === 'string') {
        return n.simpleText;
    }
    if (typeof n.content === 'string') {
        return n.content;
    }
    if (Array.isArray(n.runs)) {
        return n.runs.map(r => (typeof r?.text === 'string' ? r.text : '')).join('');
    }
    return '';
}

/**
 * Pull the results of one kind out of an InnerTube search response. Walks the whole tree: the renderer
 * objects stay stable for years, the containers around them do not (playlists already moved from
 * `playlistRenderer` to `lockupViewModel`).
 */
export function parseSearchResults(response: unknown, kind: YouTubeKind): YouTubeHit[] {
    const hits: YouTubeHit[] = [];
    const seen = new Set<string>();
    const add = (hit: YouTubeHit): void => {
        if (hit.id && !seen.has(hit.id)) {
            seen.add(hit.id);
            hits.push(hit);
        }
    };
    const walk = (node: unknown, depth: number): void => {
        if (!node || typeof node !== 'object' || depth > 40) {
            return;
        }
        if (Array.isArray(node)) {
            for (const item of node) {
                walk(item, depth + 1);
            }
            return;
        }
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
            const v = value as Record<string, any>;
            if (key === 'channelRenderer' && kind === 'channel' && typeof v?.channelId === 'string') {
                // YouTube shows the handle in the field that used to hold the subscriber count.
                const handle = [textOf(v.subscriberCountText), textOf(v.videoCountText)].find(t => t.startsWith('@'));
                add({ kind, id: v.channelId, title: textOf(v.title), handle });
            } else if (key === 'videoRenderer' && kind === 'video' && typeof v?.videoId === 'string') {
                add({ kind, id: v.videoId, title: textOf(v.title), channel: textOf(v.ownerText) || undefined });
            } else if (key === 'playlistRenderer' && kind === 'playlist' && typeof v?.playlistId === 'string') {
                add({
                    kind,
                    id: v.playlistId,
                    title: textOf(v.title),
                    channel: textOf(v.shortBylineText) || undefined,
                });
            } else if (key === 'lockupViewModel' && typeof v?.contentId === 'string') {
                const type = String(v.contentType || '');
                const meta = v.metadata?.lockupMetadataViewModel;
                if (
                    (kind === 'playlist' && type === 'LOCKUP_CONTENT_TYPE_PLAYLIST') ||
                    (kind === 'video' && type === 'LOCKUP_CONTENT_TYPE_VIDEO')
                ) {
                    add({ kind, id: v.contentId, title: textOf(meta?.title) });
                }
            }
            walk(value, depth + 1);
        }
    };
    walk(response, 0);
    return hits;
}

/** Edit distance of two short strings (names, not texts — the matrix is small). */
function editDistance(a: string, b: string): number {
    let prev = Array.from({ length: b.length + 1 }, (_, k) => k);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let k = 1; k <= b.length; k++) {
            cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}

/**
 * Is a spoken name the same name? Spaces do not count and a typo or two per eight letters is allowed,
 * because the name went through speech recognition: "Sailing Ocean Air" is the channel "Sailing Oceanaire".
 */
export function similarName(said: string, name: string): boolean {
    const a = fold(said).replace(/ /g, '');
    const b = fold(name).replace(/ /g, '');
    if (!a || !b) {
        return false;
    }
    return a === b || editDistance(a, b) <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 8));
}

/** Is this channel the one that was named — by its title (without the " | tagline") or its handle? */
export function isNamedChannel(hit: YouTubeHit, query: string): boolean {
    return similarName(query, spokenTitle(hit)) || (!!hit.handle && similarName(query, hit.handle.replace(/^@/, '')));
}

/**
 * The hit that was most likely meant: a channel whose name is the query (see {@link isNamedChannel}), a
 * video or playlist titled like it, otherwise YouTube's own first result. The name match matters when a
 * bigger channel outranks the one that was named.
 */
export function pickBest(hits: YouTubeHit[], query: string): YouTubeHit | null {
    if (!hits.length) {
        return null;
    }
    const q = fold(query);
    return hits.find(h => (h.kind === 'channel' ? isNamedChannel(h, query) : fold(h.title) === q)) || hits[0];
}

/** The title as it should be spoken: without the " | tagline" channels like to append. */
export function spokenTitle(hit: YouTubeHit): string {
    return hit.title.split(' | ')[0].trim() || hit.title;
}

export interface SearchOptions {
    /** Interface language of the results (ISO, e.g. `de`). */
    language?: string;
    timeoutMs?: number;
    fetchFn?: typeof fetch;
}

/** Search YouTube for channels, videos or playlists; throws on a network or HTTP error. */
export async function searchYouTube(query: string, kind: YouTubeKind, opts: SearchOptions = {}): Promise<YouTubeHit[]> {
    const fetchFn = opts.fetchFn || fetch;
    const res = await fetchFn('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: opts.language || 'en' } },
            query,
            params: SEARCH_FILTER[kind],
        }),
        signal: AbortSignal.timeout(opts.timeoutMs || 10_000),
    });
    if (res.status !== 200) {
        throw new Error(`YouTube search answered HTTP ${res.status}`);
    }
    return parseSearchResults(await res.json(), kind);
}

// ── Rule-based "play … on YouTube" ──────────────────────────────────────────

const VERBS = new Set([
    'spiel',
    'spiele',
    'spielt',
    'abspielen',
    'zeig',
    'zeige',
    'starte',
    'start',
    'play',
    'show',
    'put',
    'включи',
    'поставь',
    'запусти',
    'покажи',
    'воспроизведи',
]);
const POLITE = new Set(['bitte', 'mal', 'please', 'пожалуйста']);
const FILLERS = new Set([
    'mir',
    'uns',
    'me',
    'us',
    'мне',
    'нам',
    'den',
    'das',
    'die',
    'einen',
    'ein',
    'eine',
    'the',
    'a',
    'an',
    'some',
    'mal',
    'bitte',
]);
const KIND_WORDS: Record<string, YouTubeKind> = {
    kanal: 'channel',
    channel: 'channel',
    канал: 'channel',
    video: 'video',
    clip: 'video',
    видео: 'video',
    ролик: 'video',
    playlist: 'playlist',
    wiedergabeliste: 'playlist',
    плейлист: 'playlist',
};
const OF_WORDS = new Set(['von', 'vom', 'of', 'from', 'by', 'от']);
const YOUTUBE_WORDS = new Set(['youtube', 'ютуб', 'ютубе', 'ютюб', 'ютюбе']);
const PREPOSITIONS = new Set(['auf', 'im', 'in', 'am', 'an', 'bei', 'dem', 'der', 'on', 'at', 'the', 'на', 'в', 'во']);
/** Prepositions that only ever say "where" — what follows them right after the verb is a place, not a title. */
const LOCATIVE = new Set(['im', 'в', 'во']);
const ARTICLES = new Set(['der', 'dem', 'den', 'the']);
const TRAILING = new Set(['ab', 'please', 'bitte', 'пожалуйста', 'jetzt', 'now']);
/** A "query" that is really a request to repeat — not something to search for. */
const NOT_A_QUERY = new Set(['nochmal', 'noch mal', 'weiter', 'again', 'more', 'ещё', 'еще', 'ещё раз', 'еще раз']);

/**
 * Understand "spiele den Kanal Sailing OceanAir (auf dem Fernseher) ab", "play the channel X on the bedroom
 * TV", "включи канал X", "spiele im Wohnzimmer Sailing Ocean Air auf YouTube". Needs a kind word
 * (Kanal/channel/канал, Video, Playlist) or the word YouTube — "spiele Musik im Wohnzimmer" stays with the
 * rest of the pipeline. Without a kind word the kind is `auto`. A player name or room right after the verb
 * or at the end is cut off the query, as is a place right after the verb ("im Bad") — that one is then
 * looked up as a player and answered as unknown, which beats searching YouTube for "im Bad X". Everything
 * else stays in the query with its spelling, because it is what gets searched for.
 */
export function parseYouTubeCommand(text: string, players: YouTubePlayer[]): YouTubeCommand | null {
    const words = text
        .trim()
        .split(/\s+/)
        .map(w => w.replace(/^[„"“”'«»]+|[„"“”'«».,!?;:]+$/g, ''))
        .filter(Boolean);
    const low = words.map(w => fold(w));
    let i = 0;
    while (i < low.length && POLITE.has(low[i])) {
        i++;
    }
    if (i >= low.length || !VERBS.has(low[i])) {
        return null;
    }
    i++;
    const sawYouTube = low.some(w => YOUTUBE_WORDS.has(w));
    // Player names and rooms, longest first so "Schlafzimmer TV" wins over "TV".
    const candidates = players
        .flatMap(p => [
            { player: p.name, words: fold(p.name).split(' ') },
            ...(p.room ? [{ player: p.name || p.room, words: fold(p.room).split(' ') }] : []),
        ])
        .filter(c => c.words[0])
        .sort((a, b) => b.words.length - a.words.length);
    const nameAt = (at: number): { player: string; end: number } | null => {
        for (const c of candidates) {
            if (c.words.every((w, k) => at + k < low.length && sameWord(w, low[at + k]))) {
                return { player: c.player, end: at + c.words.length };
            }
        }
        return null;
    };
    /** "im Wohnzimmer", "auf dem Fernseher", "в спальне" starting at `at`; `null` if it is no place. */
    const placeAt = (at: number): { player: string; end: number } | null => {
        let j = at;
        while (j < low.length && PREPOSITIONS.has(low[j])) {
            j++;
        }
        if (j === at || j >= low.length) {
            return null;
        }
        const named = nameAt(j);
        if (named) {
            return named;
        }
        const locative = LOCATIVE.has(low[at]) || (low[at] === 'in' && ARTICLES.has(low[at + 1]));
        return locative ? { player: words[j], end: j + 1 } : null;
    };
    let kind: YouTubeKind | 'auto' | null = null;
    let player: string | undefined;
    // Fillers, "auf YouTube", the kind word and the place may come in any order before the name.
    for (;;) {
        if (i < low.length && FILLERS.has(low[i])) {
            i++;
        } else if (i + 1 < low.length && PREPOSITIONS.has(low[i]) && YOUTUBE_WORDS.has(low[i + 1])) {
            i += 2;
        } else if (i < low.length && YOUTUBE_WORDS.has(low[i])) {
            i++;
        } else if (!kind && i < low.length && KIND_WORDS[low[i]]) {
            kind = KIND_WORDS[low[i]];
            i++;
            if (i < low.length && OF_WORDS.has(low[i])) {
                i++;
            }
        } else if (!player && i < low.length) {
            const place = placeAt(i);
            // Only if something is left to search for.
            if (!place || place.end >= low.length) {
                break;
            }
            player = place.player;
            i = place.end;
        } else {
            break;
        }
    }
    if (!kind) {
        if (!sawYouTube) {
            return null;
        }
        kind = 'auto';
    }
    let end = words.length;
    const trimTail = (): void => {
        for (;;) {
            if (end > i && TRAILING.has(low[end - 1])) {
                end--;
            } else if (end > i && YOUTUBE_WORDS.has(low[end - 1])) {
                end--;
                while (end > i && PREPOSITIONS.has(low[end - 1])) {
                    end--;
                }
            } else {
                return;
            }
        }
    };
    trimTail();
    // A trailing player: its name or room, preceded by a preposition so a channel called like a room is
    // not eaten ("Kanal Küche" without "in der" stays a channel).
    for (const c of player ? [] : candidates) {
        const n = c.words.length;
        if (end - n <= i) {
            continue;
        }
        const tail = low.slice(end - n, end);
        if (!c.words.every((w, k) => sameWord(w, tail[k]))) {
            continue;
        }
        let start = end - n;
        if (!PREPOSITIONS.has(low[start - 1])) {
            continue;
        }
        while (start > i && PREPOSITIONS.has(low[start - 1])) {
            start--;
        }
        if (start <= i) {
            continue; // nothing would be left to search for
        }
        player = c.player;
        end = start;
        trimTail();
        break;
    }
    const query = words.slice(i, end).join(' ').trim();
    if (!query || NOT_A_QUERY.has(fold(query))) {
        return null;
    }
    return { kind, query, ...(player ? { player } : {}) };
}

// ── Spoken replies (de/en/ru) ───────────────────────────────────────────────

export type YouTubeReplyKey =
    | 'playing'
    | 'poweringOn'
    | 'notFound'
    | 'searchFailed'
    | 'noConfirm'
    | 'adapterDown'
    | 'unknownPlayer'
    | 'noControl'
    | 'noDevice';

/** "the channel „X“" in the reply language. */
function describeWhat(lang: string, kind: YouTubeKind, title: string): string {
    if (lang === 'de') {
        return `${kind === 'channel' ? 'den Kanal' : kind === 'playlist' ? 'die Playlist' : 'das Video'} „${title}“`;
    }
    if (lang === 'ru') {
        return `${kind === 'channel' ? 'канал' : kind === 'playlist' ? 'плейлист' : 'видео'} «${title}»`;
    }
    return `the ${kind} "${title}"`;
}

/** What nothing was found of: "keinen Kanal", "no channel", "канал". */
function describeNone(lang: string, kind: YouTubeKind): string {
    if (lang === 'de') {
        return kind === 'channel' ? 'keinen Kanal' : kind === 'playlist' ? 'keine Playlist' : 'kein Video';
    }
    if (lang === 'ru') {
        return kind === 'channel' ? 'канал' : kind === 'playlist' ? 'плейлист' : 'видео';
    }
    return `no ${kind}`;
}

/** A spoken reply of the YouTube feature. */
export function youtubeReply(
    lang: string,
    key: YouTubeReplyKey,
    v: { kind?: YouTubeKind; title?: string; query?: string; player?: string; names?: string; instance?: string } = {},
): string {
    const kind = v.kind || 'video';
    const what = describeWhat(lang, kind, v.title || v.query || '');
    const player = v.player || '';
    if (lang === 'de') {
        switch (key) {
            case 'playing':
                return `Ich spiele ${what} auf ${player}.`;
            case 'poweringOn':
                return `Ich schalte ${player} ein und spiele dann ${what}.`;
            case 'notFound':
                return `Ich habe auf YouTube ${describeNone(lang, kind)} „${v.query}“ gefunden.`;
            case 'searchFailed':
                return 'Die YouTube-Suche ist gerade nicht erreichbar.';
            case 'noConfirm':
                return `${player} hat nicht reagiert. Ist der Fernseher an und die YouTube-App verbunden?`;
            case 'adapterDown':
                return `Der YouTube-Adapter ${v.instance} läuft nicht.`;
            case 'unknownPlayer':
                return `Einen Player „${v.query}“ kenne ich nicht. Ich kenne: ${v.names}.`;
            case 'noControl':
                return 'Die Gerätesteuerung ist in den Einstellungen ausgeschaltet.';
            case 'noDevice':
                return `Mit ${v.instance} ist noch kein Fernseher gekoppelt.`;
        }
    }
    if (lang === 'ru') {
        switch (key) {
            case 'playing':
                return `Включаю ${what} — ${player}.`;
            case 'poweringOn':
                return `Включаю ${player}, потом запущу ${what}.`;
            case 'notFound':
                return `На YouTube не нашла ${describeNone(lang, kind)} «${v.query}».`;
            case 'searchFailed':
                return 'Поиск YouTube сейчас недоступен.';
            case 'noConfirm':
                return `${player} не ответил. Телевизор включён и приложение YouTube подключено?`;
            case 'adapterDown':
                return `Адаптер YouTube ${v.instance} не запущен.`;
            case 'unknownPlayer':
                return `Плеер «${v.query}» мне не известен. Я знаю: ${v.names}.`;
            case 'noControl':
                return 'Управление устройствами отключено в настройках.';
            case 'noDevice':
                return `С ${v.instance} ещё не связан ни один телевизор.`;
        }
    }
    switch (key) {
        case 'playing':
            return `Playing ${what} on ${player}.`;
        case 'poweringOn':
            return `Switching ${player} on, then playing ${what}.`;
        case 'notFound':
            return `I found ${describeNone(lang, kind)} "${v.query}" on YouTube.`;
        case 'searchFailed':
            return 'The YouTube search cannot be reached right now.';
        case 'noConfirm':
            return `${player} did not respond. Is the TV on and the YouTube app linked?`;
        case 'adapterDown':
            return `The YouTube adapter ${v.instance} is not running.`;
        case 'unknownPlayer':
            return `I don't know a player "${v.query}". I know: ${v.names}.`;
        case 'noControl':
            return 'Device control is switched off in the settings.';
        case 'noDevice':
            return `No TV is paired with ${v.instance} yet.`;
    }
    return '';
}
