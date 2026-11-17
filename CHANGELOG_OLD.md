# Older changes
## 1.4.14 (2026-11-07)
* (@GermanBluefox) ESPHome satellites, dialog mode: a satellite that does not listen again after an answer (it stopped the answer itself — stop word, tap) ends the mode instead of leaving it on while nobody listens; the log says how much of the answer was played

## 1.4.13 (2026-11-07)
* (@GermanBluefox) If fullcalendar is installed, it must be 3.1.0 or later (the version with the event API that commands for later use)
* (@GermanBluefox) Devices renamed in the device list keep their room, type and all their states again (`@iobroker/mcp-server` 1.9.2): before, such a device lost its room, so "the light in the kitchen" was not understood, and a light lost the switch next to its level
* (@GermanBluefox) Devices in a room hidden from the smart home (iot, `smartName: false`) are no longer listed without a room
* (@GermanBluefox) The AI sees what each state of a device is (switch, level, read-only) and that the level alone does not switch a device on
* (@GermanBluefox) The AI (cloud model and pi-agent) is told to answer in the language of the question
* (@GermanBluefox) Videos: `ask` also takes `video: { url }` with an `iobdisk://` URL - the video stays on the disk of the sender's host (js-controller 8.0+) and can be read from any host. `{ adapter, path }` of the file storage still works. Telegram sends the URL

## 1.4.12 (2026-11-05)
* (@GermanBluefox) ESPHome satellites: dialog mode — "ioBroker, Dialogmodus an" and the satellite listens again after every answer without the wake word (pauses are fine, nothing understood just listens on), "Dialogmodus aus" or a stop ends it, after 5 minutes without a request it ends by itself; state `satellites.<id>.dialog` shows and switches it

## 1.4.11 (2026-11-05)
* (@GermanBluefox) Speech recognition with the adapter ai-parakeet (NVIDIA Parakeet on the CPU, offline, 25 European languages) as provider or fallback — the audio goes to its instance over the message bus, so it may run on another host
* (@GermanBluefox) Settings: buttons "Install pi-agent" and "Install ai-parakeet" install the adapter on the host of this instance if needed (from the repository, else from npm), create an instance and select it
* (@GermanBluefox) Chat: dialog mode — the browser microphone stays open, everything said becomes a question (recognized by the assistant's speech recognition), the answer is read aloud, then it listens again

## 1.4.10 (2026-11-05)
* (@GermanBluefox) ESPHome satellites: internet radio and music from a URL — `controls.<media player>.url` plays it as media (replies and announcements only duck it, play/pause/stop/volume act on it), empty or `stop` stops. Playlists (.pls/.m3u) are resolved; a stream the device cannot decode (AAC, HLS, …) runs through ffmpeg and is served to it as FLAC; `transcode` forces that

## 1.4.9 (2026-11-05)
* (@GermanBluefox) ESPHome satellites with a screen: the yes/no button did not answer pi-agent's question — the follow-up microphone carries the last wake word (ESPHome never clears it) and was taken for a new request. A follow-up is now recognised by the open question (until the next answered request, at most 30 s after the reply), and a stop the firmware sends right after the press no longer drops the answer
* (@GermanBluefox) pi-agent: a request from a satellite also carries `satellite` (its id under `satellites.*`) and `tts` (its `tts` state), so pi-agent can speak there later (reminders, background tasks)
* (@GermanBluefox) Timers of a satellite: `setTimer` takes `satellite`, `seconds`, `name` and `announce` (said word for word when it fires); `listTimers`/`cancelTimer` take `satellite`. An ESPHome satellite shows and rings such a timer like one set there by voice

## 1.4.8 (2026-11-05)
* (@GermanBluefox) ESPHome satellites: a firmware update entity gets a "check" button (`controls.<update>.check`) that makes the device look for a new version now, instead of at its next boot or its 6-hour check
* (@GermanBluefox) ESPHome satellites: `text` entities are mirrored as writable states (labels and units of a satellite with a screen can be set from ioBroker). Values outside the device's length or pattern are refused with a warning; a password text is not mirrored
* (@GermanBluefox) Docs: the optional entities of a satellite with a screen (`confirm_answer`, `display_language`, `text`)

## 1.4.7 (2026-11-04)
* (@GermanBluefox) Voice messages: `ask` also takes a recording (`audio` as base64 plus `format`, e.g. `ogg`) instead of text. It is recognised with the speech recognition of the Voice tab and answered like a text question; the reply carries the recognised text as `heard`. Telegram uses it for voice messages
* (@GermanBluefox) Path to ffmpeg can be set on the Voice tab (empty = from the search path), with a button that checks it
* (@GermanBluefox) Hosts without ffmpeg: "Download ffmpeg" on the Voice tab fetches a static build of ffmpeg-static (20-30 MB, checked against a fixed SHA-256) into the data directory of the instance; it is used while no path is entered
* (@GermanBluefox) Pictures: `ask` takes `images` (base64 JPEG/PNG/GIF/WebP, at most 4) and passes them to the cloud model (OpenAI-compatible, Anthropic, pi-agent); without a text the question is "What is in this picture?". Rules and the local model are skipped for them. Telegram uses it for photos
* (@GermanBluefox) Videos: `ask` takes a reference `video: { adapter, path }` into the file storage (never the content). Videos are not looked at yet: without a question the answer says so, with one the model is told
* (@GermanBluefox) ESPHome: after a reply that asked something, every later reply re-opened the microphone. The firmware keeps `continue_conversation` until it is told "0", so every reply now says it, like Home Assistant does
* (@GermanBluefox) Satellites only listen again after a reply that asks something: a [[LISTEN]] marker (pi-agent's confirmations) or a question mark at the end. A question mark in the middle of a reply no longer opens the microphone
* (@GermanBluefox) ESPHome satellites with a screen: yes/no buttons (event `confirm_answer`) answer the open question like a spoken "yes"/"no" - the microphone closes, the reply is announced on that satellite. A select `display_language` is set to the voice language when the satellite connects

## 1.4.6 (2026-11-03)
* (@GermanBluefox) Speech recognition: own OpenAI-compatible server (Voice tab, provider OpenAI, "Speech recognition server"), e.g. a local whisper-large-v3-turbo in speaches, faster-whisper-server or LocalAI. It needs no OpenAI key and never gets it; an own key for the server is optional

## 1.4.5 (2026-11-03)
* (@GermanBluefox) ESPHome satellites: spoken replies go out in the format the device's media player announces (FLAC at its sample rate, as Home Assistant does; MP3/Opus via ffmpeg). Since ESPHome 2026.10 the player is built with only the codecs its pipelines use, and a WAV reply did not play at all. Devices that announce no formats keep getting WAV
* (@GermanBluefox) ESPHome satellites: when the device ends the conversation itself (button, or the wake word said again), it now gets its RUN_END. It stayed in the conversation, and every further wake word only sent another stop
* (@GermanBluefox) ESPHome satellites: an utterance that is dropped (silence, or no text recognised) ends with the error `stt-no-text-recognized` before RUN_END, like Home Assistant. A RUN_END right after the end of speech was lost while the device was still stopping its microphone, and the device waited for an answer forever
* (@GermanBluefox) ESPHome satellites: device controls get their state names from the entity names again. ESPHome 2026 (API 1.19) no longer sends `object_id`, so every control ended up as `satellites.<id>.controls.` and the log filled with errors. Latin names give the same ids as before
* (@GermanBluefox) Satellites whose row was deleted from the ESPHome table are removed at the next start, and an offline satellite can be removed in the Satellites tab

## 1.4.4 (2026-11-03)
* (@GermanBluefox) ESPHome satellites: a sound only counts as speech once it has lasted about 200 ms. After a false wake a single click opened the gate, and Whisper made "и все просят." of the amplified silence around it
* (@GermanBluefox) ESPHome satellites: when a device stops sending audio without ending the stream, the recording is closed after 2 seconds instead of the 30-second pipeline timeout, during which the satellite showed "listening"

## 1.4.3 (2026-11-03)
* (@GermanBluefox) An empty question sent with `sendTo('ask')` is rejected (`{error: 'empty question'}`) instead of going to the model with nothing but the time context, and the log names the sender once a minute. A script that asked on every answer looped about once a second and used pi-agent tokens. The log line of every `ask` now names the sender

## 1.4.2 (2026-11-03)
* (@GermanBluefox) ESPHome satellites: after 2.5 seconds of speech a pause may be half as long again before the request ends, so a pause for thought no longer cuts off a longer request. Short commands close as fast as before
* (@GermanBluefox) ESPHome satellites: speech recognition gets the recording without the device's chirp or beep and without the silence around the speech, and quiet speech is amplified (up to ×10). Whisper made "Продолжение следует..." of the beep and the silence
* (@GermanBluefox) The speech-to-text fallback also steps in when the first engine returns no text for speech
* (@GermanBluefox) Request details: the speech recognition step shows the level profile of the recording (RMS per 100 ms), where speech started, why the recording ended and what went to the recognition

## 1.4.1 (2026-11-03)
* (@GermanBluefox) Satellite settings: compound controls show their name ("Firmware Update") instead of the object id ("thirdreality_firmware_update"), and values of ESPHome devices no longer carry float noise (0.5 instead of 0.5000000237487257, step 0.001 instead of 0.0010000000474974513). Existing number controls get the cleaned range on the next connect
* (@GermanBluefox) Satellite settings, firmware update: the install button only appears when another version is available, and a running update shows its progress as a bar

## 1.4.0 (2026-11-03)
* (@GermanBluefox) ESPHome satellites: new column "Speech threshold" per device (empty = 250, as before). A device with a quiet microphone, for example a phone running a satellite app, reacted to the wake word but dropped the command as silence unless one spoke loudly right next to it. When an utterance is dropped although it came close to the threshold, the log now says so and suggests a value
* (@GermanBluefox) Voice: the length limit for spoken answers is now a setting ("Longest spoken answer", Voice tab, default 400 characters ≈ 25–30 seconds, 0 = no limit). Longer answers stopped after about half a minute without notice; the log warning now names the setting. For a spoken request the AI model (cloud LLM and pi-agent) is told the limit and asked not to read out state ids or long numbers, so the answer fits instead of being cut
* (@GermanBluefox) ESPHome satellites: the microphone closes again when nobody starts speaking within 5 s of the wake word (8 s after a follow-up question). A false wake kept it open for 12.6 s before
* (@GermanBluefox) ESPHome satellites: new option "Keep dropped recordings for diagnosis". Recordings dropped as silence or returned empty by the speech recognition are stored as WAV plus a JSON with the detector levels under Files → assistant.N/captures (the newest 50), to find out what set a satellite off. Off by default: they contain audio from the room

## 1.3.1 (2026-11-02)
* (@GermanBluefox) pi-agent: the language of the satellites goes along with every request, so pi-agent asks its confirmation questions ("… Say yes or no.") in it instead of the system language. Before, a Russian satellite was asked "Sag ja oder nein", and the German "Ja" came back empty from the speech recognition: nothing happened. Needs a pi-agent version that knows the field
* (@GermanBluefox) Requests about a script ("Skript", "script", "скрипт", also JavaScript/Blockly) always go to the cloud model: routines, rule engine and local LLM read their details as commands of their own ("write a script that switches the kitchen light every hour" was answered with the time). A reply to a question of the cloud model about the script goes there too
* (@GermanBluefox) Voice: speech that the recognition returns as empty text is now logged ("Voice Q (…): (empty)") for ESPHome and native satellites too, instead of ending without a trace
* (@GermanBluefox) Chat: opens at the newest entry, and a new request scrolls into view again. Before, the tab often opened at the oldest entries

## 1.3.0 (2026-10-28)
* (@GermanBluefox) Commands for later: "turn off the light in 2 hours" or "blinds to 50 % at 10 pm" becomes an event in the calendar (fullcalendar adapter) instead of running now; the AI can plan, list and cancel events. Before, the rule engine switched such commands at once. Needs a fullcalendar version with the new event API (>= 3.1.0)
* (@GermanBluefox) Settings: the state of a presence row is picked with the object browser, the kind of a presence row or announcement target is a dropdown
* (@GermanBluefox) New provider "System-wide AI settings (admin)", the default for new instances: provider, model and key come from the AI settings of the admin system settings, a change there restarts the instance. An instance without a key of its own takes them too
* (@GermanBluefox) New provider OpenRouter
* (@GermanBluefox) OpenRouter for speech recognition and voice: one key for the speech models of many vendors (Whisper, Deepgram, ElevenLabs, Gemini TTS, …), models and voices are listed in the settings (default voice model: ElevenLabs Flash v2.5)
* (@GermanBluefox) Voice test on the Voice tab: speak a test sentence, and test speech recognition with the browser microphone, an audio file or a round trip, all with the unsaved settings
* (@GermanBluefox) "Confirm switch commands with a tone" now also covers commands the AI (or pi-agent) carried out
* (@GermanBluefox) Spelled-out numbers up to 100 in commands ("Lautstärke auf fünfzig Prozent", "twenty five percent", "двадцать пять процентов"), and the AI sees the volume of each voice satellite, so it no longer turns up a media device of the room instead
* (@GermanBluefox) New provider "Adapter pi-agent": the durable agent of the pi-agent adapter answers what the local tiers cannot, with one conversation per satellite/chat

## 1.2.0 (2026-10-26)
* (@GermanBluefox) Own wake words for ESPHome satellites: upload a microWakeWord model in the satellite settings, the device downloads it when it is activated. Models the device cannot run (e.g. openWakeWord) are rejected on upload with the reason
* (@GermanBluefox) Voice answers come faster: the device list for the offline rule engine is built once and shared for a minute instead of up to three times per spoken command
* (@GermanBluefox) The local LLM is now the fallback for when the cloud LLM fails; "Ask the local model first" restores the old order. It is stopped after a configurable timeout, answers shorter and leaves one CPU core free
* (@GermanBluefox) When an answer asks back, UDP satellites now keep the microphone open for the reply too (needs `@iobroker/assistant-satellite` 0.2.0)
* (@GermanBluefox) "Louder", "quieter", "volume 5" change the volume of the satellite that heard it - ESPHome, ioBroker-native and UDP satellites
* (@GermanBluefox) "How's the weather tomorrow?" is answered from the weather adapter without an LLM
* (@GermanBluefox) Fixed: Russian questions with "будет" ("will it be …") were taken for alarm queries

## 1.1.0 (2026-10-25)
* (@GermanBluefox) YouTube on the TV: "play the channel XY" finds the channel, video or playlist on YouTube (no API key needed)

## 1.0.3 (2026-10-23)
* (@GermanBluefox) The Chat tab now shows every request of the last hours live - from satellites, Telegram, scripts and the chat itself - with the satellite, the detected wake word, which stage answered (rule-based NLU, routine, local LLM, cloud LLM), the tool calls and the state ids that were read and written. How many hours are kept is set in the settings (0 = record nothing)

## 1.0.2 (2026-10-14)
* (@GermanBluefox) Added the missing translations and the sizes for all screens to the settings. The tests run on Windows and macOS too
* (@GermanBluefox) The ports the adapter really opens (UDP satellites, Wyoming, ESPHome media server) are reported to js-controller 8 as used resources; the satellite port in the settings is no longer listed as an occupied TCP port

## 1.0.1 (2026-10-13)
* (@GermanBluefox) Use first model if not set
* (@GermanBluefox) Allowed to run only with local LLM

## 0.2.0 (2026-10-04)
* (@GermanBluefox) Added routines: a phrase ("good night") runs a list of actions and answers once. Matched before the offline rule engine and before the LLM, so a macro you wrote down is never reinterpreted
* (@GermanBluefox) The offline rule engine now answers questions about a kind of measurement without a device being named: "how is the air in here", "how warm is it everywhere", "how bright is it" are answered from every sensor of that kind, with a word for the air-quality number
* (@GermanBluefox) Spoken text is cached on disk, so repeated replies ("Okay.", "Timer finished") cost no cloud call and no latency. An answer over 400 characters is cut at the last sentence that fits, and `<speak>…</speak>` is now spoken as real SSML by Azure and Polly
* (@GermanBluefox) Added an optional second speech engine per direction: if the configured provider fails (outage, expired key, empty quota), speech-to-text and text-to-speech fall back to another one — with Vosk/Piper behind a cloud provider the house keeps working without the internet
* (@GermanBluefox) Added two optional settings for switch commands: confirm with a short beep instead of a spoken sentence, and verify the device's acknowledgement before reporting success
* (@GermanBluefox) An ESPHome satellite's own measurements (temperature, presence, status texts) now appear as read-only states under `satellites.<id>.controls.*`
* (@GermanBluefox) Announcements can address a group of rooms or a person: name a set of satellites in the new "Announcement targets" table and use it anywhere a target is accepted (`notify`, `askUser`, a trigger's room, the per-satellite `tts` state). The LLM also got an `announce` tool, so "tell Denis that dinner is ready" reaches his speakers — the configured names are part of the tool description. A question asked to a group counts the first answer, and the text is synthesised once for the whole group
* (@GermanBluefox) The assistant can now know who is at home: point the new "Presence" table at the states you already have (the residents adapter, a phone ping, your own flag) and name the person. It tells the LLM who is around, holds back announcements to an empty house on request (`notify` with `onlyWhenHome`), and exposes `presence.anyoneHome` / `presence.list` / `presence.lastArrival` — so greeting somebody on arrival is just a trigger on that state
* (@GermanBluefox) System notifications can now be spoken: write to `notify.text` / `notify.alert`, call `sendTo('assistant.0', 'notify', { text, severity })`, or pick the assistant in the ioBroker notification manager. The LLM turns the raw text into one natural sentence whose tone follows the severity (`info`/`notify`/`alert`, plus `direct` to speak it verbatim)
* (@GermanBluefox) Added Do-Not-Disturb, enforced by the adapter for every transport: `dnd` globally and `satellites.<id>.dnd` per satellite. Announcements are suppressed while it is on; alerts and texts starting with `!` are still played, and answers to your own questions are never affected
* (@GermanBluefox) Added proactive triggers (new "Triggers" tab): a trigger watches states or the clock and then announces something, writes a state, or asks you a question and acts on your answer ("The fryer has been on for 5 hours. Shall I switch it off?" — the LLM classifies the spoken reply against the configured response rules). Supports alternative conditions, `also`/`unless` refinements, a delay with `cancelWhen`, and a cooldown; each trigger has `triggers.items.<id>.{enabled,fire,lastFired,nextFireAt}` states plus a `triggers.enabled` master switch
* (@GermanBluefox) The assistant can now ask a question and wait for the answer: `sendTo('assistant.0', 'askUser', { question, room })` speaks it on a satellite, re-opens the microphone without a wake word and returns what was said. While a question is open that answer is routed to the caller instead of being read as a new command
* (@GermanBluefox) Added a fourth voice transport: ESPHome voice satellites (ThirdReality Voice & Music Assistant, Home Assistant Voice PE, linux-voice-assistant). The adapter dials the devices on TCP 6053, detects the end of speech itself and serves the spoken reply over a small HTTP media server

## 0.1.6 (2026-08-26)
* (@GermanBluefox) The offline rule engine now understands combined commands: "switch the light on and set the blind to 30 %", and one verb for several devices ("switch the light and the lamp on")
* (@GermanBluefox) Fixed: "50 percent" was not recognised as a level in English
* (@GermanBluefox) The selected weather adapter is now fed to the LLM as context (current conditions plus today/tomorrow), so weather questions are answered without an extra tool round-trip
* (@GermanBluefox) The local LLM receives the weather context too, so it no longer invents a forecast
* (@GermanBluefox) Documented the weather source selection in the user documentation

## 0.1.5 (2026-08-19)
* (@GermanBluefox) Corrected credentials

## 0.1.3 (2026-08-15)
* (@GermanBluefox) Updated packages

## 0.1.2 (2026-08-03)
* (@GermanBluefox) Initial commit
