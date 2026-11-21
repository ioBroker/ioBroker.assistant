# Shared commands for ioBroker adapters

A catalog of `sendTo` commands that adapters of one kind can share: messengers, speakers, media players, TVs,
screens, cameras, history databases and so on. Each adapter picks the commands that fit it, implements them with the
names, parameters and answers given here and marks them in its `help` answer.

**Why.** Many adapters now answer `help` (contract: `C:\pWork\_help\BRIEF.md`), so an agent (pi-agent, the MCP
server) can find out what any adapter can do. But it still reads every help text and works out the names of each
adapter. When all players answer `play {uri, device}` and all cameras `snapshot {camera}`:

- ioBroker.assistant can do "play X on Y" or "show the door camera on the TV" by itself, without the cloud LLM, for
  every adapter of that kind — today it does that for one adapter at a time (`src/lib/music.ts` for Spotify,
  `src/lib/youtube.ts`, `src/lib/home3d.ts`);
- pi-agent, which reads the help texts, can treat all adapters of one kind alike instead of one way per adapter;
- scripts and agents work with a new adapter without learning it;
- the output of one adapter is the input of another: a picture from `camera.snapshot` or echarts goes straight into
  `message.send {file}` of a messenger or `screen.show {image}` of a display.

**Status:** proposal of 2026-11-21. "Existing" comes from two sources: the help texts of the adapters
(`C:\pWork\_help\ioBroker.*`, most of them not released yet: they wait for js-controller PR #3638) and the message
handlers of 103 adapters, read on GitHub (default branch) on 2026-11-21. These 103 were chosen after a scan of all 861
adapters of the repository, of which 387 accept messages. "Candidates" are adapters that could implement a command,
chosen by what they do; their code was not checked, unless the adapter is also listed under "Existing" somewhere.

**Legend**

- ✅ the adapter has the command with this name and these parameters (small differences in brackets).
- ≈ it does the same under another name or with other parameters (named in brackets). The cheap step: add the
  standard name as an alias that maps the parameters.
- 🔸 only through states, without an answer (the state is named).
- `[{value, label}]`: a list made for a select of the admin.

---

## Rules for all commands

1. **Names** exactly as here (camelCase). An adapter that already has such a command under another name keeps it and
   adds the standard name as an alias. The alias takes the parameters and gives the answer of this catalog; the old
   name keeps its own answer for old scripts.
2. **Mark it in `help`.** In the `commands` list of the help answer, a command that follows this catalog gets
   `standard: "<family>.<command>"`, e.g. `{command: 'snapshot', write: false, standard: 'camera.snapshot'}`.
   A client finds every instance that can do something by asking `help` of all instances with
   `common.supportedMessages.help` and filtering by `standard`. The family is needed because the same name means
   different things: `getEvents` of a calendar is not `getEvents` of a camera. Everything else stays as in BRIEF.md.
3. **Parameters**: the names given here (`?` = optional). Extra parameters of the adapter are fine; unknown ones are
   ignored, not refused.
4. **Answers**: success = an object without `error` (not `error: null` or `error: false`). Failure =
   `{error: "<text for a human>", reason?: "<CODE>"}` — not `err` or `error_message`, and not an `Error` object (it
   arrives as `{}` after JSON). Common codes: `NOT_CONNECTED` (device or service offline), `NOT_FOUND` (unknown device
   or item; add `candidates: [names]`), `AMBIGUOUS` (the name fits several; `candidates`), `NOT_SUPPORTED` (this device
   cannot do it, or an unknown command), `NOT_ALLOWED` (the settings forbid it), `BAD_REQUEST` (a parameter is missing
   or wrong), `TIMEOUT`, plus codes of the adapter. Every message with a callback gets an answer, also on errors and
   for unknown commands — without one, the caller waits for its whole timeout. A command with an effect also runs
   when the caller gives no callback.
5. **Devices and places**: `device` (or `camera`, `screen`, `lock` …) = the ID the adapter uses or the name the user
   gives it, compared without case; an exact name wins over a partial one; several fit → `AMBIGUOUS`. `room` = an
   ioBroker room (`enum.rooms.kitchen`) or its name. Lists answer `{<things>: [{id, name, room?, …}]}`.
6. **Times**: `start`, `end`, `at` as ms since 1970 or ISO 8601 text (without a zone = local time of the host);
   durations in `seconds`. Times in answers: ms since 1970.
7. **Pictures and files**: an answer carries `{data, contentType}`, `data` = base64 without a `data:` prefix (as
   frigate does; echarts answers a data URL instead). Not a Node.js Buffer (it arrives as `{type: 'Buffer', data:
[bytes]}`) and not a path on the disk of the host (the caller may run on another host). The option `fileName` also
   stores the file in the files of the adapter and answers `file: "<adapter>.<n>/<path>"`, which a messenger sends as
   `iobfile://<file>`. Videos only as `file`, never as data on the message bus. A parameter that takes a picture or a
   file (`image`, `file`) accepts a data URL, base64 with `contentType`, an `iobfile://` path or an http(s) URL.
8. **Language**: texts the adapter makes (descriptions, spoken texts) in `language?` (ISO 639-1), default the system
   language.
9. **Answer when it is done or refused, not when it is sent**: `play` answers when the device plays, `show` when the
   screen shows it. If that takes longer than about 15 s, answer `{ok: true, pending: true}` and finish in the
   background.
10. **States are enough** where an adapter has one state per value with a role of the type-detector (`media.play`,
    `level.volume`, `switch.lock` …): the assistant and the MCP server find and write those by themselves. A command
    is for what a state cannot do: search, lists, parameters, several values at once, an answer whether it worked.
11. **`write: true`** for every command with an effect. Commands that reach other people (send, call), open doors or
    delete need the user's explicit request: say so in "How to talk to the user" of the help text.

---

## Overview

| Family                                                | Commands                                                                                                             | Existing (✅ / ≈)                                                                                                                                                                        | Candidates                                                                                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [message](#message--messengers)                       | send, ask, getRecipients, edit, delete                                                                               | telegram, email, pushover, gotify, signal-cmb, whatsapp-cmb, matrix-org, max, discord, ntfy-client, pushsafer, sevenio, gsmsms, pushbullet, telegrammenu2, notification-manager, lupusec | synochat, alexa2                                                                                                                  |
| [speech](#speech--speakers-and-voice-assistants)      | speak, playSound, ask, synthesize                                                                                    | sayit, hannah, assistant, sonos, alexa2, heos, mpd, awtrix-light, awtrix-ng, assistant-satellite, cloud                                                                                  | alexa2, sonos, chromecast, music-assistant, squeezeboxrpc, wallpanel                                                              |
| [media](#media--music-and-video)                      | getPlayers, search, getMedia, play, nowPlaying                                                                       | spotify-premium, music-assistant, sonos, squeezeboxrpc, plex                                                                                                                             | youtube-remote, chromecast, kodi, emby, jellyfin, heos, musiccast, mpd, synology                                                  |
| [tv](#tv--tvs-set-top-boxes-sticks)                   | getApps, launchApp, getChannels, setChannel, getInputs, setInput, remote, power                                      | samsung_tizen, sony-bravia, panasonic-viera, samsung-mdc                                                                                                                                 | lgtv, androidtv, firetv, philips-tv, enigma2, harmony, playstation, pjlink                                                        |
| [screen](#screen--dashboards-displays-tvs-as-screens) | getScreens, show, ask, hide, screenshot                                                                              | aura, vis-2 🔸, home3d 🔸, awtrix-light, awtrix-ng, lametric, satellite-display, iqontrol, nspanel-lovelace-ui, lovelace, kodi, emby, jellyfin, enigma2, puppeteer, phantomjs            | satellite-display, vis-2, home3d, chromecast, androidtv, firetv, lgtv, fullybrowser, lovelace, jarvis, webui, wallpanel           |
| [camera](#camera)                                     | getCameras, snapshot, getStreamUrl, getEvents, identify, getPresets, gotoPreset, pauseNotifications, record, getClip | cameras, frigate, onvif, synology, agent-dvr, cam-recorder, bosch-smart-home-camera, reolink, unifi-protect, eusec                                                                       | ring, tapo, netatmo, doorbird, motioneye, face                                                                                    |
| [history](#history--history-databases)                | aggregate, lastChange, getEvents (+ getHistory)                                                                      | sql, recorder, history, influxdb, victoriametrics, homee, echarts, eventlist                                                                                                             | history, influxdb, sql, recorder, victoriametrics, eventlist                                                                      |
| [calendar](#calendar--calendars-and-days)             | addEvent, getEvents, …, isHoliday, getPickups                                                                        | fullcalendar, webcal, icloud                                                                                                                                                             | ical, feiertage, trashschedule                                                                                                    |
| [energy](#energy)                                     | getForecast, getPrices, cheapest, getEnergy, chargePlan, batteryMode                                                 | sourceanalytix                                                                                                                                                                           | pvforecast, solarwetter, tibberlink, awattar, corrently, evcc, easee, tesla-motors, sun2000, statistics                           |
| [vehicle](#vehicle--cars-and-wallboxes)               | getVehicles, getStatus, lock, climate, charge, setChargeLimit, setChargeCurrent, signal, refresh                     | volvo; tesla-motors 🔸, porsche 🔸, renault 🔸, easee 🔸                                                                                                                                 | tesla-motors, volvo, porsche, renault, easee, vw-connect                                                                          |
| [weather](#weather)                                   | getForecast, getWarnings                                                                                             | —                                                                                                                                                                                        | open-meteo-weather, brightsky, openweathermap, accuweather, daswetter, dwd, nina                                                  |
| [presence](#presence--people)                         | getPersons, getLocation                                                                                              | tr-064, teltonika, icloud                                                                                                                                                                | unifi-network, ping, residents, geofency, life360ng, traccar, fb-checkpresence, google-sharedlocations2, espresense, tractive-gps |
| [network](#network)                                   | getClients, guestWifi, wake, ping                                                                                    | tr-064, unifi-network, net-tools, ping, fb-checkpresence                                                                                                                                 | mikrotik, unifi-network, teltonika                                                                                                |
| [robot](#robot--vacuums-and-mowers)                   | getRobots, getRooms, clean, pause, stop, home, getStatus                                                             | mihome-vacuum, roborock, roomba                                                                                                                                                          | dreame, valetudo, ecovacs-deebot, worx, sunseeker                                                                                 |
| [access](#access--locks-and-codes)                    | createCode, getCodes, updateCode, deleteCode, getAccessLog                                                           | tedee, wiegand-tcpip                                                                                                                                                                     | nuki-extended, ekey                                                                                                               |
| [alarm](#alarm--alarm-panels)                         | getStatus, arm, disarm                                                                                               | lupusec 🔸                                                                                                                                                                               | lupusec                                                                                                                           |
| [list](#list--shopping-and-to-do-lists)               | getLists, getItems, addItem, updateItem, completeItem, removeItem                                                    | shoppingroute, icloud, kanban                                                                                                                                                            | bring, todoist2, alexa2, kitchenowl, alexa-shoppinglist                                                                           |
| [device](#device--pairing-and-maintenance)            | startPairing, renameDevice, identify, removeDevice, getGroups, getUpdates, installUpdate, startBackup, getBackups    | zigbee, tr-064, assistant, aura, backitup, deconz, homekit-controller, tradfri, growatt                                                                                                  | zigbee2mqtt, hue, hm-rpc, zwave2, matter, shelly, esphome                                                                         |
| [docs](#docs--documents-and-mail)                     | searchDocuments, getDocument, getMails                                                                               | paperless-ngx, imap, icloud                                                                                                                                                              | paperless-ngx, imap                                                                                                               |
| [phone](#phone--calls)                                | call, hangup, getCalls                                                                                               | asterisk-docker, telegram, sevenio                                                                                                                                                       | tr-064                                                                                                                            |

At the end: [more family proposals](#more-family-proposals), [ideas for single adapters](#ideas-for-single-adapters)
and [how ioBroker.assistant uses the catalog](#how-iobrokerassistant-uses-the-catalog).

---

## message — messengers

### `message.send {text, recipient?, title?, file?, files?, priority?}` — write

Sends a message. `recipient`: an id or name from `getRecipients` (a user, chat or group), default the one of the
settings. `file`/`files`: pictures or files (rule 7), e.g. a chart from echarts or a camera snapshot.
Answer `{ok: true, sent: <number of recipients>, id?}` — `id` of the message where the messenger has one, for `edit`
and `delete`.

Existing (they differ mostly in the names of text and recipient — `text` and `recipient` as aliases are enough):

- telegram `send {text, user?, chatId?, …}` ✅ (recipient = `user` / `chatId`; files as `iobfile://` text)
- matrix-org `send` text or `{text}` ✅
- max `send {userId? | chatId?, text?, image?, video?, audio?, file?}` ≈
- email `send {to?, subject?, text?, html?, attachments?}` ≈
- pushover `send {message, title?, priority?, device?, …}` ≈, gotify `send {message, title?, priority?}` ≈
- signal-cmb, whatsapp-cmb `send {text, phone?}` ≈
- discord `send {content, userId? | userTag? | userName? | serverId + channelId}` ≈ (no default recipient; files in
  `content.files` as path or URL; answers `{result, messageId}`)
- ntfy-client `send {message, topic?, title?, priority?, attach?, attach_file?}` ≈ (`attach_file` = a path on the
  host; answers the ntfy message with its `id`)
- pushsafer `send {message, title?, device?, priority?, picture?}` ≈ (answers `{}`)
- sevenio `send {to, text, from?}` ≈ (SMS; `to` = a number or a contact name; answers the raw seven.io result)
- gsmsms `send {recipient, text}` ≈ (SMS; never answers), pushbullet any command `{message, title?, receiver?, file?}`
  ≈ (never answers)
- lupusec `sms {number, text}`, `smsgw` ≈ (SMS through the alarm panel; echoes the message)
- telegrammenu2 `send {text, chatId? | user?}` ≈ (through telegram), `notify {area, type, text, file?}` ≈ (to the users
  who subscribed the area)
- notification-manager `registerUserNotification {category, message}` ≈ (to the messengers set for that severity; no
  recipient)
- 🔸 discord `servers.<id>.channels.<id>.send` / `users.<id>.send` and `….sendFile`; synochat `<channel>.message` (its
  command posts only to channels that take all messages and never answers); alexa2 `Contacts.<id>.textMessage`,
  `Commands.notification` (to the Alexa app)

notification-manager finds messengers by `common.supportedMessages.notifications` and sends them `sendNotification`:
a messenger with `message.send` should answer that too. Not messengers: gotify-ws (forwards Gotify messages to one
messenger) and telegram-menu (builds menus and sends them through telegram); neither registers a message handler.

Candidates: synochat (send to a channel, with an answer), alexa2 (contacts).

### `message.ask {text, answers?, recipient?, timeoutSec?}` — write

Sends a question and waits for the answer. `answers`: texts for buttons (if the messenger has them); without them
the answer is free text. Answer `{answer: "<text>", index?: <button, 0-based>, from?}` or `{timeout: true}`.
The `sendTo` of the caller must wait longer than `timeoutSec` (default 60).

Existing:

- telegram `ask {text, user?, chatId?, reply_markup?}` ≈ (answers the Telegram message or callback query,
  `"__timeout__"`)
- max `ask {userId | chatId, text, answers, timeout?}` ≈ (answers `{data: index as text, text, …}`,
  `{timeout: true}`)
- discord `awaitMessageReaction {messageId, timeout}` ≈ (emoji reactions on a message sent before; ms, at most 60 s;
  time up = empty `reactions`)
- telegrammenu2 `awaitReply {user, scriptId, cmd, text?}` ≈ (answers `{ok}` at once; the reply goes to a script)

Candidates: matrix-org, discord (text answers), ntfy-client (action buttons and a reply topic), sevenio and gsmsms
(incoming SMS), synochat. (signal-cmb and whatsapp-cmb send through CallMeBot and cannot receive; pushsafer lets the
user reply, but the adapter does not read replies.)

### `message.getRecipients {}` — read

Answer `{recipients: [{id, name, kind: 'user' | 'group' | 'chat', default?: true}]}`. With it "write Anna that I come
later" finds Anna's chat without guessing.

Existing:

- discord `getNotificationTargets` ≈ (`[{label, value}]` for the admin; a channel is `serverId/channelId`)
- sevenio `get_contacts` ≈ (the raw seven.io contacts; `send {to}` takes their names)

Candidates: telegram, max, matrix-org, pushover (devices), email (addresses of the settings), signal-cmb and
whatsapp-cmb (numbers of the settings), ntfy-client (topics of the settings), pushsafer (devices and groups of the
key), pushbullet (devices of the account), telegrammenu2 (users), synochat (channels), alexa2 (contacts).

### `message.edit {id, text, recipient?}` / `message.delete {id, recipient?}` — write

Changes or removes a message sent before; `id` from the answer of `send`. For a message that changes later ("the front
door is open" → removed when it is closed again).

Existing: discord `editMessage {messageId, content, …}` ≈ and `deleteMessage {messageId, …}` ≈ (`send` answers
`messageId`); ntfy-client `delete {sequence_id, topic?}` ≈, `clear` (marks it as read on all clients) (`send` answers
`id`).
Candidates: telegram.

---

## speech — speakers and voice assistants

### `speech.speak {text, device?, room?, volume?, language?, priority?}` — write

Says the text. `priority: true` = before queued texts and also in do-not-disturb (alarms). Without `device`/`room`:
everywhere the adapter speaks. Answer `{ok: true, devices: [names]}` when handed over, or `{error}`.

Existing:

- sayit `say {text, language?, volume?, <device>?, …}` ≈
- hannah `announce {text, room?, rooms?, person?}` ≈ (`person` = a resident)
- assistant `notify {text, severity, target | room}` ≈ (`severity: 'alert'` = priority)
- alexa2 `sendSequenceCommand {deviceSerialNumber, sequenceNodes: [{command: 'speak' | 'announcement', value}]}` ≈
  (answers when Amazon took the sequence; volume as an extra node); 🔸 `Commands.speak` (`[volume;]text`),
  `Commands.announcement`, `Commands.ssml`
- awtrix-ng `audio {speech}` ≈ (only devices that can speak)
- wallpanel 🔸 `<tablet>.command.speak`

Candidates: alexa2 (as a command with an answer, with the volume and splitting of `Commands.speak`), sonos (today text
only through sayit), chromecast, music-assistant (the server has announcements, the adapter not yet), squeezeboxrpc,
wallpanel.

### `speech.playSound {url | file, device?, room?, volume?}` — write

Plays a short sound or speech file over what plays and then lets that go on (door bell, gong).
Answer `{ok: true}` when played.

Existing:

- sonos `send "[volume;]<URL or file>"` ≈ (all speakers at once)
- heos `send "[volume;]<URL>"` ≈ (all group leaders; answers at once); 🔸 `players.<pid>.tts`
- mpd `say "[volume;]<file or URL>"` ≈ (never answers); 🔸 `say`
- sayit `say` with a .mp3/.wav/.ogg name ≈
- awtrix-light `sound {sound}`, `rtttl` ≈ (melodies of the device); awtrix-ng `audio {file | rtttl | song | station}`
  ≈ (`file` = a stored name or a URL)
- assistant `playSound` ≈ (on its satellites); assistant-satellite `announce {audio, sampleRate?}` ≈ (raw PCM, sent by
  the assistant)
- 🔸 chromecast `player.announcement` (acknowledged when played); squeezeboxrpc `Players.<name>.Announce` (URL or
  file, then the queue goes on); alexa2 `Commands.sound` (Amazon sound ids only); vis-2 `control.command` `playSound`;
  webui `control.command` `uiPlaySound`; wallpanel `command.urlAudio`

sonos, heos and mpd take the sayit protocol (`"[volume;]<url>"` as a text): an alias `playSound {url | file, volume?}`
is a small step.

Candidates: alexa2, music-assistant, squeezeboxrpc (the Announce code is there), sonos (per speaker),
assistant-satellite (url or file), lametric (today only `soundUrl` inside a notification), wallpanel.

### `speech.ask {text, device?, room?, timeoutSec?}` — write

Speaks a question and listens for the spoken answer: `{answer}` or `{timeout: true}`.

Existing: assistant `askUser {question, room | target | source, timeoutMs}` ≈, hannah `ask {text, room?}` ≈.
Candidates: every voice adapter that can listen after speaking.

### `speech.synthesize {text, language?, voice?}` — read

Turns text into audio without playing it: `{data, contentType}` (rule 7). Then a speaker that plays a URL or file
(`speech.playSound`) can speak with any engine, and a messenger can send the audio.

Existing: cloud `tts {text, textType?, voiceId?}` ≈ (Amazon Polly through the ioBroker cloud; answers `{base64}` of an
MP3; sayit uses it as its engine "cloud"), assistant `tts {text, language?}` ≈ (answers
`{audio, mime: 'audio/wav', sampleRate}`).
Candidates: sayit (its engines).

---

## media — music and video

Pause, next, volume and mute need no command: states with the roles `media.play`, `media.pause`, `media.next`,
`media.prev`, `level.volume`, `media.mute` are enough (rule 10).

kodi, heos and musiccast have a `send`, but none of them is a raw command: kodi shows a notification
(`screen.show`), heos plays a sound (`speech.playSound`), and in musiccast it is a stub without effect.

### `media.getPlayers {}` — read

Answer `{players: [{id, name, room?, active?, kinds?: ['audio', 'video']}]}`.

Existing:

- spotify-premium `getDevices` ≈ (`{devices: [{id, name, type, isActive, …}]}`)
- music-assistant `getPlayers` ≈ (`[{value, label}]`; `value` = the ioBroker channel, not the player id)
- sonos `sonos:getRooms` ≈ (`[{value, label}]`)
- squeezeboxrpc `getPlayerNames` ≈ (`[names]`; without the player MAC that `cmdGeneral` needs)
- plex `listKnownPlayers` ≈ (`{result, players: [{id, uuid, title, …}]}`, also players not seen for long)
- 🔸 chromecast, youtube-remote (one device object per player); synology `AudioStation.players.<id>`

Candidates: chromecast, youtube-remote, kodi, emby, jellyfin, alexa2, heos, musiccast, bose-soundtouch, synology.

### `media.search {query?, type?, title?, artist?, album?, limit?, offset?}` — read

Searches the catalog of the service. `type`: `track` (default), `album`, `artist`, `playlist`, `radio`, `podcast`,
`episode`, `audiobook`, `video`, `channel`, `movie`, `series` — several comma separated, as far as the service has
them. Answer `{items: [{type, uri, name, artists?, album?, durationSec?, image?}]}`, the best match first; `uri` goes
to `play`.

Existing:

- spotify-premium `search` ✅ (also `track`, `year`, `genre`; `durationMs`)
- music-assistant `getMedia {list, search?}` ≈ (filters one list of the library by name); 🔸
  `players.<id>.playMedia` takes a search text (`artist:`, `album:` …) and plays the best hit
- squeezeboxrpc `cmdGeneral {playerid, cmdArray}` ≈ (the raw LMS CLI, `search …`)
- jellyfin 🔸 `<device>.command.playTitle` searches the server and plays the best hit
- assistant: searches YouTube itself (InnerTube, `src/lib/youtube.ts`), not as a command

Candidates: youtube-remote (the search would move from the assistant there), music-assistant (the search of its
`playMedia` state as a command), jellyfin (the search behind `playTitle`), plex, emby, kodi, squeezeboxrpc, heos,
synology (AudioStation), mpd (its `search` state keeps no result), sonos (favorites, playlists), an internet radio
adapter (radio-browser.info), podcasts (Podcast Index, iTunes).

### `media.getMedia {list, search?, limit?, offset?}` — read

The user's own collection. `list`: `favorites`, `playlists`, `albums`, `artists`, `tracks`, `radios`, `podcasts`,
`audiobooks`, `recent`, `continue` (started films and series). Answer as `search`.

Existing: music-assistant `getMedia` ✅ (`subtitle` instead of `artists`/`album`; no `recent`, `continue`);
spotify-premium `getPlaylists {search?}` ≈ (only playlists). 🔸 a folder written into a state, the listing written
back: mpd `lsinfo`, kodi `Directory`, heos `sources.<sid>.browse`, synology `AudioStation.players.<id>.Browser`; lists
as states: squeezeboxrpc `Favorites.*`, musiccast `netusb.preset_info`, synology `favoriteRadio`, mpd `listplaylists`.
Candidates: sonos (favorites), squeezeboxrpc, plex, emby, jellyfin (`continue`), kodi, heos, musiccast, mpd, synology,
spotify-premium (alias).

### `media.play {uri?, device?, offset?, positionSec?, shuffle?}` — write

Plays `uri` (from `search`/`getMedia`, or an ID or URL the service knows) on `device`; without `uri` it resumes.
Answers when the device plays: `{ok: true, device: {id, name}}`, or `{error, reason}` with e.g. `NO_ACTIVE_DEVICE`,
`DEVICE_NOT_FOUND` (with `devices`), `DEVICE_NOT_CONTROLLABLE`, `PREMIUM_REQUIRED`.

Existing:

- spotify-premium `play {uri, offset, positionMs, device}` ✅ (`positionMs`)
- squeezeboxrpc `cmdGeneral` ≈ (raw LMS command); 🔸 `Players.<name>.cmdPlayUrl`, `cmdPlayFavorite`
- assistant `playMusic`, `playYouTube` ≈ (they route to the adapters above)
- 🔸 music-assistant `players.<player>.playMedia` (a URI or a search text); chromecast `player.url2play` (acknowledged
  when loaded); youtube-remote `<device>.youtube` (acknowledged when the TV took it); jellyfin `command.playTitle` (a
  title or an item id); plex `_Controls.playback.playKey` (`{key, offset}`); kodi `open`, `add`, `youtube`; heos
  `players.<pid>.command` (`play_stream?url=…`); mpd `addplay`; musiccast `netusb.presetrecallnumber`; synology
  `AudioStation.players.<id>.play_track`, `play_folder`; dune-hd-remote `media.playUrl`; lgtv `states.youtube`

Candidates: music-assistant, chromecast, youtube-remote, sonos, squeezeboxrpc, kodi, plex, emby (nothing can start an
item yet), jellyfin, alexa2, heos, mpd.

### `media.nowPlaying {device?}` — read, optional

Answer `{device, state: 'playing' | 'paused' | 'stopped', title?, artist?, album?, positionSec?, durationSec?, image?,
volume?}`. Only worth it where the values are spread over many states without roles; otherwise the states do.

Existing: all 🔸 (`player.*`, `metadata.*` …; androidtv `media.*` over ADB).
Candidates: plex, emby, jellyfin, kodi, squeezeboxrpc, music-assistant.

---

## tv — TVs, set-top boxes, sticks

A TV that can show a picture or a web page also implements `screen.show` (see
[screen](#screen--dashboards-displays-tvs-as-screens)). sony-bravia, panasonic-viera and lgtv also have the channel
`tv` of the type-detector (`tv.power`, `tv.key`, `tv.app`, `tv.input`, volume): by rule 10 that is enough to switch
them and press keys.

### `tv.getApps {}` / `tv.launchApp {app, device?}` — read / write

`getApps` answers `{apps: [{id, name}]}`.

Existing:

- samsung_tizen `apps {refresh?}` ≈ (`{apps: [{key, name}]}`), `launchApp {app}` ✅
- sony-bravia `remoteInfo` ≈ (`{apps, inputs}`; `id` = the ioBroker object id), `launchApp {id}` ≈ (an id from
  `remoteInfo`)
- panasonic-viera `launchApp {app}` ✅ (`app` = a key of the type-detector `TV_APPS`, e.g. `NETFLIX`)
- 🔸 androidtv `<device>.launchApp` (a deep link or, over ADB, a package); philips-tv `settings.launchApp` and lgtv
  `states.launch` (the app list is in `common.states`); firetv `<device>.startApp` (a package); harmony
  `<hub>.activities.<activity>`; playstation `remote.startGame` (a title id)

Candidates: lgtv, androidtv, firetv (`pm list packages`), philips-tv, panasonic-viera (`getApps`), harmony
(activities), playstation (the games of the PSN account).

### `tv.getChannels {device?}` / `tv.setChannel {channel, device?}` — read / write

`getChannels` answers `{channels: [{id, name, number?}]}`; `channel` = a name, a number or an id. Together with
tvprogram: "what is on tonight? — switch to it". The names should match the channels of tvprogram, or the adapter
compares them loosely ("ZDF HD" = "ZDF").

Existing: none as a command. tvprogram `getServerData {dataname: 'channels'}` lists the channels of the programme guide
and `getServerBroadcastNow`/`getServerBroadcastFind` what runs — the other half of the scenario. 🔸 philips-tv
`settings.launchTvChannel` (a name; the list in `common.states`), lgtv `states.channel` (a number), kodi `SwitchPVR`
(the start of the name; the list in `pvr.playlist_tv`), enigma2 `command.ZAP` (a service reference).
Candidates: enigma2 (it loads the channel list already, for the picons), lgtv (`getChannelList`), philips-tv (the list
is in memory), samsung_tizen (by number through the digit keys), androidtv, firetv, harmony, kodi (PVR), sony-bravia.

### `tv.getInputs {device?}` / `tv.setInput {input, device?}` — read / write

`getInputs` answers `{inputs: [{id, name}]}`; `input` = a name or an id. Ids preferably the keys of the type-detector
`TV_INPUTS` (`TV`, `HDMI1` …). "Switch the TV to the PlayStation."

Existing: sony-bravia `remoteInfo` ≈ (the inputs next to the apps), `input {id}` ≈; samsung-mdc
`input {device?, value}` ≈ (an MDC source code); 🔸 `tv.input` of sony-bravia, panasonic-viera and lgtv, philips-tv
`settings.hdmiInput`, lgtv `states.input` (the list in `common.states`).
Candidates: pjlink (projectors), lgtv, philips-tv, panasonic-viera, sony-bravia (aliases).

### `tv.remote {key, device?}` / `tv.power {on, device?}` — write

`key`: `up`, `down`, `left`, `right`, `ok`, `back`, `home`, `menu`, `play`, `pause`, `volumeUp`, `volumeDown`, `mute`,
`channelUp`, `channelDown`, `0`–`9`; the adapter maps them to its own codes (and may take its own codes too).

Existing:

- samsung_tizen `remote {key}` ✅ (Samsung codes `KEY_…`), `wake {mac?}` ≈ (only on)
- sony-bravia `remote {key}` ≈ (Sony IRCC names only), `power {on}` ✅ (answers `{result: 'ok'}`)
- panasonic-viera `remote {key}` ≈ (Panasonic NRC codes only)
- samsung-mdc `power {device?, value}` ≈ (signage displays)
- 🔸 keys: androidtv `keys.<key>` (nearly the standard names) and `sendKey`, philips-tv `keys.<name>`, lgtv
  `remote.<key>`, firetv `keys.<key>`, enigma2 `command.<KEY>`, harmony `<hub>.<device>.<command>`, playstation
  `remote.*`, lgtv11 one state per key, dune-hd-remote `navigation.*`, kodi `input.*`, plex
  `_Controls.navigation.*`, emby `command.goHome` …
- 🔸 power: androidtv, philips-tv and lgtv `power` (on by Wake-on-LAN), firetv `on`, enigma2 `main_command.STANDBY` …,
  playstation `remote.wakeup`/`standby`, harmony `activities.currentStatus` (off only), dune-hd-remote `control.power`
  (a toggle), lgtv11 `turnOff` (off only)

Candidates: lgtv, androidtv, firetv, enigma2, harmony, philips-tv, samsung-mdc (`remote`), pjlink (`power`),
sony-bravia and panasonic-viera (the standard key names: they map them already for `tv.key`).

---

## screen — dashboards, displays, TVs as screens

### `screen.getScreens {}` — read

Answer `{screens: [{id, name, room?, kinds: ['image', 'url', 'camera', 'chart', 'text', 'view', 'place', 'qr'],
views?: [names]}]}` — the kinds of `show` this screen can do, and the values for `show {kind: 'view'}`.

Existing:

- satellite-display `getTiles` ≈ (lists the displays and their pages); vis-2: its help text lists the open browsers ≈;
  home3d 🔸 `places` (what a 3D view can fly to)
- nspanel-lovelace-ui `getPanels` ≈ (`{result: [{panelTopic, friendlyName}]}`), `getPagesForPanel {panelTopic}` ≈ (its
  views)
- 🔸 one object per browser: lovelace `instances.<browserId>.*` (random ids), jarvis `clients.<ns>.*`, webui
  `control.command` `uiConnected` (the only way to learn the client ids)

Candidates: every adapter that implements `show`.

### `screen.show {screen?, room?, kind, …, seconds?, title?}` — write

Shows something **for a while without saving it**, over what the screen shows, then goes back. `kind` and its fields:

| kind     | fields                                              | e.g.                                                       |
| -------- | --------------------------------------------------- | ---------------------------------------------------------- |
| `image`  | `image` (rule 7)                                    | a chart of echarts, a camera snapshot                      |
| `url`    | `url`                                               | a web page, an MJPEG or HLS stream                         |
| `camera` | `camera`, `instance?` (e.g. `cameras.0`)            | the live picture, fetched by the screen                    |
| `chart`  | `ids`, `start`, `end` or `preset` (echarts)         | "show the temperature of yesterday on the kitchen display" |
| `text`   | `text`, `icon?`, `severity?` (info, warning, alert) | a message                                                  |
| `view`   | `view`                                              | a vis view, an Aura view, a page of satellite-display      |
| `place`  | `place`                                             | a floor, room or device in home3d                          |
| `qr`     | `text`                                              | the guest WLAN                                             |

`seconds`: how long (default about 30; 0 = until `hide`). Answer `{ok: true, id, screens: [names]}` when shown;
`NOT_SUPPORTED` for a kind the screen cannot do.

Existing:

- aura `notify {title?, text?, html?, image?, view?, severity?, durationSec?, target?, …}` ≈ — the closest: an
  overlay with picture, text or view, `{ok, id}`
- vis-2 🔸 `control.command` with `changeView`, `alert`, `dialog`, `popup` (a JSON text with `instance` = browser)
- home3d 🔸 `show` = a place (acknowledged when the 3D views flew there)
- awtrix-light `notification {text, icon?, duration?, …}` ≈; awtrix-ng `notification {text?, icon?, durationMs?,
hold?, barChart?, lineChart?, …}` ≈ (text, and charts of numbers); lametric `notification {text, icon?, …}` ≈ (text
  and chart frames of numbers; answers the object of the device with its `id`)
- iqontrol `send {PopupMessage, PopupDuration?, PopupButtonNames?, …}` ≈ (text or HTML on all open frontends; ms,
  default until confirmed; answers 'Message received')
- nspanel-lovelace-ui `setPopupNotification {headline, text, panel?, …}` ≈ (until dismissed; answers `[]`),
  `screensaverNotify {panel, heading?, text?, enabled}` ≈ (text on the screensaver)
- emby `message {text, header?, timeoutMs?, device?}` ≈ (answers `{result, sent: [devices]}`); jellyfin `message` ≈
  (the same fields; answers `{sent, errors}`)
- kodi `send {message, title?, image?, delay?}` ≈ (a Kodi notification; `delay` in ms; answers at once)
- enigma2 `send {message, msgType, timeout}` ≈ (text on the screen of the receiver; `timeout` in s; never answers)
- lovelace `send {message, title?}` ≈ (a lasting notification in the drawer of the Home Assistant frontend, not an
  overlay; answers nothing)
- satellite-display `addTile` — saves the tile and restarts the adapter: right for a lasting tile, not for a short look
- 🔸 lovelace `instances.<browserId>.toast` (text), `.popup` (any card: picture, iframe, camera), `.path` (a view,
  lasting); lgtv `states.openURL` (url), `states.popup` (text); wallpanel `command.url` (url, lasting); jarvis
  `addNotification` (text), `clients.<ns>.setTabId` (view); webui `control.command` `uiChangeView`, `uiAlert`;
  nspanel-lovelace-ui `cmd.goToNavigationPoint` (view); lametric and awtrix-ng `apps.<app>.activate` (view);
  dune-hd-remote `notify.send` (text, with a plugin on the player)

Candidates: satellite-display (an overlay without saving: camera, image, chart, text, qr), vis-2 (as a command with
an answer), aura (alias of `notify`), home3d (as a command, and highlighting devices by their state: "where are
windows open?"), chromecast (a picture or stream URL on the TV), androidtv (a URL over ADB; a deep link is not
reliable), firetv (a URL through `am start … VIEW`), samsung_tizen, lgtv (url and text as a command), sony-bravia (a
URL through its web app runtime), fullybrowser (load a URL), nspanel-lovelace-ui and iqontrol (aliases), lovelace
(toast, popup with a card, path), jarvis, webui, wallpanel, awtrix-light, awtrix-ng and lametric (`text` only).

### `screen.ask {text, answers, screen?, timeoutSec?}` — write

Shows a question with buttons and waits for the tap: `{answer, index?}` or `{timeout: true}`, like `message.ask` and
`speech.ask`. "Turn off the lights downstairs? — Yes / No".

Existing:

- nspanel-lovelace-ui `setPopupNotification` with `buttonLeft`, `buttonMid`, `buttonRight` ≈ (the tap lands in the
  states `cmd.NotificationCustom*`; answers `[]` at once)
- enigma2 `send {msgType: 0}` ≈ (a yes/no question on the receiver; the answer lands in `MESSAGE_ANSWER`; never
  answers)
- 🔸 iqontrol `Popup.ButtonNames` with `Popup.BUTTON_CLICKED`; lovelace a browser_mod `popup` with buttons

Candidates: iqontrol, nspanel-lovelace-ui, lovelace, enigma2, vis-2 (`dialog`), aura, awtrix-ng (`hold` and a button
of the device).

### `screen.hide {screen?, id?}` — write

Ends a `show` before its time.

Existing: aura `notifyDismiss {id}` ≈, nspanel-lovelace-ui `screensaverNotify {enabled: false}` ≈; 🔸 vis-2
`dialogClose`, iqontrol `Popup.PERSISTENT_MESSAGES_DELETE_ID`, lovelace `instances.<id>.popup_close` and
`notifications.clear`, awtrix-ng `notification.dismiss`, dune-hd-remote `notify.hide`.
Candidates: lametric (by the `id` its answer carries), awtrix-ng (as a command), nspanel-lovelace-ui (a popup by its
`id`), iqontrol.

### `screen.screenshot {url, width?, height?, fullPage?, waitMs?, waitForSelector?, type?, fileName?}` — read

A picture of a web page (a vis view, a dashboard): `{data, contentType, file?}` (rule 7). A picture source like
echarts: "send the kitchen view to Telegram" = `screenshot` → `message.send {file}`.

Existing:

- puppeteer `screenshot {url, viewportOptions?, ioBrokerOptions?, waitOption?, type?, fullPage?, …}` ≈ (answers
  `{result: base64}` only with `ioBrokerOptions.encoding: 'base64'`, no `contentType`); its web extension serves
  `/puppeteer/?url=…` as a picture URL that `screen.show {image}` and messengers take
- phantomjs `send {url, output, width?, height?}` ≈ (writes the picture to a file on the host and answers its path)

---

## camera

### `camera.getCameras {}` — read

Answer `{cameras: [{id, name, room?, online?}]}`.

Existing: cameras `list` ≈ (`{list: [{name, desc, id}]}`), frigate `frigate:getCameras` ≈ (`[{value, label}]`),
agent-dvr `getAgentDvrCameras` ≈ (`{cameras: [{key, name, oid}]}`) and `getCameras` ≈ (`[{value, label}]`),
cam-recorder `listCameras` ≈ (`[{value, label}]`, names only).
Candidates: onvif, synology, reolink, ring, unifi-protect, eusec, bosch-smart-home-camera, motioneye, tapo, netatmo,
doorbird, lupusec.

### `camera.snapshot {camera, width?, height?, fileName?}` — read

The current picture: `{data, contentType}` (rule 7). Say in the help text if it wakes a battery camera.
In the code only frigate answers this shape (cameras by its help text); the others answer a Buffer, a path on the host
or other field names — an alias under the standard name is the cheap step (rule 1).

Existing:

- frigate `snapshot {camera, height?, quality?, bbox?, timestamp?}` ✅ (the exact Frigate name; no `width`, no
  `fileName`)
- cameras `image {name, width?, height?, …}` ≈ (`{data, contentType}` by its help text; it wakes Eufy cameras)
- bosch-smart-home-camera `snapshot {camId?}` ≈ (`{data: <Buffer>, mimeType, base64, dataUrl}`; without `camId` the
  only camera)
- reolink any command with `{action: 'snap'}` ≈ (`{type, base64}`; one camera per instance; no answer on errors)
- onvif `getSnapshot {id, base64: true}` ≈ (`{img: {base64}}`), `snapshot "<id>"` ≈ (a Buffer)
- cam-recorder `snapshot {camera, width?, live?}` ≈ (`{file: <path on the host>, …}`)
- synology `getSnapshot {camId}` ≈ (a path on the host, or `false`)
- unifi-protect `getSnapshot {cameraid, path}` ≈ (writes the JPEG to the path the caller gives and answers it; no
  answer on errors)
- 🔸 agent-dvr `snapshot_b64` (a data URL), onvif `remote.snapshot` → `snapshot` (a data URL), reolink `snapshot`
  (battery cameras), unifi-protect `manualSnapshot`, bosch-smart-home-camera `snapshot_trigger`, doorbird
  `TakeSnapshot` (a file of the adapter), motioneye `<cam>.snapshot` (no picture comes back)

Candidates: ring, tapo, netatmo, doorbird, eusec, agent-dvr, motioneye, lupusec.
For: "is the garage door closed?" (an agent gives the picture to a vision model), "send me the picture of the
front door", `screen.show {kind: 'image'}`.

### `camera.getStreamUrl {camera, format?: 'mjpeg' | 'hls' | 'rtsp' | 'webrtc'}` — read

Answer `{url, format}`, for `screen.show` on a TV or tablet. The URL should work in the LAN without the camera
password (a token of the adapter instead).

Existing: frigate `frigate:getWebUrl` ≈ (where ioBroker.web serves the cameras: `<url>/<route><camera>/stream.mjpeg`).
🔸 bosch-smart-home-camera `stream_url` (RTSP), agent-dvr `urls.mjpeg`, `urls.mp4`, synology `linkMjpegHttpPath`,
`linkRtspPath`, eusec `rtsp_stream_url`, `livestream`, onvif `infos.streamUris.*`, reolink `streams.*` (battery
cameras), motioneye `streamUrl`, lupusec `webcams.<n>.stream`, wallpanel `mjpegStream` (the camera of the tablet).
Candidates: cameras, frigate (with `camera` and `format`), reolink, synology, unifi-protect, eusec, doorbird,
bosch-smart-home-camera.

### `camera.getEvents {camera?, label?, start?, end?, limit?}` / `camera.getEventImage {id}` — read

`getEvents` answers `{events: [{id, camera, label, start, end?, score?, name?}]}` — `label` e.g. `person`, `car`,
`ring`; `name` a recognized face. `getEventImage` answers `{data, contentType}`. For "who was at the door today?".

Existing: unifi-protect `getThumbnail {thumbnail, path}` ≈ `getEventImage` (writes to a path and answers it). 🔸 events
as states: frigate `events.history.*` (with snapshot and clip URLs) and `<cam>.<label>_snapshot`, unifi-protect
`motions.<eventId>.*`, agent-dvr `events.last.*` and `alertPhotos.*`; only the last event: bosch-smart-home-camera,
eusec, doorbird, reolink (live states).
Candidates: frigate (`/api/events`), reolink (its search API), ring (dings), unifi-protect, synology (Surveillance
Station), doorbird (`history.cgi`), agent-dvr (it reads `/q/getEvents` already), motioneye (its media list),
bosch-smart-home-camera, eusec.

### `camera.identify {image | camera}` — read

Who is on the picture: `{faces: [{name, score, box?}]}` (`name` empty = unknown face).

Existing: none as a command; frigate 🔸 `sub_labels.*` (names Frigate recognized in running events).
Candidates: face, frigate (newer Frigate versions recognize faces).

### `camera.getPresets {camera}` / `camera.gotoPreset {camera, preset}` — read / write

`getPresets` answers `{presets: [{id, name}]}`; `preset` = a name or an id. "Turn the garden camera to the gate."

Existing: all 🔸 — onvif `remote.gotoPreset` with `infos.presets.*`, reolink `ptz.preset`, frigate `remote.ptz`
(`preset_<name>`), bosch-smart-home-camera `pan_preset`, eusec `preset_position`.
Candidates: the same adapters.

### `camera.pauseNotifications {camera?, seconds}` — write

No messages of the camera for a while; `seconds: 0` resumes. Answer `{ok: true, until}`. "No camera messages for two
hours, the gardener is here."

Existing: eusec `snooze {station_sn, device_sn, snooze_time, …}` ≈ (seconds); 🔸 frigate
`remote.pauseNotificationsForTime` (minutes), bosch-smart-home-camera `notifications_enabled`.

### `camera.record {camera, seconds?, preSeconds?}` / `camera.getClip {camera?, id?}` — write / read

`record` records a clip now (`preSeconds` from a buffer before now) and answers when it is done; `getClip` gives the
clip of an event (`id` from `getEvents`, without it the newest). Both answer `{file, url?, contentType, seconds}` — a
file (rule 7), never the video itself.

Existing: cam-recorder `record {camera, duration?, pre?, format?}` ≈ (answers `{file: <path on the host>, …}` when
done); agent-dvr `getRecording {camera, recording?}` ≈ (`{ok, uri: 'iobfile://…', url, file, …}`); 🔸 agent-dvr
`control.record`, `triggerRecord`, frigate `remote.createEvent`.
Candidates: frigate (event clips), unifi-protect, synology, reolink.

---

## history — history databases

`getHistory {id, options}` is already an ioBroker standard (history, influxdb, sql, recorder; also victoriametrics, and
homee for its own states). growatt has a `getHistory` with another contract (`{type, sn, startDate, endDate}`: the log
of the inverter from the Growatt cloud), so a client that asks every instance with `getHistory` must not count on it.
These come on top:

### `history.aggregate {id, start, end, fn, value?}` — read

One number for a period instead of a list: `{value, ts?, unit?, count}`. `fn`:
`min`, `max` (`ts` = when), `avg`, `sum`, `count` (number of values; with `value`: how often the state became this
value — "how often did the front door open today?"), `delta` (how much a counter rose, resets included — "how much
power last week?"), `first`, `last`, `integral` (e.g. W → Wh), `duration` (with `value`: how long the state had this
value, in seconds — "how long was the heating on today?").

Existing:

- sql `getCounter {id, options: {start?, end?}}` ≈ (= `delta`)
- history, influxdb, sql, recorder `getHistory` with `aggregate` and one step over the whole period ≈ — answers a
  list the caller still has to read
- recorder `getTimeline` ≈ (number of changes per interval)
- 🔸 the same numbers for fixed periods (today, yesterday, this week …), without free `start`/`end`: statistics
  `temp.*`/`save.*` (`sumDelta` = delta, `minmax`, `avg`, `count`, `timeCount` = duration), sourceanalytix
  `<device>.currentYear.*` (consumption and cost), janitza-gridvis `<device>.historic*`

Candidates: history, influxdb, sql, recorder, victoriametrics (VictoriaMetrics computes these itself), homee.

### `history.lastChange {id, value?, before?}` — read

When the state last changed (to `value`): `{ts, val}`. "When was the window last open?"

Existing: recorder `getEvents {ids, newest: true, limit: 1}` ≈; history, influxdb, sql
`getRawEntries {id, sort: 'desc', limit: 1}` ≈ (without the filter by value).
Candidates: history, influxdb, sql, recorder, victoriametrics, homee.

### `history.getEvents {start?, end?, room?, ids?, limit?}` — read

What happened in a period: `{events: [{ts, id, name, room, val, text?}]}`. "What went on while I was away?"

Existing: recorder `getEvents` ✅ (also `getAnomalies`, `getProfile`); eventlist `list {id? | ids?, count?}` ≈ (raw
events, newest first; no `start`/`end`; only states enabled in eventlist).
Candidates: eventlist. Writing an entry: eventlist `insert {event, id?, ts?, val?}` — worth a
`history.addEvent {text, id?, ts?, val?}` once a second adapter (recorder) has one.

### Charts

echarts `send {preset}` or `send {l: [{id}], range | start/end}` ✅ draws a chart as a picture (PNG, SVG, PDF). One
adapter is enough for this; it is listed so the others know they need not draw charts themselves. Pictures of whole
pages (a vis view, a dashboard) come from `screen.screenshot` (puppeteer, phantomjs).

---

## calendar — calendars and days

### `calendar.addEvent`, `getEvents`, `updateEvent`, `deleteEvent`, `getCalendars`

Existing:

- fullcalendar ✅ (all of these; `addEvent` with `oid` and `value` switches a state at `start`, e.g. "light off in 2
  hours")
- webcal `addEvents {calendar?, events: [{summary, start, end?}]}`, `updateEvents`, `deleteEvents` ≈ (lists of events;
  times only as text), `getCalendars` ≈ (`[{label, value}]`); no command to read events (🔸 the events of its keyword
  filters)
- icloud `getCalendars` ≈ (`{success, calendars: [{guid, title, …}]}`), `getCalendarEvents {from?, to?,
calendarGuid?}` ≈, `createCalendarEvent {calendarGuid, title, startDate, endDate}` ≈, `updateCalendarEvent`,
  `deleteCalendarEvent {calendarGuid, eventGuid}` ≈ (times in ms only)

Candidates: ical (`getEvents {start, end, calendar?}`, read-only), webcal (`getEvents`).

### `calendar.isHoliday {date?, region?}` — read

Answer `{holiday: boolean, name?, kind?: 'public' | 'school'}`. For "wake me at 7 on working days" — the alarms of
ioBroker.assistant could skip public holidays. kanban computes public holidays itself, because feiertage gives only
today, tomorrow and the next one: a reason for `isHoliday {date}`.

Existing: none. Candidates: feiertage, school holiday adapters, ical (holiday calendars).

### `calendar.getPickups {start?, end?, type?}` — read

Answer `{pickups: [{name, date, color?, done?}]}` (`done`: the bin is out already). "Which bin goes out tomorrow?"
plus an announcement the evening before.

Existing: none as a command; 🔸 trashschedule `type.json` (`[{name, daysLeft, nextDate, _color}]`), `next.*`,
`type.<name>.completed`; webcal its keyword filters (e.g. "Restmüll").
Candidates: trashschedule (a thin layer over `type.json`), webcal, ical.

---

## energy

### `energy.getForecast {start?, end?, resolution?: 'hour' | 'day'}` — read

PV forecast: `{unit: 'W', points: [{ts, value}]}` (`resolution: 'day'` → `unit: 'Wh'`).
Existing: none (states). Candidates: pvforecast, solarwetter.

### `energy.getPrices {start?, end?}` / `energy.cheapest {hours, start?, end?}` — read

`getPrices` answers `{currency, unit: 'kWh', points: [{ts, price}]}`; `cheapest` the cheapest block of `hours` hours:
`{start, end, avgPrice}`. corrently could answer the same shape with its green power index.
"When should I start the washing machine?" = `getForecast` + `getPrices` → `calendar.addEvent`.

Existing: none as a command; tibberlink 🔸 `Homes.<id>.PricesToday.json`, `PricesTomorrow.json`; its calculator
channels (`Calculations.<n>.*`) do what `cheapest` and a trigger do, for channels made in the settings.
Candidates: tibberlink (it has today and tomorrow, per hour or 15 min), awattar, corrently, entsoe. Fuel prices are not
this (per litre and station): see tankerkoenig in the [ideas](#ideas-for-single-adapters).

### `energy.getEnergy {source?, period, previous?}` — read

How much energy in a period: `period` = `day`, `week`, `month`, `quarter`, `year` (the current one; `previous: true` =
the one before); `source` = a meter of the adapter. Answer `{quantity, unit, money?, currency?}`. "How much power did
I use this month, and what did it cost?"
A series instead of one number: `energy.getStatistics {period: 'hour' | 'day' | 'week' | 'month' | 'year', start?,
end?}` → `{unit: 'kWh', points: [{from, to, yield?, consumption?, gridImport?, gridExport?, batteryCharge?,
batteryDischarge?}]}`.

Existing: sourceanalytix `getSources` ≈ (all sources with all periods at once, with cost); 🔸 statistics
`save.sumDelta.<id>.<period>`, janitza-gridvis `<device>.historic*`, sun2000 `statistics.json*` (its `statistics`
command answers an ECharts option for flexcharts), tibberlink `Consumption.*`, `Production.*`.
Candidates: sourceanalytix, statistics, janitza-gridvis, sun2000, tibberlink, growatt, lg-ess-home.

### `energy.chargePlan {device?, targetPercent, until, solar?}` — write

Charges the car to `targetPercent` until `until`, with `solar: true` preferably from PV surplus.
Answer `{ok, start?, plannedKwh?}`.

Existing: none; tesla-motors 🔸 `remote.set_scheduled_charging`, `set_scheduled_departure` (a schedule, not "X % by
then"). Candidates: evcc, easee, tesla-motors, vw-connect. Charging now: see
[vehicle](#vehicle--cars-and-wallboxes).

### `energy.batteryMode {mode, reservePercent?, power?, until?}` — write

The house battery. `mode`: `self` (self-consumption), `backup` (keep it full), `charge` (from the grid), `discharge`;
`reservePercent`: what stays for a power cut; `power` in W for `charge`/`discharge`. Answer `{ok: true, mode}`.
"Charge the battery from the grid tonight, the price is low" (with `getPrices`).

Existing: all 🔸 — tesla-motors (Powerwall) `remote.operation-self_consumption`, `operation-backup`,
`backup-backup_reserve_percent`; sun2000 `control.battery.forcibleChargeOrDischarge`, `forcibleChargePower`,
`targetSOC`, `chargeFromGridFunction`. A first draft from these two.
Candidates: tesla-motors, sun2000.

---

## vehicle — cars and wallboxes

Today every car adapter has its commands as buttons under `<VIN>.remote.*`, each with its own names and without an
answer whether the car did it. Values such as battery, range and lock state are states (rule 10); `getStatus` gives
them in one call instead of many states with different names.

A sleeping car takes a while to wake (tesla-motors wakes it before every command): the write commands answer
`{ok: true}` when the car confirmed, or `{ok: true, pending: true}` while it is still on the way (rule 9). `vehicle`:
a VIN or a name from `getVehicles`, default the only car. A wallbox counts as a vehicle for `charge` and
`setChargeCurrent`.

### `vehicle.getVehicles {}` / `vehicle.getStatus {vehicle?}` — read

`getVehicles` answers `{vehicles: [{id, name, model?, fuel?}]}` (`id` = the VIN). `getStatus` answers
`{batteryPercent?, rangeKm?, fuelPercent?, charging?, plugged?, locked?, climate?, insideTemp?, odometerKm?, lat?,
lon?, ts}`. "Is the car charged? Is it locked?"

Existing: volvo `getVehicleInfo` ≈ (one text for all cars). 🔸 the status: tesla-motors `charge_state.*`,
`vehicle_state.locked`, `climate_state.*`, `drive_state.*`; volvo `energy.*`, `status.*`, `location.*`; porsche
`status.*`; renault `battery-status.*`, `hvac-status.*`, `lock-status.*`, `location.*`.

### `vehicle.lock {vehicle?, locked}` — write

Locking at any time; unlocking only on the user's request and after confirmation, as with doors (see
[access](#access--locks-and-codes)).

Existing: all 🔸 — tesla-motors `remote.door_lock`, `door_unlock`; volvo `remote.lock`, `unlock`; porsche
`remote.LOCK`, `UNLOCK`. renault cannot (its lock state is read-only).

### `vehicle.climate {vehicle?, on, temp?}` — write

"Warm up the car at 7:30."

Existing: all 🔸 — tesla-motors `remote.auto_conditioning_start`/`stop` with `set_temps-driver_temp`; volvo
`remote.climatization-start`/`stop` (no temperature); porsche `remote.REMOTE_CLIMATIZER_START`/`STOP` with
`REMOTE_CLIMATIZER-temperature`; renault `remote.climateStart`/`climateStop` with `climateTemperature`.

### `vehicle.charge {vehicle?, on}` / `vehicle.setChargeLimit {vehicle?, percent}` / `vehicle.setChargeCurrent {vehicle?, amps}` — write

"Charge to X % by a time" is `energy.chargePlan`; these switch and set it now.

Existing: all 🔸

- charge: tesla-motors `remote.charge_start`/`charge_stop`; porsche `remote.CHARGING_START`/`STOP`; renault
  `remote.chargingStart`/`chargingStop`; easee `control.start`, `stop`, `pause`, `resume` (wallbox); volvo only for
  its wallbox (`wallbox.<EVSE>.remote.start`, `pause`), the car has none
- limit: tesla-motors `remote.set_charge_limit`; renault `remote.chargeLimitTarget` (55–100 %, steps of 5)
- current: tesla-motors `remote.set_charging_amps-charging_amps`; easee `config.dynamicChargerCurrent`,
  `maxChargerCurrent`; volvo `wallbox.<EVSE>.remote.chargingAmpLimit`

### `vehicle.signal {vehicle?, kind?: 'horn' | 'lights' | 'both'}` — write

"Where is my car in the car park?"

Existing: all 🔸 — tesla-motors `remote.honk_horn`, `flash_lights`; volvo `remote.honk`, `flash`, `honk-flash`;
porsche `remote.HONK_FLASH` with `HONK_FLASH-mode`; renault `remote.hornStart`, `lightsStart`.

### `vehicle.refresh {vehicle?, wake?}` — write

Reads the values from the car now; `wake: true` wakes a sleeping car (that costs its 12 V battery).

Existing: all 🔸 — tesla-motors `remote.wake_up`, `force_update`; volvo `remote.refresh`; porsche `remote.Refresh`,
`Force_Refresh` (wakes the car); renault `remote.refreshAll`, `askForLocationRefresh` (wakes the car).

Candidates for the family: tesla-motors, volvo, porsche, renault, easee (`charge`, `setChargeCurrent`), vw-connect.

---

## weather

### `weather.getForecast {days?, location?}` — read

Answer `{current: {temp, code, text, wind, humidity?}, days: [{date, min, max, code, text, precipitation,
precipitationProbability?, wind?}]}`, `code` = WMO weather code, `text` in `language`.

Existing: none. ioBroker.assistant reads the states of 8 weather adapters with one mapper each
(`src/lib/weather.ts`); with this command the mappers could go.
Candidates: open-meteo-weather, brightsky, openweathermap, accuweather, daswetter, weatherunderground,
pirate-weather, yr.

### `weather.getWarnings {location?}` — read

Answer `{warnings: [{level, event, headline, start, end}]}`.
Existing: none (states). Candidates: dwd, nina.

---

## presence — people

### `presence.getPersons {}` — read

Answer `{persons: [{id, name, kind?, present, room?, lastArrival, lastDeparture}]}`. `kind`: `person` (default),
`guest` or `pet` (the presence table of ioBroker.assistant has the same three); `room` where the adapter knows it
(indoor location).

Existing:

- tr-064 `presence` ≈ (the same answer plus `groups`)
- teltonika `presence` ≈ (the same shape as tr-064: `group` per person, `groups`; `present` is `null` while not known)
- 🔸 fb-checkpresence `<member>.presence` (its `triggerPresence` checks now); life360ng `places.….isPresent` (per
  place); google-sharedlocations2 `fences.<id>`; espresense `devices.<device>.<room>.presense` (per room)

Candidates: unifi-network, ping, net-tools, residents, geofency, life360, life360ng, traccar, fb-checkpresence,
google-sharedlocations2, espresense (`room`), tractive-gps (`kind: 'pet'`).

### `presence.getLocation {person}` — read

Answer `{lat, lon, accuracy?, ts, place?}`. "Where is Anna?", "How far is Denis from home?"

Existing: icloud `getDevices` ≈ (Find My devices with `distanceKm` and `owner`, no coordinates; per device, not per
person). 🔸 life360ng `people.<id>.latitude`, `longitude`, `locationName`; google-sharedlocations2 `users.<id>.lat`,
`long`, `accuracy`, `address`; icloud `findme.<id>.*`; tractive-gps `trackers.<id>.location.*` (a pet).
Candidates: life360ng, traccar, geofency, google-sharedlocations2, icloud, tractive-gps.

---

## network

### `network.getClients {online?}` — read

Answer `{clients: [{mac, name, ip?, online, wired?, accessPoint?}]}`.
Existing: tr-064 `discovery {onlyActive?}` ≈ (a JSON text), unifi-network `clientList` ≈ (`[{value, label}]` for
selects), fb-checkpresence `getDevices {onlyActive?, reread?}` ≈ (a JSON text of `[{name, ip, mac, active}]`).
Candidates: mikrotik, unifi-network, tr-064, teltonika (it reads the Wi-Fi clients already, for presence).
Not this family: wireless-settings (the network of the ioBroker host itself).

### `network.guestWifi {enabled?, minutes?}` — write (read without `enabled`)

Answer `{enabled, ssid, password, security, until?}`. With `screen.show {kind: 'qr'}`: "turn on the guest WLAN and
show the QR code".
Existing: tr-064 `guestWlan {wlan?}` ≈ (only reads; switching is a state); fb-checkpresence 🔸 `guest.wlan` (and
`guest.wlanQR`, the QR code as SVG). Candidates: unifi-network, mikrotik, fb-checkpresence.

### `network.wake {mac}` / `network.ping {host}` — write / read

Existing: net-tools `wake` ✅ and `ping` ✅; ping `ping` ✅ and `wakeOnLan` ≈; samsung_tizen `wake` ≈ (the TV).

---

## robot — vacuums and mowers

### `robot.getRooms {}` / `robot.clean {rooms?, mode?}` / `robot.pause {}` / `robot.home {}` / `robot.getStatus {}`

`getRooms` answers `{rooms: [{id, name}]}` (names as the user says them; the ioBroker room where assigned).
`clean` without `rooms` cleans everything; answer `{ok, rooms: [names]}`. `getStatus` answers
`{state: 'cleaning' | 'returning' | 'docked' | 'charging' | 'paused' | 'error', battery, error?, room?}`.
"Vacuum the kitchen and the hall."

Also `robot.stop {}`: stops where it is, without going home. With several robots every command takes `device`, from
`robot.getRobots {}` → `{robots: [{id, name, room?}]}`; without it the only robot.

Existing:

- mihome-vacuum `cleanRooms {rooms: room enum ids}` ≈, `cleanSegments {rooms: segment ids}` ≈, `startVacuuming` ≈,
  `pause` ✅, `charge`/`home` ✅, `getStatus` ≈ (raw values of the robot)
- roborock `getDeviceList` ≈ `getRobots` (`[{duid, name}]`), `get_room_names {duid}` ≈ (a map segment id → name),
  `app_start` ≈ (everything), `app_zoned_clean {duid, zones}` ≈ (map rectangles), `app_pause` ≈, `app_charge` ≈ (=
  home), `app_stop` ≈ — all need `duid`; 🔸 `commands.app_segment_clean` with one boolean per room (rooms by name only
  this way), `deviceStatus.*`
- roomba `command {command: 'start' | 'pause' | 'resume' | 'stop' | 'dock'}` ≈ (never answers); 🔸 `commands.*`,
  `states.*`
- sunseeker 🔸 (a mower) `remote.start`, `startZones`, `pause`, `dock`, `stop`; `map.zones.*`

Candidates: dreame, roborock (`clean {rooms}` by name, `getStatus`), valetudo, ecovacs-deebot, roomba (i7/s9 clean
regions), worx (zones to mow), sunseeker, mihome-vacuum (`stop`).

---

## access — locks and codes

Locking itself is a state with the role `switch.lock` (rule 10); unlocking only on the user's request and after
confirmation. Door openers are states too (doorbird `Relays.<n>`, wiegand-tcpip `remoteOpen`, tedee `remote.pull`),
with the same rule.

### `access.createCode {lock?, name, code?, start?, end?, weekdays?, dayStart?, dayEnd?}` — write

A code for a keypad, e.g. "let the craftsman in tomorrow from 8 to 12". Without `code` the adapter makes one, if it
can (tedee cannot: its `pin` is required). Answer `{id, code}`. Also `access.getCodes {lock?}`,
`access.updateCode {id, …the fields of createCode}`, `access.deleteCode {id}` and
`access.getAccessLog {lock?, start?, end?}` → `{entries: [{ts, who, action}]}`. A command that shows a code counts as
`write` (tedee `getPin {includeCode}`).

Existing:

- tedee `createPin {lockId?, pin, alias, startDate?, endDate?, dayStartTime?, dayEndTime?, weekdays?}` ≈ (`pin`
  required; answers `{lockId, pinId}`), `getPins {lockId?}` ≈ (without the codes), `getPin {pinId, includeCode?}`,
  `updatePin` ≈, `deletePin {pinId}` ≈, `refreshPins`; 🔸 `lastAction.*` (the last action only)
- wiegand-tcpip `userList` ≈ (users with their cards and PINs), `userUpsert {id, displayName?, credentials: [{type:
'card' | 'pin', value}]}` ≈ (create and update; no times; reaches the controllers with `userSyncApply`),
  `userDelete {id}` ≈; 🔸 `lastSwipe`, `lastGranted` (the last event only)
- nuki-extended 🔸 `<lock>.users.*` (keypad codes with their times, read-only) and `<lock>.logs` (both only with the
  Nuki Web API)

Candidates: nuki-extended (its Web API can create and delete keypad codes and read the log), ekey, tedee (access
log), wiegand-tcpip (access log; from/to per card).

---

## alarm — alarm panels

### `alarm.getStatus {area?}` / `alarm.arm {mode, area?}` / `alarm.disarm {area?, code?}` — read / write / write

`getStatus` answers `{areas: [{id, name, mode: 'disarmed' | 'armed' | 'home' | 'night', alarm: boolean, open?: [zone
names]}]}`. `arm` answers which zones are still open (`open`), so the user can close the window first. Disarm only on
the user's explicit request, like unlocking.

Existing: lupusec 🔸 `status.mode_pc_a1`, `mode_pc_a2` (0 disarm, 1 arm, 2–4 home 1–3), `alarm_ex`.
Candidates: lupusec, and the adapters of other panels (ajax, risco, paradox, jablotron, egardia; not checked).

---

## list — shopping and to-do lists

### `list.getLists {}`, `list.getItems {list?}`, `list.addItem {list?, text}`, `list.updateItem {list?, id, text?, due?}`, `list.completeItem {list?, id | text}`, `list.removeItem {list?, id | text}`

`getLists` answers `{lists: [{id, name}]}`, `getItems` `{items: [{id, text, done?}]}`. "Put milk on the shopping
list." `updateItem`: "make it two litres of milk".

Existing:

- shoppingroute `getLists` ≈ (`[{value, label}]`), `getShoppingList {listName}` ≈,
  `addShoppingItem {listName, text}` ≈, `deleteShoppingItem {listName, itemId}` ≈
- icloud `getReminderLists` ≈, `getReminders {listId?}` ≈, `createReminder {listId, title}` ≈,
  `updateReminder {reminderId, …}` ≈, `completeReminder {reminderId}` ≈, `deleteReminder {reminderId}` ≈ (answers
  `{success, …}`; ids only, `title` instead of `text`)
- kanban `listBoards` ≈, `getBoard {board}` ≈, `addCard {board, title}` ≈, `updateCard {board, cardId, …}` ≈,
  `doneCard {board, cardId}` ≈, `deleteCard {board, cardId}` ≈ (into the trash first)
- 🔸 kitchenowl `shoppingLists.<l>.addItemByName`, `items.<i>.remove` (= bought), `items.<i>.description`, `json`;
  alexa-shoppinglist `add_position`, `list_activ`, `to_inactiv_list`; alexa2 (lists as states)

Candidates: bring, todoist2, alexa2, kitchenowl, alexa-shoppinglist, shoppingroute (aliases).

---

## device — pairing and maintenance

### `device.startPairing {seconds?, code?, device?}` — write

Opens the network for new devices: `{ok, until}`. Then "call it hall light, it is in the hall" →
`device.renameDevice` plus the room. `device` with `code`: pairs one device that waits for it (HomeKit, Matter);
`device.getPairable {}` → `{devices: [{id, name, category}]}` lists those.

Existing: zigbee `letsPairing {stop?, id?, code?}` ≈ (answers only errors); deconz `openNetwork` ≈ (no parameters;
never answers), 🔸 `Gateway_info.network_open`; homekit-controller `pairDevice {deviceId, pin}` ≈ (`{success}`),
`getDiscoveredDevices` ≈ `getPairable`.
Candidates: zigbee2mqtt, hue, hm-rpc (install mode; its `lite:pair` pairs the adapter with openccu-lite, not
devices), zwave2, matter (pairing code).

### `device.renameDevice {id, name}` — write

Existing: zigbee `renameDevice` ✅, tr-064 `setHostName {mac, name}` ≈, assistant `setDeviceName {stateId, name,
language}` ≈ (writes `common.smartName`); 🔸 deconz `Lights.<id>.name` (and of sensors and groups), easee
`<charger>.name` (renames it in the Easee cloud); tradfri renames on the gateway when `common.name` of the object
changes.
Candidates: zigbee2mqtt, hue, deconz, shelly, homekit-controller, tradfri.

### `device.identify {id}` / `device.removeDevice {id}` — write

`identify`: the device blinks or beeps — "which one is the hall lamp?". `removeDevice` removes it from the gateway
together with its objects (only on the user's request).

Existing: homekit-controller `identify {deviceId}` ≈, `unpairDevice {deviceId}` ≈; deconz `deleteLight`,
`deleteSensor` (the id as text) ≈ (never answer).
Candidates: zigbee, hue, deconz (`identify` = alert), zigbee2mqtt.

### `device.getGroups {}` / `device.createGroup {name, devices?}` / `device.deleteGroup {id}` — read / write / write

`getGroups` answers `{groups: [{id, name, devices}]}`. "Put the three lamps of the living room into one group."

Existing: tradfri `getGroups {type?}` ≈ (`{error: null, result: {<id>: {id, name, deviceIDs}}}`), `addVirtualGroup` ≈
(no name; `editVirtualGroup {id, name?, deviceIDs?}` sets it), `deleteVirtualGroup {id}` ≈ (groups in ioBroker, not on
the gateway); deconz `createGroup "<name>"` ≈, `deleteGroup "<id>"` ≈ (never answers).
Candidates: zigbee, hue, zigbee2mqtt.

### `device.getUpdates {}` / `device.installUpdate {device}` — read / write

`getUpdates` answers `{updates: [{device, name, current, latest}]}`.
Existing: zigbee `checkOtaAvail`/`startOta` ≈ (per device), aura `adapterUpdates` ≈ (adapters), growatt
`checkLoggerFirmware {sn, type, version}` ≈ (one datalogger; the raw Growatt answer); hm-rpc 🔸
`<device>.0.FIRMWARE_UPDATE_STATE` (HmIP).
Candidates: zigbee2mqtt, shelly, esphome (its dashboard API can compile and upload; not used yet), hue,
unifi-network, hm-rpc, deconz.

### `device.startBackup {kind?}` / `device.getBackups {}` — write / read

`getBackups` answers `{backups: [{name, ts, size, storage}]}`. "When was the last backup? Make one now."
Existing: backitup `list` ≈ (a backup starts through states 🔸), zigbee `backup` ≈.
Candidates: backitup (start as a command with an answer), proxmox.

---

## docs — documents and mail

### `docs.searchDocuments {query, limit?}` / `docs.getDocument {id, fileName?}` — read

`searchDocuments` answers `{documents: [{id, title, date, correspondent?, tags?}]}`, `getDocument`
`{data, contentType}` or `{file}` (rule 7). "Find the invoice of the fridge and send it to me."
Existing: paperless-ngx `dashboardSearch {query?, tags?}` ≈, `dashboardGlobalSearch {query}` ≈; icloud
`driveListFolder {path?}` ≈ (browses a folder of iCloud Drive), `driveGetFile {path | fileId}` ≈
(`{success, name, size, base64}`, no `contentType`).
Candidates: paperless-ngx (`getDocument`).

### `docs.getMails {from?, unread?, since?, limit?}` — read

Answer `{mails: [{id, from, subject, date, text?}]}`. "Did I get mail from the tax office?"
Existing: imap `getIMAPRequest {name, search, max, fetch, bodie, parse}` ≈ (a raw IMAP search). Candidates: imap.

---

## phone — calls

### `phone.call {to, from?, text?}` / `phone.hangup {call?}` / `phone.getCalls {}` — write / write / read

Existing: asterisk-docker `call {from, to}`, `hangup {call?, extension?}`, `getCalls` ✅; telegram
`call {text, user?}` ≈ (a voice call that speaks the text); sevenio `voice {to, text, from?, ringtime?}` ≈ (a phone
call that speaks the text; `to` only as a number). Candidates: tr-064 (dial from a FRITZ!Fon).

---

## More family proposals

Smaller families, so far with one or two adapters each. Not worked out like the ones above.

- **doorbell** — `doorbell.getReplies {device?}` → `{replies: [{id, name}]}`, `doorbell.reply {device?, reply}` (a
  recorded answer played at the door), `doorbell.chime {device?, sound?}`. eusec `getQuickResponseVoices` ≈,
  `quickResponse` ≈, `chime` ≈. Candidates: ring, unifi-protect (the text on the doorbell).
- **transport** — `transport.getDepartures {station?, limit?}` → `{departures: [{line, direction, when, delay,
platform, cancelled?}]}` ("when does the next bus go?"), `transport.getJourneys {from, to, at?}`,
  `transport.findStation {query}`. public-transport 🔸 (the departures and connections of the settings as states).
- **parcel** — `parcel.getParcels {active?}` → `{parcels: [{id, description, carrier, status, eta, deliveryWindow,
lastEvent}]}` ("when does my parcel come?"), `parcel.addParcel {trackingNumber, carrier, description}`. parcelapp
  `addDelivery {tracking_number, carrier_code, description}` ≈, 🔸 `deliveries.*`. Candidates: parcel.
- **schedule** (time switches) — `schedule.getSchedules {}` → `{schedules: [{id, name, enabled, triggers: [{id, time |
astro, offset, weekdays, value}]}]}`, `schedule.enable {schedule, enabled}`, `schedule.addTrigger {schedule, time |
astro, offsetMinutes?, weekdays?, value}`, `schedule.removeTrigger {schedule, trigger}` ("switch the garden light off
  at sunset on weekdays"). time-switch `add-trigger`, `update-trigger`, `delete-trigger`, `enable-schedule`,
  `disable-schedule` ≈ (made for its widget; never answer). Candidates: schedule-switcher, heatingcontrol.
- **timer** — `timer.setTimer {seconds, name?, device?}`, `timer.getTimers {}`, `timer.cancelTimer {id | name}`.
  ioBroker.assistant `setTimer`, `listTimers`, `cancelTimer` ≈; 🔸 mytime `Countdowns.<name>.cmd` (its
  `setCountdownConfig` sets the duration), lametric the countdown app. Candidates: alexa2.
- **contacts** — `contacts.findContact {query}` → `{contacts: [{id, name, phones, emails}]}`, for "call Anna" or
  "write to Anna" with `phone.call` and `message.send`. icloud `getContacts {contactId? | groupName?}` ≈, sevenio
  `get_contacts` ≈. Candidates: tr-064 (phone book), CardDAV.
- **files** (cloud storage) — `files.listFolder {path?}`, `files.getFile {path}` → `{data, contentType}`,
  `files.uploadFile {file, folder}` (what backups and camera snapshots need). icloud `driveListFolder`,
  `driveGetFile`, `driveUploadFile` ≈. Candidates: WebDAV/Nextcloud and Dropbox adapters (not checked).

---

## Ideas for single adapters

These do not need a standard: only one adapter can do them.

| Adapter                                               | Command or change                                                                                                                                       | For                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| nmea                                                  | `getAisTargets {radius?}` → ships with name, distance, bearing, CPA/TCPA; `setAnchorAlarm {radius}`, `clearAnchorAlarm`                                 | "is a ship coming close?", "anchor alarm 40 m"                                       |
| victron-cerbo, mopeka, witmotion                      | `help` (state-only adapters: the text alone is enough, together with `history.aggregate`)                                                               | "how long does the battery last?", "how much water is left?", "the most heel today?" |
| satellite-display                                     | `screen.show` as an overlay without saving; tile type `qr`                                                                                              | camera, chart, map, guest WLAN on the display                                        |
| home3d                                                | `show` as a command with an answer; highlight devices by their state                                                                                    | "where are windows open?"                                                            |
| youtube-remote                                        | `media.search` (the InnerTube search of `src/lib/youtube.ts` moves there)                                                                               | "play channel X" without the assistant                                               |
| tvprogram                                             | channel names that match `tv.getChannels`                                                                                                               | "switch to the crime show"                                                           |
| face                                                  | `camera.identify`                                                                                                                                       | "who is at the door?"                                                                |
| eventlist, trashschedule, parcel, dwd, device-watcher | `help` (most of it is states)                                                                                                                           | "when does my parcel come?", "which devices are offline?"                            |
| eventlist                                             | its standing alarms with acknowledgement (`message {id, text, level}`, `ack`, `messages`) in `help`                                                     | "which alarms are still open?"                                                       |
| tankerkoenig                                          | `getPrices {fuel?, open?}` (`fuel`: e5, e10 or diesel) → `{currency, unit: 'l', stations: [{id, name, street, city, open, e5, e10, diesel}], cheapest}` | "where is diesel cheapest?" without reading 10 × N states                            |
| icloud                                                | `findDevice {device}` with an answer (today the state `findme.<id>.ping` plays a sound)                                                                 | "where is my phone?"                                                                 |
| awtrix-ng                                             | `getIcons` (the icons stored on the device)                                                                                                             | an agent picks an icon for `screen.show`                                             |
| ioBroker.assistant                                    | `help`; triggers made at runtime (`createTrigger {when, say}`, kept in states, not in the config)                                                       | "tell me when the washing machine is done"                                           |

---

## How ioBroker.assistant uses the catalog

1. At the start, and when an instance comes or goes, it asks `help` of every instance with
   `common.supportedMessages.help` and keeps a map `standard → [instances]`.
2. The local parsers, today one per adapter (`music.ts` for spotify-premium, `youtube.ts` for youtube-remote,
   `home3d.ts`), become one per family: "play X on Y" works for every `media.play`, "show X on Y" for every
   `screen.show`, "picture of the door camera" for every `camera.snapshot` — without the cloud LLM.
3. The cloud LLM and pi-agent get one tool per family (`play_media`, `show_on_screen`, `camera_snapshot` …) instead
   of reading every help text.
4. Pictures go from one adapter to the next without an agent in between: `camera.snapshot` →
   `screen.show {kind: 'image'}` or `message.send {file}`.
