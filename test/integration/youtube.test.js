'use strict';
// Integration test: YouTube players — settings rows, player choice, the rule-based "play …" parser and the
// InnerTube search parser (against a trimmed real response shape, no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parsePlayerRows,
    pickDevice,
    isInstanceId,
    findPlayer,
    isPowerOn,
    directYouTubeTarget,
    parseSearchResults,
    pickBest,
    similarName,
    isNamedChannel,
    spokenTitle,
    searchYouTube,
    parseYouTubeCommand,
    youtubeReply,
    DEFAULT_POWER_DELAY_SEC,
} = require('../../build/lib/youtube.js');

const PLAYERS = parsePlayerRows([
    { name: 'Fernseher', id: 'youtube-remote.0.living', power: 'samsungtv.0.tv.control.power', room: 'Wohnzimmer' },
    { name: 'Schlafzimmer TV', id: 'youtube-remote.0.bedroom.youtube', room: 'Schlafzimmer', delay: 15 },
    { name: 'fernseher', id: 'youtube-remote.0.duplicate' },
    { name: 'no id' },
]);

test('parsePlayerRows: device or youtube state, defaults, first name wins, rows without player skipped', () => {
    assert.equal(PLAYERS.length, 2);
    assert.equal(PLAYERS[0].base, 'youtube-remote.0.living');
    assert.equal(PLAYERS[0].target, 'youtube-remote.0.living.youtube');
    assert.equal(PLAYERS[0].delaySec, DEFAULT_POWER_DELAY_SEC);
    assert.equal(PLAYERS[1].base, 'youtube-remote.0.bedroom');
    assert.equal(PLAYERS[1].target, 'youtube-remote.0.bedroom.youtube');
    assert.equal(PLAYERS[1].power, '');
    assert.equal(PLAYERS[1].delaySec, 15);
    assert.equal(parsePlayerRows([{ id: 'youtube-remote.0.abc', delay: 999 }])[0].delaySec, 120);
    assert.equal(parsePlayerRows([{ id: 'youtube-remote.0.abc' }])[0].name, 'abc');
    assert.deepEqual(parsePlayerRows(undefined), []);
});

test('parsePlayerRows: an instance row is resolved later and named after its device if unnamed', () => {
    const [unnamed, named] = parsePlayerRows([
        { id: 'youtube-remote.0' },
        { id: 'youtube-remote.1', name: 'Schlafzimmer' },
    ]);
    assert.equal(unnamed.instance, 'youtube-remote.0');
    assert.equal(unnamed.name, '');
    assert.equal(unnamed.base, '');
    assert.equal(unnamed.target, '');
    assert.equal(named.name, 'Schlafzimmer');
    assert.equal(PLAYERS[0].instance, '');
    assert.equal(isInstanceId('youtube-remote.0'), true);
    assert.equal(isInstanceId('youtube-remote.0.tv_8198d994'), false);
});

test('pickDevice: the device named like the row, else the first; nothing paired → null', () => {
    const devices = [
        { id: 'youtube-remote.0.tv_b', name: 'Schlafzimmer TV' },
        { id: 'youtube-remote.0.tv_a', name: 'TV' },
    ];
    assert.equal(pickDevice(devices, { name: '', room: '' }).id, 'youtube-remote.0.tv_a');
    assert.equal(pickDevice(devices, { name: 'Schlafzimmer TV', room: '' }).id, 'youtube-remote.0.tv_b');
    assert.equal(pickDevice(devices, { name: 'Fernseher', room: 'Schlafzimmer' }).id, 'youtube-remote.0.tv_b');
    assert.equal(pickDevice([], { name: 'x', room: '' }), null);
});

test('findPlayer: name, room, inflected words, requesting room, then the first; unknown name → null', () => {
    assert.equal(findPlayer(PLAYERS).name, 'Fernseher');
    assert.equal(findPlayer(PLAYERS, 'schlafzimmer tv').name, 'Schlafzimmer TV');
    assert.equal(findPlayer(PLAYERS, 'Schlafzimmer').name, 'Schlafzimmer TV');
    assert.equal(findPlayer(PLAYERS, 'Wohnzimmer').name, 'Fernseher');
    assert.equal(findPlayer(PLAYERS, '', 'Schlafzimmer').name, 'Schlafzimmer TV');
    assert.equal(findPlayer(PLAYERS, '', 'Küche').name, 'Fernseher');
    assert.equal(findPlayer(PLAYERS, 'Garage'), null);
    assert.equal(findPlayer([], ''), null);
});

test('isPowerOn understands the usual forms', () => {
    for (const v of [true, 1, 2, 'on', 'ON', 'true', '1']) {
        assert.equal(isPowerOn(v), true, String(v));
    }
    for (const v of [false, 0, 'off', 'false', '', null, undefined]) {
        assert.equal(isPowerOn(v), false, String(v));
    }
});

test('directYouTubeTarget passes ids and URLs, searches everything else', () => {
    assert.equal(directYouTubeTarget('UCbmF2AHnpQsogOLW-MxBiJg', 'channel'), 'UCbmF2AHnpQsogOLW-MxBiJg');
    assert.equal(
        directYouTubeTarget('PLxLtKEN3sA4OTbjcS6yG-btKQn8hKb3GO', 'playlist'),
        'PLxLtKEN3sA4OTbjcS6yG-btKQn8hKb3GO',
    );
    assert.equal(directYouTubeTarget('https://youtu.be/jNQXAC9IVRw', 'video'), 'https://youtu.be/jNQXAC9IVRw');
    assert.equal(directYouTubeTarget('jNQXAC9IVRw', 'video'), 'jNQXAC9IVRw');
    assert.equal(directYouTubeTarget('jNQXAC9IVRw', 'channel'), null);
    assert.equal(directYouTubeTarget('tagesschaus', 'video'), null);
    assert.equal(directYouTubeTarget('Sailing OceanAir', 'channel'), null);
});

// Trimmed from a real InnerTube answer (2026-10): channel hits sit in channelRenderer, playlists already in
// lockupViewModel; the handle shows up in subscriberCountText.
const RESPONSE = {
    contents: {
        twoColumnSearchResultsRenderer: {
            primaryContents: {
                sectionListRenderer: {
                    contents: [
                        {
                            itemSectionRenderer: {
                                contents: [
                                    {
                                        channelRenderer: {
                                            channelId: 'UCbmF2AHnpQsogOLW-MxBiJg',
                                            title: { simpleText: 'Sailing Oceanaire | Wik & Rox' },
                                            subscriberCountText: { simpleText: '@SailingOceanaire' },
                                            videoCountText: { simpleText: '12.900 Abonnenten' },
                                        },
                                    },
                                    {
                                        channelRenderer: {
                                            channelId: 'UCHUCBur3YxKDvWYDFKMPftA',
                                            title: { simpleText: 'Ocean Air Media' },
                                            subscriberCountText: { simpleText: '@oceanairmedia' },
                                        },
                                    },
                                    {
                                        videoRenderer: {
                                            videoId: 'rXAB-SjN_6I',
                                            title: { runs: [{ text: 'Lost in the ' }, { text: 'Ocean Air' }] },
                                            ownerText: { runs: [{ text: 'Somebody' }] },
                                        },
                                    },
                                    {
                                        lockupViewModel: {
                                            contentId: 'PLxLtKEN3sA4OTbjcS6yG-btKQn8hKb3GO',
                                            contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST',
                                            metadata: {
                                                lockupMetadataViewModel: { title: { content: 'Sailing the Seas' } },
                                            },
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            },
        },
    },
};

test('parseSearchResults finds each kind wherever it sits in the tree', () => {
    const channels = parseSearchResults(RESPONSE, 'channel');
    assert.deepEqual(
        channels.map(h => [h.id, h.handle]),
        [
            ['UCbmF2AHnpQsogOLW-MxBiJg', '@SailingOceanaire'],
            ['UCHUCBur3YxKDvWYDFKMPftA', '@oceanairmedia'],
        ],
    );
    const videos = parseSearchResults(RESPONSE, 'video');
    assert.deepEqual(videos, [
        { kind: 'video', id: 'rXAB-SjN_6I', title: 'Lost in the Ocean Air', channel: 'Somebody' },
    ]);
    const playlists = parseSearchResults(RESPONSE, 'playlist');
    assert.deepEqual(
        playlists.map(h => [h.id, h.title]),
        [['PLxLtKEN3sA4OTbjcS6yG-btKQn8hKb3GO', 'Sailing the Seas']],
    );
    assert.deepEqual(parseSearchResults(null, 'video'), []);
});

test('pickBest prefers an exact title or handle, else the first hit', () => {
    const channels = parseSearchResults(RESPONSE, 'channel');
    assert.equal(pickBest(channels, 'Sailing OceanAir').id, 'UCbmF2AHnpQsogOLW-MxBiJg');
    assert.equal(pickBest(channels, 'Ocean Air Media').id, 'UCHUCBur3YxKDvWYDFKMPftA');
    assert.equal(pickBest(channels, 'oceanairmedia').id, 'UCHUCBur3YxKDvWYDFKMPftA');
    assert.equal(pickBest([], 'x'), null);
    // As speech recognition writes it: spaces and a missing letter must not matter.
    assert.equal(pickBest(channels.slice().reverse(), 'Sailing Ocean Air').id, 'UCbmF2AHnpQsogOLW-MxBiJg');
    assert.equal(spokenTitle(channels[0]), 'Sailing Oceanaire');
});

test('searchYouTube posts the filtered query and parses the answer', async () => {
    let sent;
    const fetchFn = async (url, init) => {
        sent = { url, body: JSON.parse(init.body) };
        return { status: 200, json: async () => RESPONSE };
    };
    const hits = await searchYouTube('Sailing OceanAir', 'channel', { language: 'de', fetchFn });
    assert.match(sent.url, /youtubei\/v1\/search/);
    assert.equal(sent.body.query, 'Sailing OceanAir');
    assert.equal(sent.body.params, 'EgIQAg==');
    assert.equal(sent.body.context.client.hl, 'de');
    assert.equal(hits[0].id, 'UCbmF2AHnpQsogOLW-MxBiJg');
    await assert.rejects(
        searchYouTube('x', 'video', { fetchFn: async () => ({ status: 429, json: async () => ({}) }) }),
        /HTTP 429/,
    );
});

test('parseYouTubeCommand: German, English, Russian, with and without a player', () => {
    assert.deepEqual(parseYouTubeCommand('Spiele Channel Sailing OceanAir ab', PLAYERS), {
        kind: 'channel',
        query: 'Sailing OceanAir',
    });
    assert.deepEqual(parseYouTubeCommand('Bitte spiel den Kanal von Sailing OceanAir ab.', PLAYERS), {
        kind: 'channel',
        query: 'Sailing OceanAir',
    });
    assert.deepEqual(parseYouTubeCommand('Spiele den Kanal Sailing OceanAir auf dem Fernseher ab', PLAYERS), {
        kind: 'channel',
        query: 'Sailing OceanAir',
        player: 'Fernseher',
    });
    assert.deepEqual(parseYouTubeCommand('spiel das Video „Lost in the Ocean Air“ im Schlafzimmer', PLAYERS), {
        kind: 'video',
        query: 'Lost in the Ocean Air',
        player: 'Schlafzimmer TV',
    });
    assert.deepEqual(parseYouTubeCommand('Spiele auf YouTube Katzenvideos', PLAYERS), {
        kind: 'auto',
        query: 'Katzenvideos',
    });
    assert.deepEqual(parseYouTubeCommand('spiele Sailing OceanAir auf YouTube ab', PLAYERS), {
        kind: 'auto',
        query: 'Sailing OceanAir',
    });
    assert.deepEqual(parseYouTubeCommand('play the channel Sailing OceanAir on the Schlafzimmer TV', PLAYERS), {
        kind: 'channel',
        query: 'Sailing OceanAir',
        player: 'Schlafzimmer TV',
    });
    assert.deepEqual(parseYouTubeCommand('включи канал Sailing OceanAir', PLAYERS), {
        kind: 'channel',
        query: 'Sailing OceanAir',
    });
    assert.deepEqual(parseYouTubeCommand('Spiele die Playlist Sailing the Seas', PLAYERS), {
        kind: 'playlist',
        query: 'Sailing the Seas',
    });
});

test('similarName / isNamedChannel tolerate what speech recognition does to a name', () => {
    assert.equal(similarName('Sailing Ocean Air', 'Sailing Oceanaire'), true);
    assert.equal(similarName('SailingOceanaire', 'Sailing Oceanaire'), true);
    assert.equal(similarName('Ocean Air Media', 'Sailing Oceanaire'), false);
    assert.equal(similarName('Sailing Kaya', 'Sailing Oceanaire'), false);
    assert.equal(similarName('', 'x'), false);
    const [oceanaire] = parseSearchResults(RESPONSE, 'channel');
    assert.equal(isNamedChannel(oceanaire, 'Sailing Ocean Air'), true);
    assert.equal(isNamedChannel(oceanaire, 'Segeln'), false);
});

test('parseYouTubeCommand takes a place right after the verb as the player', () => {
    // The sentence from the real satellite (2026-10-24), as AWS Transcribe wrote it.
    assert.deepEqual(parseYouTubeCommand('Spiele Im Wohnzimmer. Sailing Ocean Air auf YouTube.', PLAYERS), {
        kind: 'auto',
        query: 'Sailing Ocean Air',
        player: 'Fernseher',
    });
    assert.deepEqual(parseYouTubeCommand('Spiele auf dem Schlafzimmer TV den Kanal Sailing OceanAir', PLAYERS), {
        kind: 'channel',
        query: 'Sailing OceanAir',
        player: 'Schlafzimmer TV',
    });
    assert.deepEqual(parseYouTubeCommand('spiele in der Küche Sailing OceanAir auf YouTube', PLAYERS), {
        kind: 'auto',
        query: 'Sailing OceanAir',
        player: 'Küche',
    });
    assert.deepEqual(parseYouTubeCommand('включи в спальне канал Sailing OceanAir', PLAYERS), {
        kind: 'channel',
        query: 'Sailing OceanAir',
        player: 'спальне',
    });
    // "auf" alone may begin a title, so an unknown word after it stays in the query.
    assert.deepEqual(parseYouTubeCommand('Spiele auf YouTube Auf der Flucht', PLAYERS), {
        kind: 'auto',
        query: 'Auf der Flucht',
    });
});

test('parseYouTubeCommand leaves everything else to the pipeline', () => {
    assert.equal(parseYouTubeCommand('Spiele Musik im Wohnzimmer', PLAYERS), null);
    assert.equal(parseYouTubeCommand('Schalte den Fernseher an', PLAYERS), null);
    assert.equal(parseYouTubeCommand('Was läuft auf YouTube?', PLAYERS), null);
    assert.equal(parseYouTubeCommand('Spiele den Kanal ab', PLAYERS), null);
    assert.equal(parseYouTubeCommand('Spiele das Video nochmal', PLAYERS), null);
    // Without a preposition a room name is part of the channel name, not a player.
    assert.deepEqual(parseYouTubeCommand('Spiele den Kanal Wohnzimmer', PLAYERS), {
        kind: 'channel',
        query: 'Wohnzimmer',
    });
});

test('youtubeReply speaks in the reply language', () => {
    assert.equal(
        youtubeReply('de', 'playing', { kind: 'channel', title: 'Sailing Oceanaire', player: 'Fernseher' }),
        'Ich spiele den Kanal „Sailing Oceanaire“ auf Fernseher.',
    );
    assert.equal(
        youtubeReply('en', 'poweringOn', { kind: 'video', title: 'X', player: 'TV' }),
        'Switching TV on, then playing the video "X".',
    );
    assert.match(youtubeReply('ru', 'notFound', { kind: 'channel', query: 'X' }), /не нашла канал «X»/);
    assert.match(youtubeReply('de', 'unknownPlayer', { query: 'Garage', names: 'A, B' }), /Garage.*A, B/);
});
