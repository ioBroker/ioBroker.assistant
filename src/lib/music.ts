/**
 * Music from Spotify: "spiel Bohemian Rhapsody von Queen" → find the song, play it on a Spotify Connect device.
 *
 * Spotify gives no audio URLs: the music plays on a Spotify Connect device (phone, computer, Echo, Sonos, TV,
 * spotifyd, …), which only takes commands. Search and command go through the adapter spotify-premium (its messages
 * `search`, `play`, `getPlaylists`, `getDevices`): it holds the login at Spotify. A second Spotify app here would need
 * a second login and count against the limit of five users of an app in Spotify's development mode.
 *
 * Which player is meant comes from a settings table (name, spotify-premium instance, Spotify Connect device, room),
 * chosen like the YouTube players: the named one, else the one in the room of the request, else the first row.
 */
import { findPlayer, fold, sameWord, similarName } from './youtube';

export { findPlayer as findMusicPlayer };

/** What to search for. */
export type MusicKind = 'track' | 'album' | 'artist' | 'playlist';

/** One configured music player. */
export interface MusicPlayer {
    /** As configured, else the room, the device or the instance */
    name: string;
    /** The spotify-premium instance, e.g. `spotify-premium.0` */
    instance: string;
    /** Name or id of the Spotify Connect device; '' = the device that is active at Spotify */
    device: string;
    room: string;
    /**
     * A player of another adapter found by `help` (`media.getPlayers`): searched and played with the commands of the
     * shared catalog (`media.search`, `media.getMedia`, `media.play`) instead of the ones of spotify-premium
     */
    standard?: boolean;
    /** Id of the satellite (under `satellites.*`) that is this player or plays through it; '' = none */
    satellite?: string;
}

/** One row of the settings table. */
export interface MusicPlayerRow {
    name?: string;
    instance?: string;
    device?: string;
    room?: string;
    satellite?: string;
}

/** What to play. */
export interface MusicRequest {
    /** `auto` = nothing said what it is: an artist, playlist, album or track of that name, else the best track */
    kind: MusicKind | 'auto';
    /** Title, album, artist or playlist name; '' with `artist` = anything of that artist ("ein Lied von Queen") */
    query: string;
    /** The artist of a track or an album */
    artist?: string;
    /**
     * Only play what is named like the query (an artist, playlist, album or track): a request that was only guessed
     * ("spiel die Piano Guys" without a kind word) must not play just anything
     */
    strict?: boolean;
}

/** Where music plays: Spotify (spotify-premium) or YouTube on a TV (youtube-remote). */
export type MusicService = 'spotify' | 'youtube';

/** A player of either service, as the parser needs it. */
export interface NamedPlayer {
    name: string;
    room: string;
}

/** A play request the rule-based path understood. */
export interface MusicCommand extends MusicRequest {
    /** Player name or room as said, if the request named one */
    player?: string;
    /** Said ("auf Spotify", "auf YouTube") or the service of the named player; unset = the caller decides */
    service?: MusicService;
    /**
     * No kind word, only "spiel <something>": maybe an artist or a song, maybe not music at all ("spiel mit dem Hund").
     * The caller tries it after the other local steps and plays only a hit named like it.
     */
    guess?: boolean;
}

/** Something found on Spotify. */
export interface MusicHit {
    kind: MusicKind;
    uri: string;
    name: string;
    artists?: string[];
    album?: string;
    /** Owner of a playlist */
    owner?: string;
}

/** An item of the answer of the message `search` of spotify-premium. */
export interface SpotifySearchItem {
    type: string;
    uri: string;
    name: string;
    artists?: string[];
    album?: string;
    owner?: string;
}

/** An item of the answer of the message `getPlaylists` of spotify-premium. */
export interface SpotifyPlaylistItem {
    uri: string;
    name: string;
    ownerId?: string;
}

/** A failure with the reason spotify-premium (or the way to it) gave. */
export class MusicError extends Error {
    constructor(
        message: string,
        public readonly reason = '',
    ) {
        super(message);
    }
}

/** spotify-premium is not running */
export const ADAPTER_DOWN = 'ADAPTER_DOWN';
/** spotify-premium does not take messages yet (older than the messages `search` and `play`) */
export const OUTDATED = 'OUTDATED';
/** The first version of spotify-premium with the messages `search`, `play`, `getDevices` and `getPlaylists` */
export const SPOTIFY_MIN_VERSION = '3.3.0';

/**
 * Whether an installed spotify-premium is older than {@link SPOTIFY_MIN_VERSION}: it would not answer `search` (3.2.0
 * answers only `help`, older ones nothing) and the request would wait for the timeout.
 *
 * @param version `common.version` of the instance, e.g. "3.3.0" or "3.3.0-alpha.1"
 */
export function spotifyTooOld(version: unknown): boolean {
    const have = (typeof version === 'string' ? version : '').match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!have) {
        return true;
    }
    const need = SPOTIFY_MIN_VERSION.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const diff = Number(have[i + 1]) - need[i];
        if (diff) {
            return diff < 0;
        }
    }
    // a pre-release of the first version (3.3.0-alpha) counts: it is how a new version is tried
    return false;
}

/**
 * Turn settings-table rows into players; rows without an instance are skipped, the first name wins.
 *
 * @param rows the table `musicPlayers`
 */
export function parseMusicPlayerRows(rows: MusicPlayerRow[] | undefined): MusicPlayer[] {
    const out: MusicPlayer[] = [];
    const seen = new Set<string>();
    for (const row of rows || []) {
        const instance = String(row?.instance ?? '')
            .trim()
            .replace(/^system\.adapter\./, '');
        if (!/^[\w-]+\.\d+$/.test(instance)) {
            continue;
        }
        const device = String(row?.device ?? '').trim();
        const room = String(row?.room ?? '').trim();
        const satellite = String(row?.satellite ?? '').trim();
        const name = String(row?.name ?? '').trim() || room || device || instance;
        const key = fold(name);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push({ name, instance, device, room, ...(satellite ? { satellite } : {}) });
    }
    return out;
}

// ── Rule-based "play …" ─────────────────────────────────────────────────────

const VERBS = new Set([
    'spiel',
    'spiele',
    'spielt',
    'abspielen',
    'starte',
    'play',
    'put',
    'включи',
    'поставь',
    'запусти',
    'воспроизведи',
    'сыграй',
]);
const POLITE = new Set(['bitte', 'mal', 'please', 'пожалуйста', 'hey']);
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
    'dem',
    'einen',
    'ein',
    'eine',
    'mein',
    'meine',
    'meinen',
    'the',
    'a',
    'an',
    'my',
    'on',
    'мой',
    'мою',
    'моё',
    'мое',
    'mal',
    'bitte',
    'etwas',
    'some',
    'немного',
    'музыкальный',
]);
const KIND_WORDS: Record<string, MusicKind> = {
    lied: 'track',
    song: 'track',
    titel: 'track',
    stueck: 'track',
    track: 'track',
    песню: 'track',
    песня: 'track',
    трек: 'track',
    композицию: 'track',
    album: 'album',
    альбом: 'album',
    kuenstler: 'artist',
    kuenstlerin: 'artist',
    interpret: 'artist',
    interpreten: 'artist',
    interpretin: 'artist',
    band: 'artist',
    gruppe: 'artist',
    artist: 'artist',
    исполнителя: 'artist',
    исполнительницу: 'artist',
    группу: 'artist',
    певца: 'artist',
    певицу: 'artist',
    playlist: 'playlist',
    wiedergabeliste: 'playlist',
    плейлист: 'playlist',
};
/** "Musik von Queen", "музыку Queen", "Songs von Queen": the artist, with or without an "of" */
const MUSIC_WORDS = new Set(['musik', 'music', 'музыку', 'songs', 'lieder', 'tracks', 'песни', 'треки']);
/** "etwas von Queen", "что-нибудь из Queen": the artist, only with an "of" */
const SOMETHING_WORDS = new Set(['etwas', 'was', 'something', 'anything', 'что нибудь', 'что то', 'чего нибудь']);
/** "of" after a kind word: what follows is the artist ("ein Lied von Queen", "песню группы Кино") */
const OF_WORDS = new Set(['von', 'vom', 'of', 'by', 'from', 'от', 'группы', 'исполнителя', 'певца', 'певицы']);
const SOMETHING_OF = new Set([...OF_WORDS, 'из']);
/** Between title and artist: "Bohemian Rhapsody von Queen". Not "of"/"from", which are in titles ("Queen of …"). */
const SPLIT_WORDS = new Set(['von', 'vom', 'by', 'от', 'группы', 'исполнителя', 'певца', 'певицы']);
const ARTIST_ARTICLES = new Set(['der', 'die', 'den', 'dem', 'the']);
const SPOTIFY_WORDS = new Set(['spotify', 'спотифай', 'спотифае', 'спотифая']);
/** A music video: plays on a TV, searched on YouTube ("spiel den Clip Bohemian Rhapsody von Queen"). */
const CLIP_WORDS = new Set(['clip', 'videoclip', 'musikvideo', 'musikclip', 'клип', 'видеоклип']);
/** "music video", "Musik Video": two words, the second of which alone is the YouTube parser's */
const CLIP_FIRST = new Set(['music', 'musik']);
const YOUTUBE_WORDS = new Set(['youtube', 'ютуб', 'ютубе', 'ютюб', 'ютюбе', 'ютубу']);
/** Words of other things that play: channels and videos belong to the YouTube parser, the rest is not supported. */
const FOREIGN_WORDS = new Set([
    'kanal',
    'channel',
    'канал',
    'video',
    'videos',
    'видео',
    'ролик',
    'radio',
    'radiosender',
    'sender',
    'station',
    'радио',
    'podcast',
    'podcasts',
    'подкаст',
    'hoerbuch',
    'audiobook',
    'аудиокнигу',
]);
/**
 * Verbs that only mean playing: "<title> von <artist>" without a kind word needs one of them — "включи обогреватель
 * от солнечной батареи" is a device, not a song.
 */
const PLAY_VERBS = new Set(['spiel', 'spiele', 'spielt', 'abspielen', 'play', 'сыграй', 'воспроизведи']);
const PREPOSITIONS = new Set(['auf', 'im', 'in', 'am', 'an', 'bei', 'dem', 'der', 'on', 'at', 'the', 'на', 'в', 'во']);
/** Prepositions that only ever say "where" — what follows them right after the verb is a place, not a title. */
const LOCATIVE = new Set(['im', 'в', 'во']);
const ARTICLES = new Set(['der', 'dem', 'den', 'the']);
const TRAILING = new Set(['ab', 'please', 'bitte', 'пожалуйста', 'jetzt', 'now', 'vor']);
/** A "query" that is really a request to go on — not something to search for. */
const NOT_A_QUERY = new Set(['nochmal', 'noch mal', 'weiter', 'again', 'more', 'ещё', 'еще', 'ещё раз', 'еще раз']);

/**
 * Understand "spiel Bohemian Rhapsody von Queen", "spiele das Album A Night at the Opera", "spiel Musik von Queen
 * in der Küche", "spiel meine Playlist Party", "play Yesterday by the Beatles", "включи песню Группа крови группы
 * Кино", "spiel Queen auf Spotify", "spiel den Clip Bohemian Rhapsody von Queen auf dem Fernseher", "включи клип …".
 *
 * Needs a kind word (Lied/Song/Titel, Album, Künstler/Band, Playlist, Musik, Clip/Musikvideo/клип — a clip always goes
 * to YouTube, only the TVs count as its players), "<title> von <artist>" after a verb that
 * only means playing (spiel/play, not "включи"), or the word Spotify — "spiel Queen" alone stays with the rest of the
 * pipeline (the cloud model has the tools). A sentence with a word of the YouTube parser (Kanal, Video) or of something
 * not supported here (Radio, Podcast) is not taken. A player name or room right after the verb or at the end (with a
 * preposition) is cut off the query.
 *
 * The service: said ("auf Spotify", "auf YouTube" — then only players of that service count), else the one of the
 * named player (a TV = YouTube), else unset.
 *
 * @param text what was said
 * @param players the Spotify players
 * @param tvs the YouTube players: songs on a TV are searched on YouTube
 */
export function parseMusicCommand(text: string, players: NamedPlayer[], tvs: NamedPlayer[] = []): MusicCommand | null {
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
    const playVerb = PLAY_VERBS.has(low[i]);
    i++;
    /** "music video" starting at `at` */
    const musicVideoAt = (at: number): boolean => CLIP_FIRST.has(low[at]) && low[at + 1] === 'video';
    if (low.some((w, k) => FOREIGN_WORDS.has(w) && !(w === 'video' && musicVideoAt(k - 1)))) {
        return null;
    }
    const sawSpotify = low.some(w => SPOTIFY_WORDS.has(w));
    const sawYouTube = low.some(w => YOUTUBE_WORDS.has(w));
    const sawClip = low.some((w, k) => CLIP_WORDS.has(w) || musicVideoAt(k));
    if (sawSpotify && (sawYouTube || sawClip)) {
        return null;
    }
    // A clip is a video: only the TVs count
    const said: MusicService | undefined = sawSpotify ? 'spotify' : sawYouTube || sawClip ? 'youtube' : undefined;
    const serviceWord = (w: string | undefined): boolean => !!w && (SPOTIFY_WORDS.has(w) || YOUTUBE_WORDS.has(w));
    // Player names and rooms, longest first so "Küche Echo" wins over "Küche"; on a tie the Spotify player.
    const tagged: { p: NamedPlayer; service: MusicService }[] = [
        ...players.map(p => ({ p, service: 'spotify' as const })),
        ...tvs.map(p => ({ p, service: 'youtube' as const })),
    ];
    const candidates = tagged
        .filter(c => !said || c.service === said)
        .flatMap(({ p, service }) => [
            { player: p.name, service, words: fold(p.name).split(' ') },
            ...(p.room ? [{ player: p.name, service, words: fold(p.room).split(' ') }] : []),
        ])
        .filter(c => c.words[0])
        .sort(
            (a, b) =>
                b.words.length - a.words.length || Number(a.service === 'youtube') - Number(b.service === 'youtube'),
        );
    type Place = { player: string; service?: MusicService; end: number };
    const nameAt = (at: number): Place | null => {
        for (const c of candidates) {
            if (c.words.every((w, k) => at + k < low.length && sameWord(w, low[at + k]))) {
                return { player: c.player, service: c.service, end: at + c.words.length };
            }
        }
        return null;
    };
    /**
     * "im Wohnzimmer", "auf dem Echo", "в спальне" starting at `at`; `null` if it is no place. `unknown`: also a
     * place that is no player ("im Bad"), which then gets an honest "I don't know that player".
     */
    const placeAt = (at: number, unknown: boolean): Place | null => {
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
        return unknown && locative ? { player: words[j], end: j + 1 } : null;
    };

    let kind: MusicKind | 'auto' | null = null;
    let byArtist = false;
    /** The artist came after "von"/"от": "was von den Beatles" asks for "Beatles" */
    let ofArtist = false;
    let place: Place | null = null;
    // Fillers, "auf Spotify", the kind word and the place may come in any order before the name. After the kind
    // word an article belongs to the title ("das Lied The Final Countdown").
    for (;;) {
        if (!kind && i + 1 < low.length && SOMETHING_WORDS.has(low[i]) && SOMETHING_OF.has(low[i + 1])) {
            kind = 'artist';
            ofArtist = true;
            i += 2;
        } else if (!kind && i < low.length && FILLERS.has(low[i])) {
            i++;
        } else if (i + 1 < low.length && PREPOSITIONS.has(low[i]) && serviceWord(low[i + 1])) {
            i += 2;
        } else if (serviceWord(low[i])) {
            i++;
        } else if (!kind && i < low.length && KIND_WORDS[low[i]]) {
            kind = KIND_WORDS[low[i]];
            i++;
            if (i < low.length && OF_WORDS.has(low[i])) {
                // "ein Lied von Queen": something of that artist; "die Band von …" is still the band
                byArtist = kind !== 'artist' && kind !== 'playlist';
                i++;
            }
        } else if (!kind && i < low.length && (CLIP_WORDS.has(low[i]) || musicVideoAt(i))) {
            // "den Clip X von Y": a song as a video; "einen Clip von Queen": any of that artist
            kind = 'track';
            i += musicVideoAt(i) ? 2 : 1;
            if (i < low.length && OF_WORDS.has(low[i])) {
                byArtist = true;
                i++;
            }
        } else if (!kind && i < low.length && MUSIC_WORDS.has(low[i])) {
            kind = 'artist';
            i++;
            if (i < low.length && SOMETHING_OF.has(low[i])) {
                i++;
                ofArtist = true;
            }
        } else if (!place && i < low.length) {
            // An unknown place only before the kind word: "das Lied Im Wagen vor mir" is a title.
            const found = placeAt(i, !kind);
            if (!found) {
                break;
            }
            if (found.end >= low.length) {
                return null; // only a place, nothing to search for ("spiel Musik im Wohnzimmer")
            }
            place = found;
            i = found.end;
        } else {
            break;
        }
    }

    let end = words.length;
    const trimTail = (): void => {
        for (;;) {
            if (end > i && TRAILING.has(low[end - 1])) {
                end--;
            } else if (end > i && serviceWord(low[end - 1])) {
                end--;
                while (end > i && (PREPOSITIONS.has(low[end - 1]) || low[end - 1] === 'von')) {
                    end--;
                }
            } else {
                return;
            }
        }
    };
    trimTail();
    // A trailing player: its name or room, preceded by a preposition, so a title that ends like a room is kept.
    for (const c of place ? [] : candidates) {
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
        place = { player: c.player, service: c.service, end };
        end = start;
        trimTail();
        break;
    }
    // A trailing place that is no player ("… im Bad"): one word after "im"/"в", answered with "I don't know it".
    const lastPlace = end - 2;
    if (
        !place &&
        lastPlace > i &&
        (LOCATIVE.has(low[lastPlace]) ||
            (lastPlace - 1 > i && low[lastPlace - 1] === 'in' && ARTICLES.has(low[lastPlace])))
    ) {
        place = { player: words[end - 1], end };
        end = LOCATIVE.has(low[lastPlace]) ? lastPlace : lastPlace - 1;
        trimTail();
    }

    const rest = words.slice(i, end);
    const restLow = low.slice(i, end);
    let query = rest.join(' ').trim();
    let artist = '';
    if (byArtist) {
        artist = query;
        query = '';
    } else if (kind !== 'artist' && kind !== 'playlist' && (kind || playVerb)) {
        // "<title> von <artist>": the last split word that has something on both sides
        for (let k = restLow.length - 2; k >= 1; k--) {
            if (SPLIT_WORDS.has(restLow[k])) {
                query = rest.slice(0, k).join(' ').trim();
                artist = rest
                    .slice(k + 1)
                    .join(' ')
                    .trim();
                break;
            }
        }
    }
    // "von den Beatles" → "Beatles"
    const withoutArticle = (name: string): string => {
        const list = name.split(' ');
        while (list.length > 1 && ARTIST_ARTICLES.has(fold(list[0]))) {
            list.shift();
        }
        return list.join(' ');
    };
    artist = withoutArticle(artist);
    if (ofArtist) {
        query = withoutArticle(query);
    }
    let guess = false;
    if (!kind) {
        if (artist) {
            kind = 'track';
        } else if (sawSpotify) {
            kind = 'auto';
        } else if (playVerb && !said && place?.service !== 'youtube') {
            // "spiel die Piano Guys (in der Küche)": maybe music; "включи …" without a kind word is a device, and
            // "… auf YouTube" / "… auf dem Fernseher" stays with the YouTube parser
            kind = 'auto';
            guess = true;
        } else {
            return null;
        }
    }
    if ((!query && !artist) || NOT_A_QUERY.has(fold(query || artist))) {
        return null;
    }
    const service = said || place?.service;
    return {
        kind,
        query,
        ...(artist ? { artist } : {}),
        ...(place ? { player: place.player } : {}),
        ...(service ? { service } : {}),
        ...(guess ? { guess } : {}),
    };
}

/**
 * The same request as a YouTube search: a song is a video "title artist", an album a playlist "album artist", an
 * artist whatever is named like it (a channel of that name, else videos).
 *
 * @param req what to play
 */
export function youtubeMusicQuery(req: MusicRequest): { query: string; kind: 'video' | 'playlist' | 'auto' } {
    const text = [req.query, req.artist].filter(Boolean).join(' ').trim();
    switch (req.kind) {
        case 'album':
        case 'playlist':
            return { query: text, kind: 'playlist' };
        case 'artist':
            return { query: text, kind: 'auto' };
        default:
            return { query: text, kind: 'video' };
    }
}

// ── Search ──────────────────────────────────────────────────────────────────

/**
 * The title without what a release adds: "Bohemian Rhapsody - Remastered 2011" → "Bohemian Rhapsody",
 * "Song (feat. X)" → "Song".
 *
 * @param name title as Spotify has it
 */
export function titleCore(name: string): string {
    const core = name
        .replace(/\s+[-–—]\s+.*$/, '')
        .replace(/\s*[([][^)\]]*[)\]]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return core || name;
}

/**
 * Is a hit named like what was said? Spaces, case and a typo or two from the speech recognition do not count.
 *
 * @param said the query
 * @param name name of the hit
 */
export function namedLike(said: string, name: string): boolean {
    return similarName(said, name) || similarName(said, titleCore(name));
}

/**
 * Is the artist one of these?
 *
 * @param said the artist as said
 * @param artists the artists of a hit
 */
export function artistLike(said: string, artists: string[] | undefined): boolean {
    const list = artists || [];
    const folded = fold(said);
    // "Beatles" is "The Beatles", "Queen" is not "Queens of the Stone Age"
    return list.some(a => similarName(said, a) || (!!folded && ` ${fold(a)} `.includes(` ${folded} `)));
}

function toHit(item: SpotifySearchItem | undefined): MusicHit | null {
    if (!item?.uri || !['track', 'album', 'artist', 'playlist'].includes(item.type)) {
        return null;
    }
    return {
        kind: item.type as MusicKind,
        uri: item.uri,
        name: item.name,
        ...(item.artists?.length ? { artists: item.artists } : {}),
        ...(item.album ? { album: item.album } : {}),
        ...(item.owner ? { owner: item.owner } : {}),
    };
}

/** The hits with the best one first. */
function ordered(items: SpotifySearchItem[], best: SpotifySearchItem | undefined): MusicHit[] {
    const list = best ? [best, ...items.filter(i => i !== best)] : items;
    return list.map(toHit).filter((h): h is MusicHit => !!h);
}

/**
 * A Spotify URI or link as a hit of its own: `spotify:track:<id>`, `https://open.spotify.com/(intl-de/)album/<id>`.
 * The name is the URI — the reply then does not read it out.
 *
 * @param text what to play
 */
export function directSpotifyUri(text: string): MusicHit | null {
    const m =
        text.match(/^spotify:(track|album|artist|playlist):([A-Za-z0-9]{10,})$/) ||
        text.match(
            /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|album|artist|playlist)\/([A-Za-z0-9]{10,})/,
        );
    if (!m) {
        return null;
    }
    const uri = `spotify:${m[1]}:${m[2]}`;
    return { kind: m[1] as MusicKind, uri, name: uri };
}

/**
 * The arguments of the tool `play_music` or the message `playMusic` as a request; null without query and artist.
 *
 * @param args query, artist?, kind?
 */
export function musicRequestOf(args: Record<string, unknown>): MusicRequest | null {
    let query = typeof args.query === 'string' ? args.query.trim() : '';
    let artist = typeof args.artist === 'string' ? args.artist.trim() : '';
    if (!query && !artist) {
        return null;
    }
    const kind = (['track', 'album', 'artist', 'playlist'] as const).find(k => k === args.kind) || 'auto';
    if (!query && (kind === 'artist' || kind === 'playlist')) {
        query = artist;
        artist = '';
    }
    return { kind, query, ...(artist ? { artist } : {}) };
}

/** Search in the catalog: the message `search` of spotify-premium. */
export type SearchFn = (request: Record<string, unknown>) => Promise<SpotifySearchItem[]>;
/** The playlists of the user: the message `getPlaylists` of spotify-premium. */
export type PlaylistsFn = (search: string) => Promise<SpotifyPlaylistItem[]>;

const LIMIT = 5;

/**
 * Find what was asked for, the best hit first.
 *
 * - track/album with title and artist: Spotify's field filters, without a hit once more as free text (the field
 *   filters are strict, and a title or artist through speech recognition is often a bit off); the first hit named
 *   like the title and by the artist wins, else Spotify's first.
 * - artist: the artist named like it, else Spotify's first.
 * - playlist: a playlist of the user named like it (or the only one containing the words), else the catalog.
 * - auto: an artist, playlist, album or track named like it (in this order), else the first track.
 *
 * @param req what to find
 * @param search the search of spotify-premium
 * @param playlists the playlists of the user
 */
export async function findMusic(req: MusicRequest, search: SearchFn, playlists?: PlaylistsFn): Promise<MusicHit[]> {
    const query = req.query.trim();
    const artist = (req.artist || '').trim();
    const direct = directSpotifyUri(query);
    if (direct) {
        return [direct];
    }
    switch (req.kind) {
        case 'track':
        case 'album': {
            const type = req.kind;
            let items: SpotifySearchItem[];
            if (query && artist) {
                items = await search({ [type]: query, artist, type, limit: LIMIT });
                if (!items.length) {
                    items = await search({ query: `${query} ${artist}`, type, limit: LIMIT });
                }
            } else if (query) {
                items = await search({ query, type, limit: LIMIT });
            } else {
                items = await search({ artist, type, limit: LIMIT });
            }
            const best = items.find(
                i => (!query || namedLike(query, i.name)) && (!artist || artistLike(artist, i.artists)),
            );
            return ordered(items, best);
        }
        case 'artist': {
            const items = await search({ query: query || artist, type: 'artist', limit: LIMIT });
            return ordered(
                items,
                items.find(i => namedLike(query || artist, i.name)),
            );
        }
        case 'playlist': {
            const own = playlists ? await playlists('') : [];
            const words = fold(query).split(' ').filter(Boolean);
            const containing = own.filter(p => words.every(w => fold(p.name).includes(w)));
            const mine = own.find(p => namedLike(query, p.name)) || (containing.length === 1 ? containing[0] : null);
            if (mine) {
                return [{ kind: 'playlist', uri: mine.uri, name: mine.name }];
            }
            const items = await search({ query, type: 'playlist', limit: LIMIT });
            return ordered(
                items,
                items.find(i => namedLike(query, i.name)),
            );
        }
        default: {
            const text = [query, artist].filter(Boolean).join(' ');
            const items = await search({ query: text, type: 'artist,playlist,album,track', limit: LIMIT });
            // "Piano Guys" is the artist "The Piano Guys"
            const named = (i: SpotifySearchItem): boolean =>
                namedLike(text, i.name) || (i.type === 'artist' && artistLike(text, [i.name]));
            let best: SpotifySearchItem | undefined;
            for (const type of ['artist', 'playlist', 'album', 'track']) {
                best = items.find(i => i.type === type && named(i));
                if (best) {
                    break;
                }
            }
            if (req.strict) {
                return best ? ordered(items.filter(named), best) : [];
            }
            return ordered(items, best || items.find(i => i.type === 'track') || items[0]);
        }
    }
}

// ── Playing ─────────────────────────────────────────────────────────────────

/** Where a request was asked: the satellite and its names, and its room. */
export interface MusicHere {
    /** Id of the satellite under `satellites.*`; '' = not asked on a satellite (chat, Telegram, script) */
    satellite: string;
    /** Other names of the satellite (the device name) */
    names?: string[];
    room?: string;
}

/**
 * The player of a request: the named one; without a name the satellite that was spoken to — the player linked to it
 * (column "Satellite"), a player named like it, else the player in its room — and null when there is none, so the
 * music does not start in another room. Without a satellite (chat, Telegram) the first player.
 *
 * @param players the music players
 * @param wanted the player or room as said
 * @param here where the request was asked
 */
export function playerFor(players: MusicPlayer[], wanted: string | undefined, here: MusicHere): MusicPlayer | null {
    if (wanted?.trim() || !here.satellite) {
        return findPlayer(players, wanted, here.room || '');
    }
    const same = (a: string | undefined, b: string | undefined): boolean => !!a && !!b && fold(a) === fold(b);
    const names = [here.satellite, ...(here.names || [])].filter(Boolean);
    return (
        players.find(p => same(p.satellite, here.satellite)) ||
        players.find(p => names.some(n => same(n, p.name) || same(n, p.device))) ||
        (here.room ? players.find(p => same(p.room, here.room) || same(p.name, here.room)) : undefined) ||
        null
    );
}

/** Outcome of {@link playMusic}: the reply to speak plus what was found. */
export interface MusicPlayResult {
    ok: boolean;
    text: string;
    player?: string;
    hit?: MusicHit;
    /** The next hits, to offer if the first was the wrong one */
    alternatives?: MusicHit[];
    /** Why it failed: the reason of spotify-premium or {@link ADAPTER_DOWN}/{@link OUTDATED} */
    reason?: string;
    /** The Spotify Connect device that plays */
    device?: string;
}

export interface MusicDeps {
    /**
     * Send a message to the spotify-premium instance of the player. Throws a {@link MusicError} with
     * {@link ADAPTER_DOWN} or {@link OUTDATED} when it cannot take it.
     */
    ask(command: string, message: Record<string, unknown>): Promise<unknown>;
    /** Language of the reply */
    language: string;
    /** Name the player in the reply (more than one is configured) */
    sayPlayer: boolean;
}

/** The answer of spotify-premium, or its error as {@link MusicError}. */
function unwrap(answer: unknown): Record<string, any> {
    if (!answer || typeof answer !== 'object') {
        throw new MusicError('no answer');
    }
    const a = answer as Record<string, any>;
    if (a.error) {
        throw new MusicError(String(a.error), typeof a.reason === 'string' ? a.reason : '');
    }
    return a;
}

/**
 * {@link findMusic} through the messages of a player's adapter (`search`, `getPlaylists`); throws a
 * {@link MusicError} when the adapter cannot answer.
 *
 * @param req what to find
 * @param ask the way to the adapter
 */
export async function searchMusic(req: MusicRequest, ask: MusicDeps['ask']): Promise<MusicHit[]> {
    return findMusic(
        req,
        async request => {
            const items = unwrap(await ask('search', request)).items;
            return Array.isArray(items) ? items : [];
        },
        async search => {
            const list = unwrap(await ask('getPlaylists', { search })).playlists;
            return Array.isArray(list) ? list : [];
        },
    );
}

/**
 * Find something and play it on a player.
 *
 * @param req what to play
 * @param player where
 * @param deps the way to spotify-premium
 */
export async function playMusic(req: MusicRequest, player: MusicPlayer, deps: MusicDeps): Promise<MusicPlayResult> {
    const lang = deps.language;
    const fail = (e: unknown, hit?: MusicHit): MusicPlayResult => {
        const reason = e instanceof MusicError ? e.reason : '';
        return {
            ok: false,
            player: player.name,
            reason: reason || 'FAILED',
            ...(hit ? { hit } : {}),
            text: musicReply(lang, errorKey(reason, player), { instance: player.instance, device: player.device }),
        };
    };
    let hits: MusicHit[];
    try {
        hits = await searchMusic(req, deps.ask);
    } catch (e) {
        return fail(e);
    }
    const hit = hits[0];
    if (!hit) {
        return {
            ok: false,
            player: player.name,
            reason: 'NOT_FOUND',
            text: musicReply(lang, 'notFound', { kind: req.kind, query: req.query, artist: req.artist }),
        };
    }
    let answer: Record<string, any>;
    try {
        answer = unwrap(await deps.ask('play', { uri: hit.uri, ...(player.device ? { device: player.device } : {}) }));
    } catch (e) {
        return fail(e, hit);
    }
    const device = typeof answer.device?.name === 'string' ? answer.device.name : '';
    return {
        ok: true,
        player: player.name,
        hit,
        alternatives: hits.slice(1, 4),
        ...(device ? { device } : {}),
        text: musicReply(lang, 'playing', { hit, player: deps.sayPlayer ? player.name : '' }),
    };
}

/**
 * A play result as tool / sendTo data: what plays, why it failed, and the next hits to offer.
 *
 * @param res the result of {@link playMusic}
 */
export function musicResultData(res: MusicPlayResult): Record<string, unknown> {
    const hit = (h: MusicHit): Record<string, unknown> => ({
        kind: h.kind,
        uri: h.uri,
        name: h.name,
        ...(h.artists ? { artists: h.artists } : {}),
        ...(h.album ? { album: h.album } : {}),
        ...(h.owner ? { owner: h.owner } : {}),
    });
    return {
        ok: res.ok,
        text: res.text,
        ...(res.player ? { player: res.player } : {}),
        ...(res.device ? { device: res.device } : {}),
        ...(res.reason ? { reason: res.reason } : {}),
        ...(res.hit ? hit(res.hit) : {}),
        ...(res.alternatives?.length ? { otherResults: res.alternatives.map(hit) } : {}),
    };
}

/** The reply for a failure. */
function errorKey(reason: string, player: MusicPlayer): MusicReplyKey {
    switch (reason) {
        case ADAPTER_DOWN:
            return 'adapterDown';
        case OUTDATED:
            return 'outdated';
        case 'NOT_AUTHORIZED':
            return 'notAuthorized';
        case 'NO_ACTIVE_DEVICE':
            return player.device ? 'deviceOffline' : 'noActiveDevice';
        case 'DEVICE_NOT_FOUND':
            return 'deviceOffline';
        case 'DEVICE_NOT_CONTROLLABLE':
            return 'notControllable';
        case 'PREMIUM_REQUIRED':
            return 'premium';
        default:
            return 'failed';
    }
}

// ── Spoken replies (de/en/ru) ───────────────────────────────────────────────

export type MusicReplyKey =
    | 'playing'
    | 'notFound'
    | 'failed'
    | 'adapterDown'
    | 'outdated'
    | 'notAuthorized'
    | 'noActiveDevice'
    | 'deviceOffline'
    | 'notControllable'
    | 'premium'
    | 'unknownPlayer'
    | 'notHere'
    | 'noControl';

/** What a reply names. */
export interface MusicReplyValues {
    /** What plays */
    hit?: MusicHit;
    /** The player, if it is to be named */
    player?: string;
    /** What was not found */
    kind?: MusicKind | 'auto';
    query?: string;
    artist?: string;
    /** The spotify-premium instance */
    instance?: string;
    /** The Spotify Connect device of the player */
    device?: string;
    /** The known players */
    names?: string;
}

/** "Queen", "Queen und David Bowie", "Queen, David Bowie und …" */
function joinArtists(lang: string, artists: string[] | undefined): string {
    const list = (artists || []).slice(0, 2);
    const and = lang === 'de' ? ' und ' : lang === 'ru' ? ' и ' : ' and ';
    return list.join(and);
}

/** What plays, in the reply language: "„Bohemian Rhapsody“ von Queen", "the album "X" by Y". */
function describeHit(lang: string, hit: MusicHit): string {
    const artists = joinArtists(lang, hit.artists);
    if (hit.name === hit.uri) {
        // Played by its URI: nothing to say that a person could understand
        return lang === 'de' ? 'die Auswahl' : lang === 'ru' ? 'выбранное' : 'the selection';
    }
    if (lang === 'de') {
        const by = artists ? ` von ${artists}` : '';
        switch (hit.kind) {
            case 'track':
                return `„${hit.name}“${by}`;
            case 'album':
                return `das Album „${hit.name}“${by}`;
            case 'artist':
                return `Musik von ${hit.name}`;
            case 'playlist':
                return `die Playlist „${hit.name}“`;
        }
    }
    if (lang === 'ru') {
        const by = artists ? ` (${artists})` : '';
        switch (hit.kind) {
            case 'track':
                return `«${hit.name}»${by}`;
            case 'album':
                return `альбом «${hit.name}»${by}`;
            case 'artist':
                return hit.name;
            case 'playlist':
                return `плейлист «${hit.name}»`;
        }
    }
    const by = artists ? ` by ${artists}` : '';
    switch (hit.kind) {
        case 'track':
            return `"${hit.name}"${by}`;
        case 'album':
            return `the album "${hit.name}"${by}`;
        case 'artist':
            return `music by ${hit.name}`;
        case 'playlist':
            return `the playlist "${hit.name}"`;
    }
    return hit.name;
}

/** What was not found: "keinen Titel „X“ von Y". */
function describeMissing(lang: string, kind: MusicKind | 'auto', query: string, artist: string): string {
    const name = query || artist;
    if (lang === 'de') {
        const what = {
            track: 'keinen Titel',
            album: 'kein Album',
            artist: 'keinen Künstler',
            playlist: 'keine Playlist',
        };
        if (kind === 'auto') {
            return `nichts zu „${name}“`;
        }
        if (!query) {
            return `${kind === 'album' ? 'kein Album' : 'keinen Titel'} von ${artist}`;
        }
        return `${what[kind]} „${query}“${artist && kind !== 'artist' ? ` von ${artist}` : ''}`;
    }
    if (lang === 'ru') {
        const what = { track: 'песню', album: 'альбом', artist: 'исполнителя', playlist: 'плейлист' };
        if (kind === 'auto') {
            return `ничего по запросу «${name}»`;
        }
        if (!query) {
            return `${kind === 'album' ? 'альбомов' : 'песен'} исполнителя ${artist}`;
        }
        return `${what[kind]} «${query}»${artist && kind !== 'artist' ? ` (${artist})` : ''}`;
    }
    if (kind === 'auto') {
        return `nothing for "${name}"`;
    }
    if (!query) {
        return `no ${kind === 'album' ? 'album' : 'track'} by ${artist}`;
    }
    return `no ${kind} "${query}"${artist && kind !== 'artist' ? ` by ${artist}` : ''}`;
}

/**
 * A spoken reply of the music feature.
 *
 * @param lang reply language
 * @param key which reply
 * @param v the values it names
 */
export function musicReply(lang: string, key: MusicReplyKey, v: MusicReplyValues = {}): string {
    const what = v.hit ? describeHit(lang, v.hit) : '';
    const missing = describeMissing(lang, v.kind || 'track', v.query || '', v.artist || '');
    if (lang === 'de') {
        switch (key) {
            case 'playing':
                return `Ich spiele ${what}${v.player ? ` auf ${v.player}` : ''}.`;
            case 'notFound':
                return `Ich habe auf Spotify ${missing} gefunden.`;
            case 'failed':
                return 'Das hat mit Spotify gerade nicht geklappt.';
            case 'adapterDown':
                return `Der Spotify-Adapter ${v.instance} läuft nicht.`;
            case 'outdated':
                return `Der Spotify-Adapter ${v.instance} ist zu alt für die Suche. Bitte aktualisiere ihn.`;
            case 'notAuthorized':
                return 'Der Spotify-Adapter ist nicht mehr bei Spotify angemeldet. Melde ihn in seinen Einstellungen neu an.';
            case 'noActiveDevice':
                return 'Gerade ist kein Spotify-Gerät aktiv. Öffne Spotify auf einem Gerät oder trage in den Einstellungen eins ein.';
            case 'deviceOffline':
                return `Das Gerät „${v.device}“ ist bei Spotify gerade nicht online.`;
            case 'notControllable':
                return `Das Gerät „${v.device}“ lässt sich über Spotify nicht fernsteuern.`;
            case 'premium':
                return 'Dafür braucht Spotify ein Premium-Konto.';
            case 'unknownPlayer':
                return `Einen Musik-Player „${v.query}“ kenne ich nicht. Ich kenne: ${v.names}.`;
            case 'notHere':
                return `Auf diesem Gerät kann ich keine Musik abspielen. Sag, wo: ${v.names}.`;
            case 'noControl':
                return 'Die Gerätesteuerung ist in den Einstellungen ausgeschaltet.';
        }
    }
    if (lang === 'ru') {
        switch (key) {
            case 'playing':
                return `Включаю ${what}${v.player ? ` — ${v.player}` : ''}.`;
            case 'notFound':
                return `На Spotify не нашла ${missing}.`;
            case 'failed':
                return 'Со Spotify сейчас не получилось.';
            case 'adapterDown':
                return `Адаптер Spotify ${v.instance} не запущен.`;
            case 'outdated':
                return `Адаптер Spotify ${v.instance} слишком старый для поиска. Обновите его.`;
            case 'notAuthorized':
                return 'Адаптер Spotify больше не авторизован. Авторизуйте его заново в настройках.';
            case 'noActiveDevice':
                return 'Сейчас нет активного устройства Spotify. Откройте Spotify на устройстве или укажите его в настройках.';
            case 'deviceOffline':
                return `Устройство «${v.device}» сейчас не в сети Spotify.`;
            case 'notControllable':
                return `Устройством «${v.device}» нельзя управлять через Spotify.`;
            case 'premium':
                return 'Для этого нужен аккаунт Spotify Premium.';
            case 'unknownPlayer':
                return `Музыкальный плеер «${v.query}» мне не известен. Я знаю: ${v.names}.`;
            case 'notHere':
                return `На этом устройстве я не могу включить музыку. Скажи, где: ${v.names}.`;
            case 'noControl':
                return 'Управление устройствами отключено в настройках.';
        }
    }
    switch (key) {
        case 'playing':
            return `Playing ${what}${v.player ? ` on ${v.player}` : ''}.`;
        case 'notFound':
            return `I found ${missing} on Spotify.`;
        case 'failed':
            return 'That did not work with Spotify right now.';
        case 'adapterDown':
            return `The Spotify adapter ${v.instance} is not running.`;
        case 'outdated':
            return `The Spotify adapter ${v.instance} is too old for searching. Please update it.`;
        case 'notAuthorized':
            return 'The Spotify adapter is no longer signed in to Spotify. Authorize it again in its settings.';
        case 'noActiveDevice':
            return 'No Spotify device is active right now. Open Spotify on a device or set one in the settings.';
        case 'deviceOffline':
            return `The device "${v.device}" is not online at Spotify right now.`;
        case 'notControllable':
            return `The device "${v.device}" cannot be controlled through Spotify.`;
        case 'premium':
            return 'This needs a Spotify Premium account.';
        case 'unknownPlayer':
            return `I don't know a music player "${v.query}". I know: ${v.names}.`;
        case 'notHere':
            return `I can't play music on this device. Say where: ${v.names}.`;
        case 'noControl':
            return 'Device control is switched off in the settings.';
    }
    return '';
}
