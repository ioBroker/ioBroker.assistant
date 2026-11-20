'use strict';
// Integration test: music — settings rows, the rule-based "play …" parser (Spotify players and TVs), the search
// against a fake spotify-premium and the replies.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseMusicPlayerRows,
    parseMusicCommand,
    youtubeMusicQuery,
    findMusic,
    playMusic,
    musicReply,
    musicRequestOf,
    musicResultData,
    directSpotifyUri,
    titleCore,
    namedLike,
    artistLike,
    findMusicPlayer,
    MusicError,
    ADAPTER_DOWN,
    OUTDATED,
    spotifyTooOld,
} = require('../../build/lib/music.js');

const PLAYERS = parseMusicPlayerRows([
    { name: 'Küche', instance: 'spotify-premium.0', device: 'Echo Küche', room: 'Küche' },
    { name: 'Arbeitszimmer', instance: 'system.adapter.spotify-premium.0', room: 'Büro' },
    { name: 'küche', instance: 'spotify-premium.0' },
    { name: 'kaputt', instance: 'spotify-premium' },
    { instance: 'spotify-premium.1', device: 'Wohnzimmer Sonos' },
]);
const TVS = [{ name: 'Fernseher', room: 'Wohnzimmer' }];

test('parseMusicPlayerRows: instance required, system.adapter. cut off, name from room/device/instance, first name wins', () => {
    assert.deepEqual(
        PLAYERS.map(p => `${p.name}|${p.instance}|${p.device}|${p.room}`),
        [
            'Küche|spotify-premium.0|Echo Küche|Küche',
            'Arbeitszimmer|spotify-premium.0||Büro',
            'Wohnzimmer Sonos|spotify-premium.1|Wohnzimmer Sonos|',
        ],
    );
    assert.deepEqual(parseMusicPlayerRows(undefined), []);
});

test('findMusicPlayer: name, room, room of the request, first row; unknown name = null', () => {
    assert.equal(findMusicPlayer(PLAYERS, 'büro').name, 'Arbeitszimmer');
    assert.equal(findMusicPlayer(PLAYERS, undefined, 'Büro').name, 'Arbeitszimmer');
    assert.equal(findMusicPlayer(PLAYERS).name, 'Küche');
    assert.equal(findMusicPlayer(PLAYERS, 'Garage'), null);
});

const parse = (text, tvs = TVS) => parseMusicCommand(text, PLAYERS, tvs);

test('parseMusicCommand: "<title> von <artist>" after a play verb, in de/en/ru', () => {
    assert.deepEqual(parse('Spiel Bohemian Rhapsody von Queen'), {
        kind: 'track',
        query: 'Bohemian Rhapsody',
        artist: 'Queen',
    });
    assert.deepEqual(parse('play Yesterday by the Beatles'), { kind: 'track', query: 'Yesterday', artist: 'Beatles' });
    assert.deepEqual(parse('Bitte spiele mir Thunderstruck von AC/DC'), {
        kind: 'track',
        query: 'Thunderstruck',
        artist: 'AC/DC',
    });
    // "of" stays in titles
    assert.deepEqual(parse('play the song Queen of the Night'), { kind: 'track', query: 'Queen of the Night' });
});

test('parseMusicCommand: kind words', () => {
    assert.deepEqual(parse('spiele das Album A Night at the Opera'), { kind: 'album', query: 'A Night at the Opera' });
    assert.deepEqual(parse('spiel das Lied The Final Countdown'), { kind: 'track', query: 'The Final Countdown' });
    assert.deepEqual(parse('spiel meine Playlist Party Mix'), { kind: 'playlist', query: 'Party Mix' });
    assert.deepEqual(parse('spiel die Band Queen'), { kind: 'artist', query: 'Queen' });
    assert.deepEqual(parse('spiel Musik von Queen'), { kind: 'artist', query: 'Queen' });
    assert.deepEqual(parse('spiel etwas Musik von Queen'), { kind: 'artist', query: 'Queen' });
    assert.deepEqual(parse('spiel was von Queen'), { kind: 'artist', query: 'Queen' });
    assert.deepEqual(parse('play something by Queen'), { kind: 'artist', query: 'Queen' });
    assert.deepEqual(parse('spiel ein Lied von den Beatles'), { kind: 'track', query: '', artist: 'Beatles' });
    assert.deepEqual(parse('spiel das Album Jazz von Queen'), { kind: 'album', query: 'Jazz', artist: 'Queen' });
});

test('parseMusicCommand: Russian', () => {
    assert.deepEqual(parse('включи песню Группа крови группы Кино'), {
        kind: 'track',
        query: 'Группа крови',
        artist: 'Кино',
    });
    assert.deepEqual(parse('включи песню группы Кино'), { kind: 'track', query: '', artist: 'Кино' });
    assert.deepEqual(parse('поставь альбом Звезда по имени Солнце'), {
        kind: 'album',
        query: 'Звезда по имени Солнце',
    });
    assert.deepEqual(parse('включи музыку Queen'), { kind: 'artist', query: 'Queen' });
    assert.deepEqual(parse('включи что-нибудь из Queen'), { kind: 'artist', query: 'Queen' });
    // "включи" is also a device verb: "от" without a kind word is no song
    assert.equal(parse('включи обогреватель от солнечной батареи'), null);
});

test('parseMusicCommand: the word Spotify — without a kind word the search decides', () => {
    assert.deepEqual(parse('spiel Queen auf Spotify'), { kind: 'auto', query: 'Queen', service: 'spotify' });
    assert.deepEqual(parse('spiel auf Spotify die Playlist Party'), {
        kind: 'playlist',
        query: 'Party',
        service: 'spotify',
    });
    assert.equal(parse('spiel Queen'), null);
});

test('parseMusicCommand: players and rooms, before and after the name', () => {
    assert.deepEqual(parse('spiel das Lied Yesterday in der Küche'), {
        kind: 'track',
        query: 'Yesterday',
        player: 'Küche',
        service: 'spotify',
    });
    assert.deepEqual(parse('spiel im Büro Musik von Queen'), {
        kind: 'artist',
        query: 'Queen',
        player: 'Arbeitszimmer',
        service: 'spotify',
    });
    assert.deepEqual(parse('spiel Bohemian Rhapsody von Queen auf dem Wohnzimmer Sonos'), {
        kind: 'track',
        query: 'Bohemian Rhapsody',
        artist: 'Queen',
        player: 'Wohnzimmer Sonos',
        service: 'spotify',
    });
    // a place that is no player: an honest "don't know"
    assert.deepEqual(parse('spiel das Lied Yesterday im Bad'), { kind: 'track', query: 'Yesterday', player: 'Bad' });
    // a title that ends like a room without a preposition stays a title
    assert.deepEqual(parse('spiel das Lied Küche'), { kind: 'track', query: 'Küche' });
    // only a place: nothing to search for
    assert.equal(parse('spiel Musik im Wohnzimmer'), null);
});

test('parseMusicCommand: songs on a TV go to YouTube', () => {
    assert.deepEqual(parse('spiel das Lied Yesterday von den Beatles auf dem Fernseher'), {
        kind: 'track',
        query: 'Yesterday',
        artist: 'Beatles',
        player: 'Fernseher',
        service: 'youtube',
    });
    assert.deepEqual(parse('spiel Bohemian Rhapsody von Queen im Wohnzimmer'), {
        kind: 'track',
        query: 'Bohemian Rhapsody',
        artist: 'Queen',
        player: 'Fernseher',
        service: 'youtube',
    });
    assert.deepEqual(parse('spiel das Lied Yesterday auf YouTube'), {
        kind: 'track',
        query: 'Yesterday',
        service: 'youtube',
    });
    // "auf YouTube" only looks at TVs: "Küche" is no TV, so it is an unknown place, not the Spotify player
    assert.deepEqual(parse('spiel das Lied Yesterday auf YouTube in der Küche'), {
        kind: 'track',
        query: 'Yesterday',
        player: 'Küche',
        service: 'youtube',
    });
    // only TVs configured
    assert.deepEqual(parseMusicCommand('spiel das Album Abbey Road', [], TVS), { kind: 'album', query: 'Abbey Road' });
    // channels and videos are the YouTube parser's, radio and podcasts nobody's
    assert.equal(parse('spiel den Kanal Sailing OceanAir'), null);
    assert.equal(parse('spiel das Video Bohemian Rhapsody von Queen'), null);
    assert.equal(parse('spiel Radio Bob'), null);
    assert.equal(parse('spiel Queen auf Spotify und YouTube'), null);
    // without a kind word and without "von", YouTube alone is the YouTube parser's
    assert.equal(parse('spiel Sailing OceanAir auf YouTube'), null);
});

test('parseMusicCommand: a clip is a music video on YouTube, only TVs count as its players', () => {
    assert.deepEqual(parse('spiel den Clip Bohemian Rhapsody von Queen'), {
        kind: 'track',
        query: 'Bohemian Rhapsody',
        artist: 'Queen',
        service: 'youtube',
    });
    assert.deepEqual(parse('spiel den Clip Bohemian Rhapsody von Queen auf dem Fernseher'), {
        kind: 'track',
        query: 'Bohemian Rhapsody',
        artist: 'Queen',
        player: 'Fernseher',
        service: 'youtube',
    });
    assert.deepEqual(parse('spiel im Wohnzimmer das Musikvideo Thriller von Michael Jackson'), {
        kind: 'track',
        query: 'Thriller',
        artist: 'Michael Jackson',
        player: 'Fernseher',
        service: 'youtube',
    });
    assert.deepEqual(parse('spiel einen Clip von Queen'), {
        kind: 'track',
        query: '',
        artist: 'Queen',
        service: 'youtube',
    });
    assert.deepEqual(parse('play the music video Bad Romance by Lady Gaga'), {
        kind: 'track',
        query: 'Bad Romance',
        artist: 'Lady Gaga',
        service: 'youtube',
    });
    assert.deepEqual(parse('включи клип Группа крови группы Кино'), {
        kind: 'track',
        query: 'Группа крови',
        artist: 'Кино',
        service: 'youtube',
    });
    assert.deepEqual(parse('включи музыкальный клип Queen'), { kind: 'track', query: 'Queen', service: 'youtube' });
    // the Spotify player in the kitchen is no TV: an unknown place for a clip
    assert.deepEqual(parse('spiel den Clip Yesterday in der Küche'), {
        kind: 'track',
        query: 'Yesterday',
        player: 'Küche',
        service: 'youtube',
    });
    assert.equal(parse('spiel den Clip Yesterday auf Spotify'), null);
    // "Video" alone stays with the YouTube parser
    assert.equal(parse('spiel das Video Bohemian Rhapsody'), null);
    assert.deepEqual(youtubeMusicQuery(parse('spiel den Clip Bohemian Rhapsody von Queen')), {
        query: 'Bohemian Rhapsody Queen',
        kind: 'video',
    });
});

test('parseMusicCommand: not a play command', () => {
    assert.equal(parse('mach das Licht an'), null);
    assert.equal(parse('spiel das Lied'), null);
    assert.equal(parse('spiel nochmal'), null);
    assert.equal(parse('welches Lied läuft gerade'), null);
});

test('youtubeMusicQuery: song = video "title artist", album = playlist, artist = auto', () => {
    assert.deepEqual(youtubeMusicQuery({ kind: 'track', query: 'Yesterday', artist: 'Beatles' }), {
        query: 'Yesterday Beatles',
        kind: 'video',
    });
    assert.deepEqual(youtubeMusicQuery({ kind: 'album', query: 'Abbey Road', artist: 'Beatles' }), {
        query: 'Abbey Road Beatles',
        kind: 'playlist',
    });
    assert.deepEqual(youtubeMusicQuery({ kind: 'artist', query: 'Queen' }), { query: 'Queen', kind: 'auto' });
});

test('titleCore / namedLike / artistLike', () => {
    assert.equal(titleCore('Bohemian Rhapsody - Remastered 2011'), 'Bohemian Rhapsody');
    assert.equal(titleCore('Song (feat. X) [Live]'), 'Song');
    assert.ok(namedLike('bohemian rhapsody', 'Bohemian Rhapsody - Remastered 2011'));
    assert.ok(namedLike('Bohemian Rapsody', 'Bohemian Rhapsody'));
    assert.ok(!namedLike('Yesterday', 'Yellow Submarine'));
    assert.ok(artistLike('Beatles', ['The Beatles']));
    assert.ok(artistLike('queen', ['David Bowie', 'Queen']));
    assert.ok(!artistLike('Queen', ['Queens of the Stone Age']));
});

test('directSpotifyUri / musicRequestOf', () => {
    assert.deepEqual(directSpotifyUri('spotify:track:4uLU6hMCjMI75M1A2tKUQC'), {
        kind: 'track',
        uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
        name: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
    });
    assert.equal(
        directSpotifyUri('https://open.spotify.com/intl-de/album/1GbtB4zTqAsyfZEsm1RZfx?si=x').uri,
        'spotify:album:1GbtB4zTqAsyfZEsm1RZfx',
    );
    assert.equal(directSpotifyUri('Bohemian Rhapsody'), null);
    assert.deepEqual(musicRequestOf({ query: ' Yesterday ', artist: 'Beatles', kind: 'track' }), {
        kind: 'track',
        query: 'Yesterday',
        artist: 'Beatles',
    });
    assert.deepEqual(musicRequestOf({ artist: 'Queen', kind: 'artist' }), { kind: 'artist', query: 'Queen' });
    assert.deepEqual(musicRequestOf({ query: 'Queen', kind: 'video' }), { kind: 'auto', query: 'Queen' });
    assert.equal(musicRequestOf({ query: '  ' }), null);
});

/** A fake search: answers by type from a table, records the requests. */
function fakeSearch(table) {
    const calls = [];
    const fn = async req => {
        calls.push(req);
        const types = String(req.type).split(',');
        const key = req.track || req.album ? `${types[0]}:fields` : types.join(',');
        return table[key] || [];
    };
    fn.calls = calls;
    return fn;
}

test('findMusic: title + artist with field filters, free text when they find nothing, the named hit first', async () => {
    const search = fakeSearch({
        'track:fields': [],
        track: [
            { type: 'track', uri: 'spotify:track:cover', name: 'Bohemian Rhapsody', artists: ['Some Band'] },
            { type: 'track', uri: 'spotify:track:t1', name: 'Bohemian Rhapsody - Remastered 2011', artists: ['Queen'] },
        ],
    });
    const hits = await findMusic({ kind: 'track', query: 'Bohemian Rhapsody', artist: 'Queen' }, search);
    assert.deepEqual(search.calls, [
        { track: 'Bohemian Rhapsody', artist: 'Queen', type: 'track', limit: 5 },
        { query: 'Bohemian Rhapsody Queen', type: 'track', limit: 5 },
    ]);
    assert.deepEqual(
        hits.map(h => h.uri),
        ['spotify:track:t1', 'spotify:track:cover'],
    );
    assert.deepEqual(hits[0].artists, ['Queen']);
});

test('findMusic: only an artist, artist search, playlists of the user first, auto, direct uri', async () => {
    let search = fakeSearch({ track: [{ type: 'track', uri: 'spotify:track:a', name: 'A', artists: ['Queen'] }] });
    await findMusic({ kind: 'track', query: '', artist: 'Queen' }, search);
    assert.deepEqual(search.calls, [{ artist: 'Queen', type: 'track', limit: 5 }]);

    search = fakeSearch({
        artist: [
            { type: 'artist', uri: 'spotify:artist:qotsa', name: 'Queens of the Stone Age' },
            { type: 'artist', uri: 'spotify:artist:queen', name: 'Queen' },
        ],
    });
    assert.equal((await findMusic({ kind: 'artist', query: 'queen' }, search))[0].uri, 'spotify:artist:queen');

    search = fakeSearch({ playlist: [{ type: 'playlist', uri: 'spotify:playlist:public', name: 'Party Hits' }] });
    const own = async () => [
        { uri: 'spotify:playlist:mine', name: 'Party 2026' },
        { uri: 'spotify:playlist:other', name: 'Chill' },
    ];
    let hits = await findMusic({ kind: 'playlist', query: 'party' }, search, own);
    assert.deepEqual(hits, [{ kind: 'playlist', uri: 'spotify:playlist:mine', name: 'Party 2026' }]);
    assert.equal(search.calls.length, 0);
    hits = await findMusic({ kind: 'playlist', query: 'Party Hits' }, search, async () => []);
    assert.equal(hits[0].uri, 'spotify:playlist:public');

    search = fakeSearch({
        'artist,playlist,album,track': [
            { type: 'track', uri: 'spotify:track:x', name: 'Queen of Hearts', artists: ['X'] },
            { type: 'album', uri: 'spotify:album:q', name: 'Queen', artists: ['Queen'] },
            { type: 'artist', uri: 'spotify:artist:queen', name: 'Queen' },
        ],
    });
    hits = await findMusic({ kind: 'auto', query: 'Queen' }, search);
    assert.equal(hits[0].uri, 'spotify:artist:queen');

    search = fakeSearch({});
    hits = await findMusic({ kind: 'auto', query: 'spotify:album:1GbtB4zTqAsyfZEsm1RZfx' }, search);
    assert.equal(hits[0].uri, 'spotify:album:1GbtB4zTqAsyfZEsm1RZfx');
    assert.equal(search.calls.length, 0);
});

/** A fake spotify-premium: answers the messages like the adapter does. */
function fakeSpotify(answers) {
    const sent = [];
    return {
        sent,
        ask: async (command, message) => {
            sent.push({ command, message });
            const a = answers[command];
            if (a instanceof Error) {
                throw a;
            }
            return typeof a === 'function' ? a(message) : a;
        },
    };
}

const QUEEN = { type: 'track', uri: 'spotify:track:t1', name: 'Bohemian Rhapsody', artists: ['Queen'] };

test('playMusic: search, play on the configured device, reply with what plays', async () => {
    const spotify = fakeSpotify({
        search: { items: [QUEEN, { ...QUEEN, uri: 'spotify:track:t2', name: 'Bohemian Rhapsody - Live' }] },
        play: { ok: true, device: { id: 'echo1', name: 'Echo Küche' } },
    });
    const res = await playMusic({ kind: 'track', query: 'Bohemian Rhapsody', artist: 'Queen' }, PLAYERS[0], {
        ask: spotify.ask,
        language: 'de',
        sayPlayer: true,
    });
    assert.equal(res.ok, true);
    assert.equal(res.device, 'Echo Küche');
    assert.equal(res.text, 'Ich spiele „Bohemian Rhapsody“ von Queen auf Küche.');
    assert.deepEqual(spotify.sent[1], { command: 'play', message: { uri: 'spotify:track:t1', device: 'Echo Küche' } });
    assert.deepEqual(
        res.alternatives.map(h => h.uri),
        ['spotify:track:t2'],
    );
    const data = musicResultData(res);
    assert.equal(data.uri, 'spotify:track:t1');
    assert.deepEqual(data.otherResults, [
        { kind: 'track', uri: 'spotify:track:t2', name: 'Bohemian Rhapsody - Live', artists: ['Queen'] },
    ]);

    // no device in the row: none sent, the active one plays; one player: not named
    const res2 = await playMusic({ kind: 'track', query: 'Bohemian Rhapsody' }, PLAYERS[1], {
        ask: spotify.ask,
        language: 'en',
        sayPlayer: false,
    });
    assert.deepEqual(spotify.sent[3].message, { uri: 'spotify:track:t1' });
    assert.equal(res2.text, 'Playing "Bohemian Rhapsody" by Queen.');
});

test('playMusic: not found, device offline, nothing active, adapter down, too old, not authorized', async () => {
    const opts = (ask, language = 'de') => ({ ask, language, sayPlayer: false });
    let res = await playMusic({ kind: 'track', query: 'Xyzzy' }, PLAYERS[0], opts(fakeSpotify({ search: { items: [] } }).ask));
    assert.equal(res.reason, 'NOT_FOUND');
    assert.equal(res.text, 'Ich habe auf Spotify keinen Titel „Xyzzy“ gefunden.');

    const failing = answer => opts(fakeSpotify({ search: { items: [QUEEN] }, play: answer }).ask);
    res = await playMusic({ kind: 'track', query: 'x' }, PLAYERS[0], failing({ error: 'Device not found', reason: 'DEVICE_NOT_FOUND' }));
    assert.equal(res.ok, false);
    assert.equal(res.hit.uri, 'spotify:track:t1');
    assert.equal(res.text, 'Das Gerät „Echo Küche“ ist bei Spotify gerade nicht online.');

    res = await playMusic({ kind: 'track', query: 'x' }, PLAYERS[1], failing({ error: 'x', reason: 'NO_ACTIVE_DEVICE' }));
    assert.match(res.text, /kein Spotify-Gerät aktiv/);

    res = await playMusic(
        { kind: 'track', query: 'x' },
        PLAYERS[0],
        opts(fakeSpotify({ search: new MusicError('down', ADAPTER_DOWN) }).ask, 'en'),
    );
    assert.equal(res.reason, ADAPTER_DOWN);
    assert.equal(res.text, 'The Spotify adapter spotify-premium.0 is not running.');

    res = await playMusic(
        { kind: 'track', query: 'x' },
        PLAYERS[0],
        opts(fakeSpotify({ search: new MusicError('old', OUTDATED) }).ask, 'ru'),
    );
    assert.equal(res.reason, OUTDATED);
    assert.match(res.text, /слишком старый/);

    res = await playMusic(
        { kind: 'track', query: 'x' },
        PLAYERS[0],
        opts(fakeSpotify({ search: { error: 'reauthorization required', reason: 'NOT_AUTHORIZED' } }).ask),
    );
    assert.equal(res.reason, 'NOT_AUTHORIZED');
    assert.match(res.text, /nicht mehr bei Spotify angemeldet/);

    // an error without reason
    res = await playMusic({ kind: 'track', query: 'x' }, PLAYERS[0], opts(fakeSpotify({ search: new Error('boom') }).ask));
    assert.equal(res.reason, 'FAILED');
});

test('musicReply: every reply in every language, played by uri is not read out', () => {
    const keys = [
        'playing',
        'notFound',
        'failed',
        'adapterDown',
        'outdated',
        'notAuthorized',
        'noActiveDevice',
        'deviceOffline',
        'notControllable',
        'premium',
        'unknownPlayer',
        'noControl',
    ];
    const hit = { kind: 'album', uri: 'spotify:album:a', name: 'Jazz', artists: ['Queen'] };
    for (const lang of ['de', 'en', 'ru']) {
        for (const key of keys) {
            const text = musicReply(lang, key, { hit, query: 'x', names: 'Küche', instance: 'spotify-premium.0', device: 'Echo' });
            assert.ok(text && !text.includes('undefined'), `${lang}/${key}: ${text}`);
        }
    }
    assert.equal(musicReply('de', 'playing', { hit }), 'Ich spiele das Album „Jazz“ von Queen.');
    assert.equal(musicReply('ru', 'playing', { hit: { ...hit, kind: 'playlist', name: 'Утро' } }), 'Включаю плейлист «Утро».');
    assert.equal(
        musicReply('en', 'playing', { hit: { kind: 'track', uri: 'spotify:track:x', name: 'spotify:track:x' } }),
        'Playing the selection.',
    );
    assert.equal(
        musicReply('de', 'notFound', { kind: 'track', query: '', artist: 'Queen' }),
        'Ich habe auf Spotify keinen Titel von Queen gefunden.',
    );
});

test('spotifyTooOld: messages since spotify-premium 3.3.0', () => {
    for (const v of ['3.3.0', '3.3.0-alpha.0', '3.3.1', '3.10.0', '4.0.0']) {
        assert.equal(spotifyTooOld(v), false, v);
    }
    for (const v of ['3.2.0', '3.1.0', '2.9.9', '', undefined, 'x']) {
        assert.equal(spotifyTooOld(v), true, String(v));
    }
});
