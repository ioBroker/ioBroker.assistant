# ioBroker.assistant — Projekt-Kontext & Arbeitsplan (für Claude)

> Diese Datei ist die Selbst-Anleitung, um nach einem Absturz/Neustart hier weiterzuarbeiten.
> Sie enthält Vision, aktuellen Stand, Architektur, Konventionen und den nächsten Arbeitsschritt.

## Vision / Ziel

Ein **ioBroker-Adapter in TypeScript/Node.js**, der ein Sprach-/Text-Assistent ist. Er beantwortet
freie Fragen **und** Fragen über **beliebige ioBroker-States/Geräte/Wetter** und kann Geräte steuern —
über ein **LLM mit Tool-Calling** über die native ioBroker-API. Kein regelbasiertes NLU, kein
virtualDevice-Baum.

**Herkunft:** Neuimplementierung des Python-Assistenten „Hannah" (`C:\iot\Hannah`, siehe dessen
`CLAUDE.md`) — deutlich einfacher, alles in **einem** Adapter (Node.js), minimal Python.
Langfristig sollen auch TTS/STT-Engines, Satelliten-Audio und Wake-Word hier hineinwandern.

## Aktueller Stand (Status)

Voll ausgebautes create-adapter-TS-Projekt, **Build ist grün** (`npm run build`).

**Fertig:**
- **Antwort in ihrer eigenen Sprache sprechen** (Feldbericht 2026-11-12: pi-agent antwortete russisch, Thorsten
  buchstabierte „kyrillisch a …“). PR #27 (sadam6752-tech): pi-agent 0.10.1 gibt `result.language` zurück
  (`[[lang:xx]]`-Marke des Modells, sonst Schrift), `PiAgentHarness.languageOf(text)` (Schlüssel **ohne**
  `[[LISTEN]]`/`[[DONE]]`, sonst fand die TTS die Rückfragen nicht). Darauf `src/lib/voice/speechLanguage.ts`:
  `LanguageTts` ist die **äußerste** Schicht in `createTtsEngine` (gilt für alle Transporte, Durchsagen, Stimmtest),
  `speechLanguage(text, configured, reported)` — Meldung gilt, wenn die Schrift nicht widerspricht; sonst Schrift
  (Kyrillisch/ґєії→uk/Griechisch/CJK/Kana/Hangul/Arabisch/Hebräisch, ≥ 3 Buchstaben); Latein auf nicht-lateinischer
  Sprache → `en`. Eine eingestellte Stimme nur für ihre Sprache (`voiceFitsLanguage` = Locale am Namensanfang,
  Azure `Multilingual` = alle): Piper, Azure, OpenRouter; Polly über `EngineContext.language`. Tabelle `ttsVoices`
  `{language, voice}` → `VoicePerLanguage` (eine Engine + Cache pro Zeile, nur Hauptanbieter, `prepare` lädt alle).
  Schichten: `LanguageTts(Fallback(VoicePerLanguage(Cached…), Cached))`. STT bleibt bei `voiceLanguage` (Whisper
  bekommt `language` → erkennt nichts; Auto-Erkennung wäre ein Opt-in, bei kurzen Befehlen unzuverlässig).
  Tests: `speechLanguage.test.js`, `answerLanguage.test.js`. Nicht am Gerät.
  **Sprache der Frage** (Feldbericht Alex F. 2026-11-12: „скажи, сколько сейчас времени“ → NLU-Zeit auf Deutsch):
  `questionLanguage(text, configured)` — fremde Schrift → wie `speechLanguage`; Latein → Funktionswörter en/de
  (`FUNCTION_WORDS`, ohne zweideutige wie in/an/die/was), Wechsel nur bei ≥ 2 Treffern und > 2× so vielen wie die
  eingestellte Sprache. `answer()` legt sie in `requestOrigin.language`, `answerLanguage()` liefert sie (sonst Config)
  — die festen Antworten (Zeit, Geräte, Timer, Wecker, Wetter, Lautstärke, Kalender, YouTube, Stoppwort, Fehler) nutzen
  sie; System-Prompt-Hinweise, Gerätenamen, STT und spätere Timer-Ansagen bleiben bei der Config. Antworten in einer
  anderen Sprache merkt sich `answerLanguages` (`AnswerLanguages`, auch von `PiAgentHarness` genutzt) → `reportedLanguage`
  → englische Stimme für englische Antwort. Journal-Schritt „Question in 'en' …“.
- **Modell-Manager für das lokale LLM** (Nutzerwunsch 2026-11-10, Branch `feat/local-model-manager`). `src/lib/llmModels.ts`
  `ModelManager`: Ordner `localLlmModelDir` (absolut, leer = `<Datenverzeichnis>/models` = bisheriger Ort), `list()` =
  `*.gguf` mit Größe + Quelle aus `<Ordner>/models.json`, `disk()` per `fs.statfs` (nächster existierender Elternordner),
  `startDownload()` (`normalizeModelUrl`: `hf:org/repo/file`, `/blob/` → `/resolve/`; HEAD für die Größe, Platzprüfung
  mit `DISK_RESERVE_BYTES` 200 MB, `.part` → GGUF-Magic prüfen → rename, abbrechbar, parallel, Fehler 1 min sichtbar),
  `delete()` (nie das aktive), Statistik pro Datei in `<Datenverzeichnis>/local-llm-stats.json` (Summen: asked/answered/
  handoffs/busy/timeouts/errors, tokens+genMs → tokens/s, firstTokenMs, answerMs, loads/lastLoadMs, lastUsed, benchmark;
  5 s debounced + `flush` in `onUnload`). `MODEL_PRESETS` (10, URLs + Größen am 2026-11-10 gegen HF geprüft, Sprachen
  laut Modellkarte, `speed` = **Schätzung** aus der Größe): MNN-Pocket 0.3B Q4_1 (nur en/zh, **das Original-Repo ist
  safetensors/MNN, nur `-GGUF` läuft hier**), Qwen3 0.6B/1.7B (unsloth, `thinking` → `budgets.thoughtTokens: 0`),
  Qwen2.5 0.5/1.5/3B, Gemma 3 1B/4B, Llama 3.2 1B/3B (kein ru). `LocalLlm` bekommt jetzt `modelPath` statt URL (Download
  nur noch im Manager), misst per `onToken` (`lastRun`: ms, tokens, firstTokenMs, genMs, promptTokens per `tokenize`),
  `loadMs`. `main.ts`: Config `localLlmModel` (Datei, `selectSendTo getLocalModels`), `activeLocalModel()` fällt ohne
  Auswahl auf die Datei von `localLlmModelUrl`/Default zurück (alte Installationen laufen unverändert), fehlende Datei
  mit bekannter Quelle wird vor dem Laden geladen, sonst Status `error`. sendTo `listLocalModels`/`addLocalModel {preset|
  url}`/`cancelLocalModelDownload`/`deleteLocalModel`/`resetLocalModelStats`/`benchmarkLocalModel` (alle nehmen `dir`/
  `active` aus dem ungespeicherten Formular), State `localLlm.model`, Status `benchmark`. **Wechsel nur per Neustart**
  (Nutzerwunsch). `src/lib/llmBenchmark.ts`: je 3 Zuhause-Fragen (→ HANDOFF) + 3 Fakten (Regex) pro Sprache, Sprache
  des Assistenten + en; läuft nur auf dem **geladenen** Modell (zwei Modelle = doppelter RAM), wartet, solange eine echte
  Frage läuft, zählt nicht in die Nutzungsstatistik. GUI `src-admin/src/LocalModelsComponent.tsx` (Reiter
  `_localModels`, immer sichtbar, `useLocalLlm` oben, der Rest `hidden: !data.useLocalLlm`): **Ordnerwähler**
  `localLlmModelDir` = jsonConfig `type:"diskSelector"`, `mode:"folder"` (json-config ≥ 10.1.19 / Admin 8.3.11; der Host
  braucht `CONTROLLER_READ_DISK_DIR`/`readDiskDir`, js-controller ≥ 8.0.0-alpha.17 — alpha.15 meldet „kann seine
  Festplatte nicht auflisten“); die Komponente zeigt bei Admin < 8.3.11 ein Textfeld als Ersatz (`socket.getVersion()`,
  `DISK_SELECTOR_ADMIN`). Kopf (Ordner, Summe, freier Platz, Status), Tabelle mit „Verwenden“
  (schreibt `localLlmModel` ins Formular), Test, Statistik zurücksetzen, Löschen mit Bestätigung, Downloads mit
  Fortschritt/Abbruch, Vorlagen-Karten (Sprachwarnung, Platz), eigener Link, Testdetails-Dialog; pollt 1 s während
  Downloads/Test, sonst 10 s. **Echt geprüft** in der Cloud-Sandbox (x86, node-llama-cpp 3.22.3, nicht auf dem Pi):
  Download über den Manager, Laden, Messwerte, Qwen3 ohne `<think>`, `main.ts` per Wegwerf-Harness (Liste, Dropdown,
  Schutz aktiv/geladen, relativer Pfad, Laden, Statistik, Test, fehlende Datei). Test-Ergebnisse (ru+en, 12 Fragen):
  MNN-Pocket 4/12 (ru unbrauchbar), Qwen3-0.6B 4/12 (365 Tage, „Парисс“), Gemma 3 1B 7/12 („Закрываю жалюзи“ erfunden),
  Qwen2.5-1.5B 8/12. **Daraus gefixt:** `isHandoff` erkannte englische Absagen „as an AI language model, I don't have
  the ability…“ / „I don't have any information…“ nicht (gingen als Antwort an den Nutzer) → neue Muster en/de, Test mit
  den Originalsätzen. ⚠️ Erfundene Ausführungen („Okay, I've turned on the light“) erkennt kein Muster — nur der Test
  zeigt sie. Tests: `llmModels.test.js` (echter HTTP-Server: Download, HTML statt GGUF, zu groß, Abbruch, Löschen,
  Statistik, Benchmark-Wertung), `localLlm.test.js`.
- **Dialogmodus für ESPHome-Satelliten** (Nutzerwunsch 2026-11-05: „ioBroker – Dialogmodus an“ → ohne Wake-Word
  weitersprechen, „Dialogmodus aus“ → normal). `nlu.ts.dialogCommand()` (de/en/ru, Modus-Phrase Pflicht, Fragen
  und > 8 Wörter → null, an **und** aus → null) → `main.switchDialog()` in `produceAnswer` nach der
  `askUser`-Antwort, vor allen Stufen; im Dialog schaltet auch ein bloßes Stoppwort (≤ 2 Wörter) aus. Journal
  `nlu`/`dialog on|off`. `esphome.ts`: `EsphomeConnection.setDialog(on, reason, open?)` / `EsphomeSatellites.
  setDialog|dialog`, Option `onDialog` → State `satellites.<id>.dialog` (boolean, `switch.mode`, schreibbar, in
  `markEsphomeSatellite` angelegt; Schreiben an einem wartenden Satelliten = Bestätigungston per Durchsage mit
  `start_conversation`, `question=false` → keine offene Ja/Nein-Frage). Im Dialog: jede Antwort `continue_conversation
  '1'` (INTENT_END + RUN_END), Folge-Mikro ohne WAKE_WORD_END (die Phrase ist die alte), `startTimeoutMs` 0, Detektor
  fängt nach `DIALOG_WINDOW_MS` 10 s **Audio** ohne Laut neu an (`nextDialogWindow`, `SpeechDetector.hearing`/
  `analysedMs`), max. 20 s Rede. Nichts erkannt (Stille-`timeout`/`speech-end`, leere STT) → INTENT_END „1“ +
  `reopenDialog()` = 250 ms Stille als TTS_END + RUN_END „1“ (ESPHome öffnet das Mikro erst nach einer gespielten
  Antwort); leere Antwort (Ton-Bestätigung) → der Ton als Antwort (`playConfirmationTone` tut im Dialog nichts).
  Aus: Stopp des Geräts (außer Echo unseres ERROR), offline, Pipeline-Fehler, Stream-Ende/Stall, 5 min ohne
  verstandene Anfrage (`DIALOG_IDLE_MS`, Prüfung alle 5 s, nicht während gehört/geantwortet wird); beim Ausschalten
  schließt ein Mikro, das nichts hört, sofort. Tests: `esphome.test.js` (Fake-Gerät `speak()`/`position()`/
  `maxStreamMs`), `nlu.test.js` (`dialogCommand`). ⚠️ Nicht am Gerät: ob ESPHome/linux-voice-assistant nach dem
  stillen Clip das Mikro wirklich wieder öffnet, ist aus dem Quellcode abgeleitet (gleicher Weg wie Rückfragen).
  **Erster Test auf vitanova (1.4.12, ThirdReality, 2026-11-05):** „Включи режим диалога“ → Modus an, Antwort (12,2 s
  WAV) geholt, aber `AnnounceFinished` schon nach 1,6 s, danach **keine** neue Pipeline → LED aus, State blieb `true`.
  Beim ersten Versuch (1.4.11+Dialog, ungecachte Antwort) fiel das Gerät 44 s nach der Antwort aus (Keepalive,
  EHOSTUNREACH, ECONNREFUSED, nach 43 s wieder da). Firmware (`linux-voice-assistant-cpp/src/satellite/
  Satellite.cpp`, GitHub thirdreality/voice-music-assistant): `FinishSpeech()` schickt `AnnounceFinished` (im
  Pipeline-Pfad immer `success:false`) und öffnet mit `continue_conversation_` nach `continue_conversation_delay`
  (0,5 s) per `BeginListening()` — **ohne** Wake-Ton, mit der alten Phrase. Gelöscht wird das Flag u. a. vom
  **Stoppwort während TTS** (`ProcessStopDetected`, seit „Support wake and stop during TTS“ 2026-10-26), Tippen,
  Wake-Word (startet aber eine neue Runde → wir sähen sie) und `PrepareForMediaAnnouncement`. Passt am besten:
  Stoppwort-Fehlauslösung durch die eigene Antwort — **nicht verifiziert** (die Firmware kennt kein
  `SubscribeLogsRequest`, Geräte-Logs gibt es nur am Gerät). Darauf: `onReplyPlayed()` — im Dialog nach
  `AnnounceFinished` `DIALOG_REOPEN_MS` 6 s auf eine neue Pipeline warten, sonst Modus aus (`'no-listen'`), Log
  „stopped the reply after X of Y s“ (früher als `REPLY_CUT_MS` vor dem Ende) bzw. „did not open its microphone“.
- **Dialog-Modus im Chat-Tab** (Nutzerwunsch 2026-11-05): Knopf `RecordVoiceOver` links vom Eingabefeld, nur bei
  `VoiceDialog.supported` (Secure Context + getUserMedia), aktiv nur mit `voiceEnabled`. `src-admin/src/voiceDialog.ts`:
  `VoiceDialog` (getUserMedia mit AEC/NS/AGC, ScriptProcessor 2048 → `Resampler` linear auf 16 kHz),
  `UtteranceDetector` (Energie-Gate wie `vad.ts`: Rauschboden, Kandidat ≥ 250 ms, Lücke 300 ms, Stille 1 s bzw. 1,6 s
  nach 2,5 s Rede, max 30 s, Pre-Roll 400 / Tail 300 ms; `BROWSER_DETECTOR` min 400/240 — Browser-Mikro mit AGC).
  **Halbduplex**: während `ask` und Vorlesen wird das Mikro nicht ausgewertet, danach 400 ms Pause, Detektor-Reset
  (Rauschboden bleibt). `ChatComponent.dialogTurn` → `ask {audio: PCM base64, format:'pcm', sampleRate:16000,
  spoken:true}` (Quelle `chat` = gleiche Konversation wie getippt), `heard:''` → still weiter, Antwort per `tts`-sendTo
  (Satellitenstimme), sonst `speechSynthesis` in `voiceLanguage`, Schutz-Timeout. Backend: `AskMessage.spoken` →
  `answer(…, spoken)` setzt `requestOrigin.voice` → Längenhinweis wie bei Satelliten (Satellit bleibt leer).
  Detektor/Resampler mit synthetischem Audio geprüft (Scratch, `--experimental-transform-types`), nicht im echten
  Browser am Mikro. ⚠️ `src-admin`-`tsc` (TS 7) lehnt die eigene tsconfig ab (`esModuleInterop=false`,
  `moduleResolution=node10`) — Typprüfung mit Root-`tsc` 6 + `ignoreDeprecations:"6.0"`; Vite prüft keine Typen.
- **ai-parakeet als STT + Installations-Knöpfe für pi-agent/ai-parakeet** (Nutzerwunsch 2026-11-05). Anbieter
  `parakeet` (auch als Reserve): `src/lib/voice/parakeet.ts` `ParakeetStt` → `sendTo(<inst>,'transcribe',{pcm base64,
  sampleRate, prompt})` (Buffer würde als JSON-Zahlenarray serialisiert; Sprache geht nicht mit, das Modell erkennt
  sie), Antwort `{text}`/`{error}`. Über den Nachrichtenbus statt HTTP: geht auf jedem Host, API-Key von ai-parakeet
  egal. `EngineContext.parakeetInstance`/`sendMessage`; `main.askInstance()` prüft `alive`, Timeout
  `PARAKEET_TIMEOUT_MS` 60 s. Config `parakeetInstance` (jsonConfig `type:"instance"`). **Knöpfe** (`sendTo`
  `installAdapter {adapter}`, `useNative` + `result`/`args` → Instanz landet im Formular, sichtbar nur ohne gewählte
  Instanz): `src/lib/installer.ts` `AdapterInstaller` schickt dem eigenen Host `cmdExec` (`add <name>`; nicht im
  Repository → `url iobroker.<name>` von npm → `add`), die Antworten `cmdStdout`/`cmdStderr`/`cmdExit` (letzteres
  doppelt) fängt `onMessage` als Erstes ab. Ein Befehl im Timeout (15 min) beendet den Ablauf (sonst liefe npm
  parallel zu `add`). Nur `pi-agent`/`ai-parakeet` (`HELPER_ADAPTERS`). Test: `parakeet.test.js` (Fake-Host wie
  js-controller), main per Wegwerf-Harness. ⚠️ ai-parakeet ist (Stand 2026-11-05) weder auf npm noch im Repository —
  der Knopf meldet das, bis es veröffentlicht ist; pi-agent nur in „latest“ → bei stable kommt es von npm. Nicht
  gegen einen echten Host gelaufen.
- **Musik/Internetradio per URL auf ESPHome-Satelliten** (Wunsch des Firmware-Entwicklers, 2026-11-05, Punkte 8+9;
  Punkt 10 „Titel“ = die `text`-Entity der Firmware, nichts im Assistant). State `controls.<player>.url` →
  `playMediaUrl()`: `MediaPlayerCommandRequest{has_media_url, media_url, has_announcement:true, announcement:false}`
  (Media-Pipeline, Antworten ducken nur; `esphomeEntities` mediaPlayer nimmt `{url}`), leer/`stop` → STOP, ack mit der
  URL nach dem Senden (das Gerät meldet keine URL zurück). `src/lib/voice/mediaStream.ts`: `probeStream` (ein GET pro
  Stufe, nur Header, Body nur bei Playlist ≤ 64 KB; `.pls`/`.m3u` → erster Eintrag, max. 3 Ebenen; HLS bleibt),
  `deviceCodecs` (gemeldete Formate; keine oder `none` → mp3/flac/wav — seit ESPHome 2026.10 dekodiert die Firmware
  nur die Pipeline-Formate), `planStream` (direkt | ffmpeg; `transcode`-State = immer ffmpeg; ohne ffmpeg immer
  direkt), `transcodeTarget` (FLAC vor MP3/Opus/WAV, Rate/Kanäle aus dem default-Format, sonst 48 kHz mono),
  `transcodeArgs` (`-reconnect…` außer HLS). `MediaServer.serveStream` (ein Quell-Prozess pro Zuhörer, `unserve`
  schneidet ab, **`flushHeaders()`** — sonst gehen die Header erst mit ffmpegs erstem Byte raus). Pro Player ein
  Stream (`mediaStreamPaths`), `mediaPlays`-Zähler gegen verspätete Probes. Tests: `mediaStream.test.js` (echter
  ffmpeg-Lauf WAV→FLAC), `esphome.test.js` (Fake-Gerät nimmt `MediaPlayerCommandRequest`); main per Wegwerf-Harness
  (fand den fehlenden `.controls` im State-Pfad). Nicht am Gerät, nicht gegen echte Sender.
- **Bilder (und Video-Verweise) im `ask`** (Nutzerwunsch 2026-11-04, Telegram-Fotos) — `src/lib/media.ts`:
  `parseAskImages` (base64/Data-URL, Typ per Magic Bytes JPEG/PNG/GIF/WebP — die Angabe des Absenders zählt nicht,
  max. `MAX_IMAGES` 4, je ≤ 5 MB base64 = Anthropic-Grenze; ein kaputtes Bild → ganze Anfrage `{error}`, weil eine
  Frage zum Bild ohne Bild geraten würde), `parseAskVideo` (**nur** `{adapter, path, …}` im Dateispeicher, `data` →
  Fehler; `error` vom Absender = konnte nicht gespeichert werden, z. B. > 20 MB), `redactImages` (Trace + Debug-Dump:
  `<image/jpeg, 180 KB>` statt base64), Texte de/en/ru. `main.ts`: `Attachments` im `requestOrigin`-Store,
  `askAttachments()` im `ask`-Handler, ohne Text → `imageOnlyQuestion`. `CloudOnly` + `'image'` (Routinen/NLU/lokales
  LLM blind; nach `script`/`scriptReply` geprüft, `scriptTopics` nur bei Skript), ohne Cloud-Stufe `noVisionText`;
  Video ohne Frage → `videoNotSupportedText` (Journal-Stufe `none`), mit Frage `attachmentNote` im User-Turn.
  Verlauf/Journal-Frage = `historyText` („[picture] …“) — Bilder gehen nicht in spätere Runden. `llm.ts`:
  `openAiUserContent` (`image_url` Data-URL, auch Gemini/OpenRouter) / `anthropicUserContent` (Bilder vor Text).
  pi-agent: `images` im `ask` + `attachmentNote` im Text (ältere pi-agent verwerfen die Bilder). **pi-agent** (main,
  nicht committet): `askImages()` → Content-Array mit pi-ai-`ImageContent`, `chat.pending` hält nur `contentText()`
  (ein Neustart findet die Submission per requestId), Admin-Chat zeigt „[picture]“; Modelle ohne Bildeingang ersetzt
  pi-ai selbst durch einen Platzhalter. **Telegram** (Branch `feat/assistant-media`, auf `feat/assistant-timeout`):
  `forwardsMediaToAssistant` (Config `assistantMedia`, Default an, nur mit `msg.from`), Alben per `media_group_id`
  1,5 s gesammelt, Foto-Größe ≤ 1600 px (`assistantPhotoSize`), Videos → `telegram.0/assistant/video_<Zeit>_<id>.mp4`
  (neueste 20), `downloadFileOnce` (Speichern + Weiterleiten = ein Download), die Caption geht dann nicht zusätzlich
  über `processTelegramText` an den Assistenten. Tests: `media.test.js` hier, `test/images.test.js` in pi-agent,
  Telegram per Wegwerf-Harness.
- **Telegram-Sprachnachrichten + ffmpeg-Pfad** (Nutzerwunsch 2026-11-04). `ask` nimmt statt `text` auch
  `audio` (base64) + `format` (`AskMessage`): `transcribeAsk()` — `pcm` (+`sampleRate`) und RIFF direkt, sonst
  ffmpeg auf **16 kHz** (`decodeAudioBufferToPcm(buf, rate)`), STT aus `getSpeechEngines()` mit Hints, nur bei
  `voiceEnabled`. Danach normales `answer(question, source, {sttMs, audioMs})` → Journal mit STT-Schritt;
  `requestOrigin.voice` bleibt false (Antwort ist Text). Antwort `{answer, heard}`; leere Erkennung →
  `{heard:'', error: nothingHeardText()}` (de/en/ru); Text gewinnt, wenn beides kommt. **Telegram**
  (`C:\pWork\ioBroker.telegram`, nicht committet): `saveFile` geteilt in `downloadFile`/`storeFile`, die
  Sprachnachricht wird **einmal** geladen, gespeichert wie bisher (`communicate.pathFile`) und bei
  `assistantInstance` + `msg.from` + ohne Caption an `askAssistantByVoice()` gegeben: gleiche Alters- und
  Nutzerprüfung wie Text (Passwort/`doNotAcceptNewUsers`), `typing`-Action, `ask` mit `format:'ogg'`, Antwort
  „🎤 <heard>\n\n<answer>“; ein alter Assistant antwortet `empty question` ohne `heard` → einmal warnen, nichts
  in den Chat. **ffmpeg-Pfad**: Config `ffmpegPath` (Reiter Voice, leer = PATH), `ffmpegBin()` an beiden
  `spawn`s, `FFMPEG_HINT` in der Fehlermeldung, Knopf `testFfmpeg` (Version + ob libmp3lame/libopus da sind).
  **ffmpeg herunterladen** (`src/lib/voice/ffmpegStatic.ts`, sendTo `downloadFfmpeg`, Nutzerwunsch 2026-11-04):
  die Binaries von **ffmpeg-static** (Release `b6.1.1`, `ffmpeg-<platform>-<arch>.gz`), aber **nicht das npm-Paket**
  — dessen Install-Script lädt 20–30 MB bei jeder Installation, und neuere npm fragen vor Install-Scripts (dann
  fehlt die Binary still). SHA-256 der `.gz` gepinnt (GitHub liefert `digest` pro Asset), Download per Stream
  durch Hash → Gunzip → `.part` → rename, nach `<Datenverzeichnis>/ffmpeg/ffmpeg(.exe)`. `ffmpegBin()`:
  Pfad → heruntergeladenes → `ffmpeg` aus PATH; `downloadedFfmpeg()` prüft **jedes Mal** per `existsSync`
  (Löschen wirkt ohne Neustart). Der Name täuscht: auf linux-arm64 ist es ffmpeg **7.0.2** (johnvansickle).
  Test: `ffmpegStatic.test.js`. Auf vitanova: Download, `ask` mit OGG dekodiert, danach wieder gelöscht.
  Geprüft mit Wegwerf-Harnessen (echte Adapter-Klasse, Fake-adapter-core, echtes OGG/Opus aus ffmpeg, Fake-STT;
  Telegram mit Fake-Bot). Nicht gegen echtes Telegram/echte STT gelaufen.
- **Eigener STT-Server (OpenAI-kompatibel)** — Nutzerwunsch 2026-11-03 (whisper-large-v3-turbo im Container daneben).
  Kein eigener Anbieter, sondern Felder am Anbieter `openai`: `sttBaseUrl` + `sttServerKey` (encrypted/protected,
  in `VOICE_FORM_FIELDS`/`VOICE_FORM_SECRETS`), sichtbar bei STT-Anbieter **oder** -Fallback `openai` (wie jetzt
  auch `sttModel`). `stt.ts.normalizeSttBaseUrl()` (Adresse ohne Pfad → `/v1`, sonst unverändert; kein URL →
  Fehler), `OpenAiStt(key, model, baseUrl)` baut dann den Client mit `baseURL`, Timeout 60 s, 1 Retry, Key
  `sttServerKey || 'none'` — **der OpenAI-Key geht nie an einen fremden Server**, und `requireOpenAi` entfällt.
  Hints (`prompt`) gehen mit (faster-whisper kann `initial_prompt`). Folge: Fallback „OpenAI-Cloud hinter dem
  eigenen Server“ geht nicht (gleicher Anbieter). Trace: `server` im STT-Schritt. Test: `engines.test.js`
  (echter HTTP-Fake auf `/v1/audio/transcriptions`, Multipart geprüft). Nicht gegen einen echten Server gelaufen.
- **ESPHome 2026.10 / API 1.19 (Feldbericht Alex F., 2026-11-03)** — gegen den ESPHome-dev-Quellcode geprüft
  (`voice_assistant.cpp`, `api_connection.cpp`, `entity_base.cpp`, `audio.cpp`), nicht gegen das echte Gerät.
  (1) **Antwortformat** (`replyFormat.ts`, `flac.ts`): der Media-Player wird nur noch mit den Codecs seiner
  Pipelines gebaut (`USE_AUDIO_WAV_SUPPORT` fehlt dann) → WAV spielte nicht. Wir lesen `supported_formats` des
  Media-Players (`EsphomeEntity.formats`) und nehmen wie HA das **Announcement-Format** samt Rate/Kanälen:
  FLAC/WAV selbst (FLAC mit VERBATIM-Subframes, CRC/MD5, Hann-Sinc-Resampler mit Phasentabelle, ~50 ms für 10 s),
  MP3/Opus per ffmpeg (`main.runFfmpegEncode`, Option `encodeAudio`), ohne ffmpeg FLAC mit Warnung. Gerät ohne
  Liste (linux-voice-assistant/ThirdReality) → WAV wie bisher. Erkennung im Gerät per Content-Type, sonst
  Endung → `MediaServer.publish` vergibt `.flac`/`.opus`/`.mp3`. (2) **Stopp der Platine**: in `AWAITING_RESPONSE`
  schickt `request_stop()` nur `start:false` und wartet auf unser RUN_END → `onStopRequest()` antwortet mit RUN_END
  und verwirft die laufende Antwort (`run`-Zähler, `current()` nach jedem `await` in `finishCapture`; neuer Wake
  und Disconnect zählen auch hoch). Stopp ohne offenen Lauf → trotzdem RUN_END, außer ≤ `ERROR_ECHO_MS` nach
  unserem ERROR (darauf antwortet die Firmware selbst mit `signal_stop_`). (3) **RUN_END direkt nach STT_VAD_END
  geht verloren** (Zustand `STOP_MICROPHONE`, ältere Firmware; dev hat inzwischen einen Zweig dafür) → beim Verwerfen
  und bei leerer STT `endWithoutRequest()`: ERROR `stt-no-text-recognized` (wie HA; Voice-PE-YAML spielt dafür
  keinen Fehlerton) + RUN_END, **kein** STT_END ohne Text. (4) **Kein `object_id` mehr** (nur `key`+`name`;
  Entity ohne eigenen Namen → `name` leer) → `entityObjectId()`: ASCII-Name nach Firmware-Regel
  (`esphomeObjectId`, = alte ids), sonst Buchstaben behalten (`\p{Ll}\p{Lu}\p{Nd}`), sonst `<kind>_<key>`; ohne
  Namen der `friendly_name` aus `DeviceInfoResponse`. `main.isControlId()` überspringt unbrauchbare ids.
  (5) **Satelliten aufräumen**: `onStatus` liefert die Tabellen-Adresse (`esphomeAddress`: `ip` bzw. `ip:port`),
  `markEsphomeSatellite` schreibt sie nach `native.esphome` + State `host`; `removeStaleEsphomeSatellites` (vor dem
  Verbinden) löscht markierte Satelliten ohne Zeile/mit anderem Raum, alte unmarkierte nur mit `wakeWords` und wenn
  jede Zeile einen Raum hat. sendTo `deleteSatellite {id}` (nicht, solange `alive`), GUI: 🗑 statt ⚙ bei offline.
  Tests: `replyFormat.test.js` (eigener FLAC-Decoder + ffmpeg-Gegenprobe), `esphome.test.js` (Fake-Gerät:
  `objectIds:false`, `formats`, `stopAfterVadEndMs`, `sendStop()`).
- **ESPHome-Satelliten mit Bildschirm + Mikro nur nach Fragen** (Wunsch eines Firmware-Entwicklers, 2026-11-04,
  `esphome.ts`, gegen ESPHome-dev `voice_assistant.cpp` geprüft, nicht am Gerät). (1) **`continue_conversation`
  immer explizit** `'1'`/`'0'` in INTENT_END **und** RUN_END: ESPHome setzt das Flag nur in INTENT_END mit dem Key
  und zurück nur in `request_stop()` → nach **einer** Rückfrage öffnete jede spätere Antwort das Mikro wieder
  („No text recognized“ nach 5 s). HA schickt „0“ genauso; linux-voice-assistant liest RUN_END und ignoriert „0“.
  Dazu `ask.ts.endsWithQuestion()`: „?“ zählt nur **am Ende** (vorher überall), Rückfragen mitten im Text brauchen
  `[[LISTEN]]` (pi-agent setzt es). (2) **Ja/Nein-Knopf**: Event-Entity `confirm_answer` (Typen `yes`/`no`) zählt
  nur bei offener Frage (`questionUntil` = Antwortlänge + `FOLLOW_UP_START_MS` nach RUN_END mit „1“ bzw. Durchsage
  mit `start_conversation`; während der Folge-Aufnahme `capture.answersQuestion`; nach Stopp/stiller Aufnahme noch
  `CONFIRM_GRACE_MS`, weil die Firmware das Mikro beim Tippen evtl. selbst stoppt; Wake-Word = neue Runde → zu).
  Dann: offene Aufnahme per **RUN_END ohne STT_VAD_END** schließen (Mikro läuft → STOP_MICROPHONE→IDLE, keine
  Fehleranzeige), `run++`, `opts.answer(yesNoWord(lang), {button})` — pi-agent entscheidet wie bei Sprache —,
  Antwort als **Durchsage** mit `text` (Display) und `start_conversation` = neue Rückfrage. Ein Folge-Mikro, das das
  Gerät für die schon beantwortete Frage noch öffnet, wird `IGNORE_FOLLOW_UP_MS` lang sofort per RUN_END beendet.
  `JournalOrigin.button` im Trace. (3) **Displaysprache**: Select `display_language` einmal pro Verbindung mit dem
  ersten gemeldeten Zustand abgleichen (`displayLanguageOption`: Name in der Sprache, englischer Name oder Code,
  `Intl.DisplayNames` + Tabelle); Sprachwechsel = Adapter-Neustart = neuer Abgleich. Tests: `esphome.test.js`
  (Fake-Gerät `screen:true`, `startPipeline()`, `press()`; gegen den alten Code scheitern 5 von 6), `ask.test.js`.
  Released als 1.4.7. **1.4.8:** (4) Update-Entity bekommt `controls.<update>.check` (Button → `UpdateCommandRequest`
  CHECK=2; die Lib kannte `check` schon, es fehlten State + Leaf in `setSatelliteControl`), Dialog zeigt „check“ außer
  während eines Updates. (5) Entity-Art **`text`** (`ListEntitiesTextResponse`/`TextStateResponse`/
  `TextCommandRequest`): schreibbarer String-State; Länge in **UTF-8-Bytes** geprüft (die Firmware zählt
  `std::string::length()`), `pattern` als ganzer Treffer (`matchesPattern`, nicht kompilierbar = erlaubt), Modus
  Passwort wird **nicht** gespiegelt. Dialog: Textfeld schreibt nur bei Änderung, Key = Wert (Echo des Geräts wird
  sichtbar). Optionale Bildschirm-Entities in `docs/{en,de}.md` dokumentiert — weitere Namens-Absprachen mit
  Firmware-Entwicklern lieber über allgemeine Entities lösen.
  **Nach 1.4.8 (Feldbericht Waveshare `waveshare-va-eb1614`, 2026-11-05):** der Knopf ging bei pi-agent-Fragen nie —
  ESPHome **leert `wake_word_` nie** (`voice_assistant.cpp` START_PIPELINE: `msg.wake_word_phrase = wake_word_`), das
  Folge-Mikro kam mit „ioBroker“ und galt als neue Runde. Jetzt: Folge = **offene Frage** (`answersQuestion =
  now < questionUntil`, Phrase egal; `QUESTION_OPEN_MS` 30 s nach der Antwortlänge, bis die nächste Anfrage
  beantwortet ist), dann kein WAKE_WORD_END, `NO_SPEECH_FOLLOW_UP_MS`, Journal-`wakeWord` ''. Stille/leere STT
  verkürzen das Fenster nicht mehr (`max(questionUntil, now+GRACE)`). Die Firmware schickt nach dem Event sofort
  `voice_assistant.stop`: `onStopRequest` innerhalb `CONFIRM_GRACE_MS` nach dem Knopf (`buttonAt`) und ohne offenen
  Lauf → nichts tun (kein `run++`, kein zweites RUN_END, `ignoreFollowUpUntil` = 0, weil `request_stop()` das
  continue-Flag löscht); Stopp **vor** dem Event (Batching) → Frage bleibt `CONFIRM_GRACE_MS` offen.
  `ignoreFollowUpUntil` gilt jetzt unabhängig von der Phrase, wird aber nur gesetzt, wenn beim Tippen kein Mikro offen
  war und kein Stopp kurz davor kam. Tests: Fake-Gerät `startPipeline(phrase, speech)`.
  **pi-agent bekommt `satellite` + `tts`** (nur Satelliten-Anfragen: `requestOrigin.satellite` aus
  `knownSatelliteId()` = `satelliteStateId` + `satStatesEnsured`, also nicht Wyoming/Chat/Telegram), damit pi-agent
  später dort sprechen kann (`satellites.<id>.tts`). **Timer eines Satelliten per sendTo**: `setTimer {satellite,
  seconds, name, announce}` (`timerSatellite()` → `source` = Gerätename wie bei Sprach-Timern → `mirrorTimer` und
  `announceTargetForSource` greifen), `TimerInfo.announce` (persistiert, wird wörtlich gesagt, auch bei
  `timerAnnounce` aus), `listTimers`/`cancelTimer {satellite, id?}`. `seconds` als String = Sekunden, `duration`-String
  mit bloßer Zahl bleibt Minuten. main-Routing per Wegwerf-Harness geprüft, nicht am Gerät.
- **Skript-Anfragen nur an die Cloud** — `nlu.ts.mentionsScript()` (`SCRIPT_RE`: `skript` überall inkl.
  Komposita, `script` nur am Wortanfang bzw. `java|type`-Präfix — sonst „description"/„subscription" —,
  `скрипт` mit Flexion, `blockly`). `main.ts.cloudOnlyReason()` → `'script'`, oder `'scriptReply'`, wenn das
  Cloud-Modell zu einem Skript zurückgefragt hat (`scriptTopics` pro Quelle, gesetzt in `answerTracked` nur bei
  `cloudOnly && [[LISTEN]]`, sonst gelöscht, `SCRIPT_TOPIC_MS` = 2 min wie pi-agents Bestätigungs-Timeout).
  Dann überspringt `produceAnswer` Routinen/YouTube/NLU (jetzt gebündelt in `answerLocally()`) und das lokale
  LLM — auch als Fallback. Stoppwort und `askUser`-Antwort bleiben davor. Ohne Cloud-Stufe (`agent`/`piAgent`)
  greift nichts. Anlass (Journal 2026-11-02): „В каком скрипте … Старлин выключается ночью" → NLU-Query
  „Старлинк: включено", „напиши мне скрипт, который … свет на кухне каждый час" → NLU `timeQuery` (der
  Satz enthält „который … час"). Test: `nlu.test.js` (`mentionsScript`); das Routing in `main.ts` hat keinen
  Unit-Test (main wird nicht getestet).
- **Befehle für später über den Kalender (fullcalendar)** — NLU (`nlu.ts`): `parseWhen()` erkennt Verzögerung
  (`in|nach|через|after` + Dauer direkt danach, „in der Küche“ zählt nicht; `DURATION_PHRASES` kennen jetzt
  „einer halben Stunde“, „in an hour“, „через час“) und **eindeutige** Uhrzeiten (`CLOCK_RE`: „22:30“, „7 Uhr“,
  „pm“, „в 7 часов“, „halb acht“ — ein bloßes „um 3“ ist `unclear`, weil „um 3 lauter“/„um 20 Prozent“; Prozente
  werden vorher entfernt) mit `morgen/übermorgen/heute` als `at.day`. Ergebnis `NluIntent.delaySec` bzw. `.at`,
  nur für on/off/level/color. **Vorher hat die NLU „Licht in 2 Stunden aus“ sofort geschaltet** und „выключи свет
  через 2 часа“ als „который час“ gelesen. Unklar (Wochentag, „jeden Tag“, an+aus im selben Satz, Frage) → `null`
  → LLM, nie sofort. Kombi-Befehle: ein nackter Teil erbt die Zeit mit der Aktion; ist nicht jeder Teil
  verstanden, darf `parseAll` die Zeit nicht aufs Ganze anwenden (→ `[]`). `main.ts`: Config `calendarInstance`
  (jsonConfig `type:"instance"`, `adapter:"fullcalendar"`), `isDeferred()`, `nluBlocker` ohne Kalender → LLM,
  `executeDeferredIntent` → `calendarCall("addEvent", {oid, value, start: ms, name})` (auch `intent.also`),
  `writeForbidden()` = Geräte-ACL inkl. lock-Default, Antwort mit Uhrzeit (`describeWhen`), **kein** Bestätigungston.
  LLM-Tools `list_scheduled` / `schedule_state` / `cancel_scheduled` (`buildCalendarTools`, Planen nur mit
  `allowWriteStates`). Die API (`addEvent`/`deleteEvent`/`listEvents`/`getEvents`/`getCalendars`) und die
  Agenda-States `fullcalendar.0.events.*` sind **neu in fullcalendar** (`C:pWorkioBroker.fullcalendar`,
  `src/lib/agenda.ts`). pi-agent kann nicht `sendTo`, liest aber die Agenda-States. Tests: `nlu.test.js`
  (deferred…), dort `test/agenda.engine.js`. Die fullcalendar-API ist auf 129 live geprüft (3.0.6-alpha.0: Schalten zur Sekunde, Rückschalten, Agenda-States, Fehler, Löschen); der Satz über die Assistant-NLU am echten System steht noch aus.
- **OpenRouter für STT/TTS** — `src/lib/voice/openrouter.ts` (`OpenRouterStt`/`OpenRouterTts`,
  `listOpenRouterSpeechModels`, `voicesForLanguage`, `pcmFromResponse`), Sprach-Anbieter `openrouter` in
  `engines.ts` (auch als Fallback). OpenRouter hat OpenAI-kompatible `/audio/transcriptions` (Multipart; `prompt`
  wird **ignoriert** → keine STT-Hints) und `/audio/speech` (`pcm` Default, MiniMax nur `mp3` → ffmpeg über
  `EngineContext.decodeAudio`; Gemini/HeyGen nur `pcm`). PCM-Rate steht nicht in der API: Default 24 kHz, eine
  `rate=` im Content-Type gewinnt, WAV wird ausgepackt. Modelle (`?output_modalities=speech|transcription`) und
  Stimmen (`supported_voices` pro Modell; Locale-Stimmen wie `de-DE-Klaus:MAI-Voice-2` nach Sprache gefiltert)
  kommen aus der **öffentlichen** Modellliste (ohne Key, 1 h Cache) → sendTo `getSttModels`/`getTtsModels`/
  `getVoices`. Ohne Stimme nimmt die TTS die erste des Modells für die Sprache. Config `openrouterSpeechKey`
  (encrypted) / `openrouterCredentialId`, `openrouterSttModel` (Default `openai/whisper-large-v3-turbo`),
  `openrouterTtsModel` (Default `elevenlabs/eleven-flash-v2.5`), `openrouterVoice`; ohne eigenen Key der
  des LLM, wenn das OpenRouter ist. `OPENROUTER_HEADERS` (Attribution) liegt in `llm.ts`. Test:
  `test/integration/openrouterSpeech.test.js`. **Live auf 129 geprüft** (per `tts`-sendTo mit Config-Override):
  Gemini-lite und ElevenLabs Flash v2.5 liefern 24 kHz (Tonhöhe gemessen), ElevenLabs 0,8 s statt 2,5 s → Default.
  STT über OpenRouter noch nicht mit echtem Key gelaufen.
- **Stimm-/Erkennungstest im Reiter Voice** — `src-admin/src/VoiceTestComponent.tsx` (jsonConfig `_voiceTest`).
  Schickt die **Formulardaten** mit (`config: this.props.data`), `main.ts.withVoiceForm()` übernimmt nur die
  `VOICE_FORM_FIELDS`, Secrets (`VOICE_FORM_SECRETS`) nur, wenn nicht leer (protectedNative kommt nie im Browser
  an), Fallbacks aus. sendTo `tts` (`{text,language,config}` → WAV base64 + `sampleRate`/`audioMs`/`ms`) und
  **`stt`** (`{audio base64, format, language, config}` → `{text,ms,audioMs}`; WAV direkt, sonst ffmpeg). GUI:
  Mikro (nur `isSecureContext`, ScriptProcessor → 16-kHz-WAV im Browser), Datei-Upload, Rundlauf TTS→STT.
- **Ton-Bestätigung auch für die KI** — `confirmWithTone` (nur bei `voiceEnabled` sichtbar) gilt jetzt auch für
  Cloud-LLM und pi-agent: `doneHint()` (de/en/ru) steht im System-Prompt bzw. in den pi-agent-Instruktionen und
  bittet bei reinen Schaltbefehlen um nur `[[DONE]]`; `answerTracked` entfernt `[[LISTEN|DONE]]`, ist die Antwort
  dann leer → `playConfirmationTone(source)`, sonst (kein Satellit/Text-Kanal) `doneText()` („Erledigt.“).
- **Systemweite KI-Einstellungen von Admin (Provider `system`) + OpenRouter** — `src/lib/systemAi.ts`
  (`systemAiSelection`, `systemAiFingerprint`, `usesSystemAi`, `resolveSystemLlm`, `resolveLlm` → `ResolvedLlm`).
  Provider `system` (Default für **neue** Instanzen, `io-package` `native.provider`) nimmt Provider/Modell/
  `credentialId`/`baseUrl` aus `system.ai` (Admin ≥ 8.3.5, Reiter „KI“), Key immer aus dem Credential-Store.
  Gleiche Regel wie `@iobroker/ai-core` `usesSystemAiSettings`: auch eine Instanz mit Key-Provider, aber **ohne
  eigenen Key/Credential** nimmt `system.ai` (nicht `custom` — lokale Server haben oft keinen Key). Bewusst als
  **Provider**-Option statt `credentialType:'system'`: der Provider steuert hier auch none/pi-agent und die
  Sichtbarkeit der Felder. `maxTokens` bleibt die eigene (Sprachantworten). `main.ts`: `this.llm` = effektiver
  LLM (auch Log/Journal-Detail), `watchSystemAi()` abonniert `system.ai` **und** die Credential → `restart()`
  bei Änderung der vier Felder bzw. der Credential (auch wenn `system.ai` noch leer ist, damit das Einrichten
  startet). `speechLlmKey()` = `{provider, apiKey}` des effektiven LLM; `resolveVoiceCredentials(…, llm)`
  nimmt den Key für OpenAI- bzw. OpenRouter-Sprache nur, wenn der LLM vom selben Hersteller ist. Test-Button prüft im System-Modus
  `system.ai`. **OpenRouter** (`llm.ts` Preset `https://openrouter.ai/api/v1`, Default `openai/gpt-4o-mini`,
  Attribution-Header wie ai-core, `testConnection` über `/key`, weil `/models` öffentlich ist und jeden Key
  annimmt). Test: `test/integration/systemAi.test.js`.
- **Eigene Wake-Words für ESPHome-Satelliten** — `src/lib/voice/wakeWords.ts` (`prepareWakeWord`/
  `loadWakeWord`/`slugify`). Die ESPHome-API hat **keine Upload-Nachricht**: der Client listet Modelle in
  **jedem** `VoiceAssistantConfigurationRequest` (`external_wake_words`: id, Phrase, Sprachen, `model_type`,
  Größe, SHA-256, URL der JSON), das Gerät zeigt sie als verfügbar und lädt erst **beim Aktivieren** (im
  `SetConfiguration`-Handler, blockierend per curl) `<url>` → `<id>.json` und das Modell aus **demselben
  Ordner** als `<id>.tflite` (Query wird abgeschnitten). Verifiziert in der Firmware
  (`thirdreality/voice-music-assistant`, `buildroot/package/thirdreality/linux-voice-assistant-cpp/src/`
  `satellite/Satellite.cpp` `ResolveWakeWordConfig` + `audio/ExternalWakeWord.cpp`). Daraus folgt:
  nur `model_type:"micro"` (Rest wird übersprungen); das Gerät lädt das Modell aus dem `model`-Feld der JSON
  → wir **schreiben `model` auf `<id>.tflite` um**; jede ConfigurationRequest **leert** die externe Liste des
  Geräts → `esphome.ts.requestWakeWordConfig()` hängt die Angebote **immer** an (auch Handshake und
  Read-back); ein heruntergeladenes Modell ist danach **lokal** und gewinnt per id gegen das Angebot →
  die id enthält `sha256[0..8]`, sonst käme ein neu trainiertes Modell nie an; heruntergeladen = bleibt auf
  dem Gerät (keine Lösch-API), und es steht dann doppelt in `available_wake_words` (lokal + Angebot) →
  Dedupe in `esphome.ts`. Das Gerät meldet einen fehlgeschlagenen Download nicht → `configChecks`-FIFO
  vergleicht die angeforderten ids mit dem Read-back und warnt. Ablage im Dateispeicher
  `assistant.0/wakewords/<id>.{json,tflite}`, ausgeliefert vom `MediaServer` (neu: `serve`/`unserve` für
  feste Pfade, `/wakeword/<id>.…`). `main.ts`: `loadCustomWakeWords` (in `startEsphome`), `addCustomWakeWord`/
  `deleteCustomWakeWord`, sendTo `uploadWakeWord`/`listWakeWords`/`deleteWakeWord`, `availableWakeWords`-JSON
  markiert eigene mit `custom: true`. GUI: `SatelliteSettingsDialog` (Upload-Button → Phrase prüfen →
  hochladen, ✕ am Chip mit Bestätigung; bekommt dafür `sendTo` von `SatellitesComponent`). Tests:
  `test/integration/wakeWords.test.js` + Fake-Gerät in `esphome.test.js` lädt wie die Firmware herunter.
  **Am echten Gerät (2026-10-26):** Angebot → Chip → Aktivieren → das Gerät holte JSON **und** `.tflite` vom
  Media-Server — der Transportweg stimmt. Aktiv wurde das Wort trotzdem nie: der Nutzer hatte ein
  **openWakeWord**-Modell hochgeladen (Eingang `[1,16,96]` float32 — vermutlich das für den nativen Satelliten
  trainierte), und `MicroWakeWord::FromConfig` verlangt `[1, stride, 40]` mit quantisiertem Ein- **und**
  Ausgang. Ein Trick über `"type":"open"` in der ausgelieferten JSON (das Gerät wählt den Loader nach der
  JSON) hilft **nicht**: die openWakeWord-Features (`melspectrogram`/`embedding_model.tflite`) lädt `main.cpp`
  nur, wenn die Firmware mit `--wakeword-type open` startet — der ThirdReality läuft im micro-Modus.
  Deshalb prüft `microModelProblem()` jetzt beim Upload die Tensoren (`readTfliteIo`, Flatbuffer von Hand
  gelesen, keine TF-Abhängigkeit; gegen die offiziellen v2-Modelle und die echte Datei geprüft) und benennt
  openWakeWord ausdrücklich; schon gespeicherte kaputte Modelle bleiben geladen (damit ✕ sie löschen kann),
  aber `loadCustomWakeWords` warnt. Test-Modelle baut `test/integration/tfliteModel.js` (echte Flatbuffer
  statt `TFL3`+Füllbytes). ⚠️ Die vom Gerät heruntergeladene Kopie bleibt dort liegen (keine Lösch-API) und
  steht weiter in `available_wake_words` — auch nach dem Löschen in ioBroker. Ein **funktionierendes** eigenes
  microWakeWord-Modell ist am Gerät noch nicht durchgespielt.
- **Anfrage-Details zum Debuggen im Chat** — Klick auf Frage/Antwort (oder den Detailblock) öffnet
  `src-admin/src/RequestDetailsDialog.tsx`. Datenquelle ist ein **Trace pro Journal-Eintrag**
  (`journal.ts`: `JournalStep {t, ms, stage, title, level, tokens, data}`, `Journal.step()`): **nicht**
  in `journal.last`/`journal.json` (zu groß), sondern sendTo `getJournalTrace {id}` → `{entry, steps}`;
  eine Datei pro Anfrage in `<Datenverzeichnis>/journal-trace/<id>.json`, nur für die neuesten
  `MAX_TRACES` (200), im Speicher die neuesten 30; `trace(id)` prüft die id (`ID_RE`), bevor sie ein
  Dateiname wird. `data` wird beim Aufzeichnen per `snapshot()` kopiert (die Message-Liste des Modells
  wächst und `markLastMessageForCache` verschiebt Marker), Strings >100 000 Zeichen gekürzt, Buffer
  zusammengefasst. `t` = **Start** des Schritts (`ms` wird abgezogen) → STT steht bei negativem `t`.
  Aufgezeichnet: Anfrage+Herkunft, STT (Anbieter, Aufnahmelänge `audioMs`, ESPHome-VAD-Pegel), Kontext-
  Verlauf, Stopwort/Rückfrage, Routine (Treffer/kein Treffer, jede Aktion), YouTube, **NLU-Parse mit
  Intents und `nluBlocker`-Grund** (ersetzt `canExecuteNlu`), jede NLU-Ausführung, lokales LLM (Prompt,
  Rohantwort, HANDOFF/busy/Timeout, übersprungen-Grund), Prompt-Bausteine, Cloud-LLM (`LlmAgent` hat
  `trace`-Option: Eröffnung mit System-Prompt+Tool-Namen, **pro Runde nur die neu gesendeten Nachrichten**
  + Antwort + normalisierte Tokens, Fehler mit `errorInfo` inkl. API-Status/Body), Tool-Aufrufe voll
  (`Journal.toolCall`), direkte MCP-State-Aufrufe (`Journal.stateCall`; innerhalb eines Tools kein
  eigener Schritt, `toolDepth`), Ack-Prüfung, Antwort (roh mit `[[LISTEN]]`), Fehler mit Stack.
  **TTS kommt nach der Antwort**: Transporte melden per `onSpoken` (UDP/ESPHome/Wyoming, nativ direkt) →
  `main.reportSpoken` → `Journal.spoken(source, …)` hängt `ttsMs`/`replyAudioMs` an den letzten Eintrag
  der Quelle (≤2 min). Wyoming meldet nur Antworten, kein reines `synthesize`. Neue Entry-Felder
  `audioMs`, `ttsMs`, `replyAudioMs`, `tokens` (Summe). Dialog: Kopf (Herkunft, Frage/Antwort, Zeiten,
  Tokens), Tab **Ablauf** (Wasserfall-Balken, aufklappbar; LLM-Nachrichten/Content-Blöcke/`tool_calls`
  lesbar statt Roh-JSON, `cache_control` als Chip), **Tools & States**, **JSON** (kopieren/herunterladen).
  Live-Nachladen, solange der Eintrag sich ändert (max. ein Fetch gleichzeitig). Gemeinsame Typen/Labels
  in `src-admin/src/journal.ts`. Schritt-Titel kommen englisch aus dem Backend (Debug-Text).
- **pi-agent als Harness (Provider `pi-agent`)** — `src/lib/piAgent.ts` (`PiAgentHarness`, `composeInstructions`,
  `conversationOf`) + `main.ts.askPiAgent`. Statt `LlmAgent` beantwortet eine Instanz des Adapters
  **pi-agent** (`C:\pWork\ioBroker.pi-agent`, Fork `GermanBluefox/ioBroker.pi-agent`, Branch
  `system-ai-and-harness`) die Cloud-Stufe per `sendToAsync(<inst>,'ask',{text,conversation,instructions,
  requestId},{timeout})`. **Eine pi-agent-Konversation pro Quelle** (`conversation` = Satellit/`chat`/
  `telegram:<user>`, `/`→`_`, weil pi-agent `/` als Trenner im Key nutzt); die History liegt dort, der
  `ConversationStore` wird **nicht** mitgeschickt. **Instruktionen** = Systemprompt + `[[LISTEN]]`-Hinweis
  (Pflicht) + Gedächtnis + Geräteliste (optional, von hinten weggelassen bis ≤ 20 000 Zeichen = pi-agents
  Cap) — pi-agent rekonfiguriert die Konversation nur bei Änderung; Zeit/Wetter/Präsenz vor die Frage.
  Vorher `system.adapter.<inst>.alive` prüfen (sonst wartet man den ganzen Timeout), `{error}`/leere Antwort
  → Exception → lokales LLM als Fallback. `this.agent` bleibt `null` → `rephrase`/`classify`/`translate`/
  `rewordNotification` fallen wie bei `none` weg; die eigenen Tools (Timer, Memory, Announce, YouTube) hat
  pi-agent nicht. Config `piAgentInstance` (`type:"instance"`), `piAgentTimeoutSec` (Default 60).
  **In pi-agent dazu gebaut** (gleicher Branch): Key-Quelle `system` = **systemweite KI-Einstellungen von
  Admin** (`system.ai`: provider/model/credentialId/baseUrl; `gemini`→pi-ai `google`, neu als Provider),
  Default für neue Instanzen, und eine Instanz ohne eigenen Key nimmt sie auch (wie `@iobroker/ai-core`
  `usesSystemAiSettings`); Änderung dieser vier Felder → Neustart (`hideFab` u. ä. nicht). `ask` kennt
  `conversation`/`instructions` (Key `sendTo:<caller>/<conversation>` in `telegram.chats`). Tests:
  `test/integration/piAgent.test.js` hier, `test/system-ai.test.js` dort.
  **Läuft auf 129** (pi-agent 0.7.3/0.8.0, ESPHome-Satellit). **Bestätigung per Sprache** (pi-agent-Option
  „Confirmation by text in sendTo conversations", `lib/text-confirmation.js` dort): pi-agent antwortet auf einen
  bestätigungspflichtigen Schreibzugriff mit einer Frage + `[[LISTEN]]`, das nächste `ask` derselben Konversation
  entscheidet — **pi-agent** prüft per `isYes` (nur Ja-Wort), nicht das Modell. Fehler am echten Gerät (2026-11-02):
  die Frage kam in der **Systemsprache** (de: „Sag ja oder nein"), der Satellit hört in `voiceLanguage` ru →
  das deutsche „Ja" lieferte bei der STT (OpenRouter Nemotron, `language:ru`) **leeren Text** (per sendTo
  `tts`→`stt` reproduziert), der Assistant verwarf das **ohne Log** → „es passiert nichts"; mit Wake-Word wurde
  daraus „Я" → nein. Ein echtes „Да." kam als „Да да." zurück (auch nein). Fix: `askPiAgent` schickt `language`
  (`voiceLanguage || language`) mit, pi-agent fragt in der Sprache des Aufrufers (`callerLanguages` pro Key),
  `isYes` nimmt dasselbe Ja-Wort mehrfach, pi-agent loggt das Gehörte („Answer by text in …"). Leere STT wird
  jetzt bei ESPHome/nativ geloggt (`Voice Q (…): (empty)`). Nach einem pi-agent-**Neustart** mitten in der
  Rückfrage ist die Bestätigung `unavailable` (der wartende Aufrufer ist weg) — so gewollt.
- **Sprachpfad schneller (Issue #3, znyde87)** — sechs Teile, Assistant + Satelliten-Lib + Wrapper:
  (1) **NLU-Gerätemodell gecacht** (`main.ts.getNluDevices` → `nluDevices`, TTL `NLU_DEVICES_TTL_MS`=60 s,
  gleichzeitige Anfragen teilen sich den Build, leeres Ergebnis wird nicht gehalten). Vorher pro Sprachbefehl
  bis zu 3× `list_devices` + Namensauflösung je Gerät (STT-Hints, NLU, Cloud-Geräteliste) — der `ListCache`
  galt nur für die LLM-Tools. Invalidiert über `ListCache.onClear` (alle bisherigen `clear()`-Stellen).
  (2) **Rückfrage-Flag pro Quelle** (`followUps`-Map + `wantsFollowUp`/`followUpFor`) statt des geteilten
  `lastFollowUp`; ESPHome bekommt jetzt auch das `[[LISTEN]]`-Signal, **UDP** schickt `tts_end.listen`
  (im `tts_end`, damit nichts das Audio überholt) und hält `listening` mit Timer (`LISTEN_WINDOW_MS`).
  (3) **Lib `C:\pWork\assistant-satellite`** (`github.com/ioBroker/assistant-satellite`; der alte Pfad
  `C:\iot\…` existiert nicht mehr): UDP-`Satellite` kennt `listen`/`tts_end.listen` (Follow-up-Fenster
  wie `LocalListener`, ohne Stille an STT zu streamen, `maxFollowUps`, Ansagen zählen nicht als Antwort) und
  `volume` (absolut/relativ, Software-Gain quadratisch, meldet `{type:'volume',level}` zurück; Host-Hooks
  `onVolume`/`mixerVolume`, `setVolume()`). **Noch nicht veröffentlicht** — Wrapper braucht Lib 0.2.0.
  **Barge-in im ioBroker-Transport** (Nutzerwunsch 2026-11-04, Branch `feat/barge-in-local` in der Lib,
  `feat/barge-in` im Wrapper `ioBroker.assistant-satellite`, nicht committet): `LocalListener` wertet das Mikro
  jetzt auch während `processing`/`speaking` aus (`endRecording` wartet die Antwort nicht mehr ab, `answer()`
  mit `turn`-Zähler) — Wake-Word stoppt die Wiedergabe bzw. verwirft die noch kommende Antwort und nimmt neu
  auf. `bargeIn` (Default an), `bargeInThreshold` (Schwelle während der Wiedergabe, 0 = gleich), Hook
  `onWakeWord` (Wrapper stoppt damit Durchsagen), `onUtterance` liefert `text` → eine Antwort, die das Wake-Word
  selbst sagt („ioBroker“ bei `io_broker`), unterbricht sich nicht (`wakePhrases`/`saysWakeWord`). Test:
  `test/bargeIn.test.js` in der Lib (Fake-Mic/-Modell/-Wiedergabe; gegen 0.1.7 scheitern 7 von 9). Ohne AEC hört
  das Mikro die Antwort mit — nicht am echten Gerät geprüft. **ESPHome-Geräte** können das schon in ihrer
  Firmware: ThirdReality (`Satellite.cpp`: Wake-Word während TTS → Stopp + neue Runde, eingebautes
  microWakeWord-„stop“ mit Entity `stop_word_sensitivity`, Tippen), Voice PE („stop“ ab 1 s TTS, Wake-Word
  stoppt). Unser `onPipelineRequest` verwirft dabei die alte Antwort (`run`-Zähler).
  (4) **Lokales LLM = Fallback**, wenn ein Cloud-Provider da ist (`localLlmFirst` stellt es wieder davor);
  `localLlmTimeoutSec` (Default 15) bricht per `AbortSignal` ab, `threads` = Kerne−1, max. 256 Tokens,
  parallele Fragen → `HANDOFF` statt Warten. (5) NLU-Intent **`volumeSet`** („lauter/leiser/Lautstärke 5",
  1–10 = Zehnerschritte) → Satellit der Anfrage bzw. des Raums: nativ `<instanz>.volume`, ESPHome
  Media-Player, UDP `volume`-Nachricht + State `satellites.<id>.volume`. (6) NLU-Intent **`weatherQuery`**
  (nur bei `weatherInstance`; heute/morgen/übermorgen; andere Orte/Wochentage → LLM) →
  `weather.ts.buildWeatherAnswer` (de/en/ru, WMO-Texte übersetzt). Nebenbei gefixt: `ALARM_RE` matchte
  `буд…` → „будет" war eine Wecker-Abfrage. Nicht übernommen aus dem Issue: Persona, `everyday.js`,
  gelernte Skills, Vosk-Reparatur (eigenes Design nötig).
- **YouTube auf dem Fernseher** — `src/lib/youtube.ts` + `main.ts` (`playYouTube`, `buildYouTubeTools`).
  Abspielen über den Adapter **`youtube-remote`** (`C:\pWork\ioBroker.youtube-remote`, Lounge-API): dessen
  State `<gerät>.youtube` nimmt Video-ID/`PL…`/`UC…` (= Uploads des Kanals)/URL und **ackt erst, wenn der TV
  den Befehl angenommen hat** (zurück auf `''`), bei Fehler bleibt er unbestätigt → darauf warten wir
  (`sendToYouTubePlayer`, 8 s). Namen → ID kann youtube-remote nicht; die **Suche liegt hier** und nutzt
  **InnerTube** (`POST youtube.com/youtubei/v1/search`, `params` = Filter Kanal/Video/Playlist) — ohne API-Key
  und ohne Quota (Data API: 100 Einheiten/Suche). Undokumentiert, deshalb läuft `parseSearchResults` rekursiv
  über die ganze Antwort und sucht nur die Renderer (`channelRenderer`/`videoRenderer`/`playlistRenderer`/
  `lockupViewModel` — Playlists sind schon umgezogen); `pickBest` nimmt exakten Titel (vor „ | ") oder
  Handle, sonst YouTubes ersten Treffer. Live geprüft: „Sailing OceanAir" → `UCbmF2AHnpQsogOLW-MxBiJg`.
  Config-Tabelle `youtubePlayers` (Name, Player = **Instanz** per `selectSendTo` `getYouTubeInstances` — das
  Gerät wird zur Laufzeit gesucht (`resolveYouTubePlayer`/`pickDevice`, vor **jedem** Befehl), weil die
  Geräte-Id aus der Screen-Id kommt und sich beim Neu-Koppeln ändert; bei mehreren TVs pro Instanz bietet die
  Liste auch die Geräte einzeln an —, Power-State optional, Raum,
  Startverzögerung Default 8 s); **erste Zeile = Standard**, sonst der Player im Raum der Anfrage
  (`requestOrigin` = `AsyncLocalStorage` in `answer()`, weil LLM-Tools nur die Modell-Argumente sehen).
  **Suche vor dem Einschalten** (kein TV für einen nicht existierenden Kanal wecken). TV aus → einschalten,
  **sofort antworten**, Rest im Hintergrund (`playWhenTvIsOn`: auf `ack:true`+an warten — unser eigener
  Write sagt schon `true` —, max. 30 s, dann Startverzögerung, ein Retry). Ein Power-State, der eine
  **Taste** ist (`role button*`/`read:false`), wird **nie gedrückt** (würde einen laufenden TV ausschalten).
  Lokaler Parser `parseYouTubeCommand` (de/en/ru, braucht Art-Wort Kanal/Video/Playlist **oder** „YouTube",
  Player nur mit Präposition davor abgeschnitten — am Ende **und** direkt nach dem Verb, „im <Ort>" auch
  unbekannt → ehrliche „Player kenne ich nicht"-Antwort; ohne Art-Wort `kind:auto` = erst Kanalsuche, ein
  Kanal mit `similarName` (Leerzeichen egal, Editierdistanz ≤ Länge/8, weil STT „Ocean Air" statt
  „Oceanaire" schreibt) gewinnt, sonst Videosuche — am echten Gerät aufgefallen, Test mit dem Originalsatz) läuft im `useLocalNlu`-Block **vor** der Geräte-NLU.
  LLM-Tools `play_youtube` + `youtube_player` (play/pause/next/previous/volume/mute/status), sendTo
  `playYouTube`. Gated über `allowWriteStates`. Test: `test/integration/youtube.test.js`.
  ⚠️ Noch nicht am echten TV durchgespielt (Instanz `youtube-remote.0.tv_8198d994` +
  `samsungtv.0.samsung-the-frame-55.control.power` existieren).
- **Gesprächs-Journal im Chat-Tab** — `src/lib/journal.ts` (`Journal`): ein Eintrag pro beantworteter
  Anfrage **aus jeder Quelle** (Chat, Skript, `text.request`, Telegram, ESPHome/UDP/nativ/Wyoming) mit
  Satellit, Raum, **Wake-Word** (`''` = Mikro ohne Wake-Word wieder geöffnet), STT-Dauer, **Stufe**
  (`stop|askReply|routine|nlu|localLlm|cloud|none` + `detail` = NLU-Actions/Routine/Modell), Tool-Calls
  (Args, gekürztes Ergebnis, ms) und gelesenen/geschriebenen **State-IDs**. Zuordnung per
  **`AsyncLocalStorage`** — `answer()` öffnet den Eintrag (`journal.run`), `produceAnswer` setzt die Stufe
  per `journal.note`, die MCP-Verbindung ist in `journalMcp()` umhüllt (`get_states`/`set_state(s)` →
  `stateAccess`), jedes LLM-Tool in `journalTool()`; außerhalb eines Requests (Trigger) wird nichts
  aufgezeichnet. Wake-Word/STT-Zeit liefern die Transporte über ihren `answer`-Callback (`esphome.ts`
  merkt sich die Phrase in `Capture.wakeWord`; native `voice`-sendTo nimmt optional `wakeWord`). Live:
  State `journal.last` (JSON) wird beim Start **und** Ende jeder Anfrage (und bei jedem Tool-Call)
  geschrieben, der Chat abonniert ihn. Persistenz `journal.json` im Instanz-Datenverzeichnis (5 s
  debounced + `flush` in `onUnload`), Retention Config `journalHours` (Default 24, max 168, **0 = aus**
  → Datei wird gelöscht, Chat fällt auf den alten lokalen Test-Chat zurück), Hardcap 3000 Einträge.
  sendTo `getJournal` (`{since?}` → `{enabled, entries}`) / `clearJournal`; `ask` antwortet zusätzlich
  mit `journaled`, damit der Chat seinen eigenen Austausch nicht doppelt zeigt.
  `ChatComponent.tsx`: Zeitleiste aus Journal + lokalen Hinweisen, Herkunfts-Chips über der Frage,
  Detailblock unter der Antwort (Stufe farbig, Modell, Dauer, 🔧 Tools, 📖 gelesen, ✏️ geschrieben;
  ein-/ausblendbar, gemerkt in `localStorage`), Quellen-Filter, Löschen mit Bestätigung.
  Test: `test/integration/journal.test.js`.
- **Belegte Ports an js-controller 8 melden** — `common.declareUsedResources: true` + `main.ts.declarePort()`
  nach jedem erfolgreichen Server-Start: UDP-Satelliten (`udpPort`, family 4), Wyoming (`tcpPort`),
  ESPHome-Media-Server (`tcpPort`, tatsächlich gebundener Port). **Ohne das Flag** leitet der Controller aus
  `native.port` (7775) einen *TCP*-Port ab — falsch (UDP) und meist gar nicht offen. Wildcard-Bind wird nicht
  mitgeschickt (= alle Adressen). Gated über `supportsFeature('CONTROLLER_USED_RESOURCES')`, Cast, weil
  `@iobroker/types` 7.2.2 die API noch nicht kennt; Fehler nur `debug`. Kein Freigeben beim Stop nötig (Host
  macht das). Doku: `ioBroker.js-controller/docs/used-resources.md`.
- **Quick Wins aus dem Hannah-Abgleich (alle zehn)** — vier neue Module plus Erweiterungen:
  - `src/lib/voice/ttsCache.ts` — `CachedTts` umhüllt **jede** TTS-Engine (in `engines.ts.createTtsEngine`,
    damit Satelliten, Durchsagen, Test-Chat und `tts`-sendTo dasselbe Verhalten haben): Plattencache
    (Verzeichnis pro Anbieter+Stimme, Sample-Rate im Dateikopf → nie falsche Tonhöhe, Key =
    sha256(lang+text), nur Texte ≤200 Zeichen — lange Einmal-Antworten füllen sonst die Platte —, LRU-Prune
    auf 64 MB), `truncateForTts` (Config `ttsMaxChars`, Default 400, 0 = aus — über `EngineContext.ttsMaxChars`;
    aufgefallen als „Satellit hört nach ~30 s auf“: im Journal hatte eine 1900-Zeichen-Antwort von pi-agent
    `replyAudioMs` 20 784; Schnitt am letzten passenden Satzende; SSML wird nie geschnitten). Dazu
    **Längenhinweis an das Modell** nur bei Sprach-Anfragen (`requestOrigin.voice` aus
    `VOICE_TRANSPORTS` esphome/udp/native/wyoming, `main.spokenLengthHint()` → `ttsCache.spokenLengthHint`
    de/en/ru, Grenze auch als Satzzahl, keine State-IDs/Seriennummern): Cloud-LLM im **User-Turn** hinter
    der Frage (System-Prompt wäre bei Wechsel Sprache/Text ein Cache-Bust), pi-agent in den Instruktionen
    (Konversation pro Quelle → stabil). Lokales LLM nicht (256 Tokens Cap). und SSML-Routing. `TtsEngine` hat dafür optionale `synthesizeSsml`/`warm`-Hooks;
    `azure.ts` (`speakSsmlAsync`) und `aws.ts` (`TextType:'ssml'`) implementieren SSML nativ, alle anderen
    bekommen `stripSsml()` statt vorgelesener Tags.
  - `src/lib/voice/fallback.ts` — `FallbackStt`/`FallbackTts`: eine zweite Engine bei Ausfall (Config
    `sttFallback`/`ttsFallback`, typisch Vosk/Piper hinter der Cloud). **Fallback außen, Cache innen**,
    sonst landet die Reserve-Stimme im Cache der Hauptstimme; Preis ist ein fehlgeschlagener Erstversuch pro
    Äußerung während einer Störung. Jeder Fehler eskaliert (Provider-Fehler zu klassifizieren wäre Raten
    über drei SDKs). `prepare()` bereitet beide vor, `warm()` nur die primäre.
  - `src/lib/voice/tone.ts` — `confirmationTone()` (Sinus, 1318 Hz, 300 ms, schneller Attack + exp. Decay,
    deterministisch). `main.ts.playConfirmationTone()` spielt ihn auf dem Ursprungs-Satelliten statt einer
    gesprochenen Bestätigung; nur bei Voice-Quelle, nur bei reinen Control-Intents (`CONTROL_ACTIONS`), nur
    wenn nichts fehlschlug. Config `confirmWithTone`, **Default aus** (ändert vertrautes Verhalten).
  - `src/lib/routines.ts` — Phrasen-Makros („Gute Nacht" → mehrere Aktionen + feste Antwort). Matching mit
    **Wortgrenzen** (`licht` darf nicht von „Lichtschalter" ausgelöst werden), Normalisierung inkl.
    Umlaut-Faltung, **längste** passende Phrase gewinnt. Läuft in `produceAnswer` **vor** Tier 0, weil ein
    aufgeschriebenes Makro nicht umgedeutet werden darf. Teilt `runTriggerAction` mit den Triggern (eine
    Routine *ist* ein Trigger mit Phrasen-Bedingung) — dafür hat der Executor einen `fallbackTarget` für
    „sag es da, wo gefragt wurde". Config-Tabelle `routines`.
  - **Ack-verifizierte Steuerung** — `main.ts.writeConfirmed()` pollt nach `set_state` alle 150 ms bis 2 s
    auf `ack:true` (Poll statt temporärer Subscription: billiger als jeden Befehl durch `onStateChange` zu
    routen). `valuesMatch()` vergleicht tolerant (`true`↔`1`, 30↔30.0, 100 %↔99 %), sonst meldet ein Dimmer
    Fehlschlag, der getan hat was er sollte. Config `verifyWrites`, **Default aus** — Adapter ohne `ack`
    (MQTT, Skripte, `0_userdata`) ließen sonst jeden Befehl fehlgeschlagen aussehen.
  - **Kategorie-Abfragen in der NLU** — neue Action `categoryQuery` + `CATEGORY_WORDS` (de/en/ru) →
    type-detector-Typen; `main.ts.executeCategoryQuery()` liest alle Sensoren der Art (optional
    raumgefiltert), `iaqLabel()` gibt der Luftqualitätszahl ein Wort (BME680/BSEC-Skala), `CATEGORY_LABELS`
    die Überschrift. ⚠️ **Wortliste geht von spezifisch nach allgemein**: `wordInText` stemmt (muss es für
    de/ru-Flexion), also matcht `luft` auch „Luftdruck"/„Luftfeuchtigkeit" — die Compound-Kategorien stehen
    deshalb **vor** der `luft`-Kategorie. Ein **genannter Gerätename gewinnt** (Aufruf erst, wenn
    `findDevice` nichts fand).
  - **ESPHome-Sensoren** — `esphomeEntities.ts` kennt jetzt `sensor`/`binarySensor`/`textSensor`
    (read-only, `missing_state` ≠ 0, `accuracyDecimals` als `decimals` an der Entity); `main.ts` legt sie
    als read-only States unter `satellites.<id>.controls.*` an, Rolle aus der Einheit (`sensorRole()`).
  - **Warm-Phrasen** ohne neues Config-Feld: `FIXED_REPLIES` (de/en/ru) wird nach `prepare()` in den Cache
    vorsynthetisiert; alles andere landet beim ersten Gebrauch dort.
  - Nebenbei: Timer-/Wecker-**Ansage** umgeht DND jetzt auch (der Jingle tat es schon — man hörte den Gong
    und dann Stille).
- **Durchsage-Ziele: Gruppen + Personen (Hannah-Port B2)** — `src/lib/targets.ts` (`parseTargetRows`,
  `findTarget`, `isBroadcast`, `describeTargets`). **Eine** Config-Tabelle `announceTargets`
  (Name, Mitglieder kommagetrennt, `kind: group|person`) für beides — mechanisch ist Gruppe und Person
  dasselbe („ein Name steht für eine Menge Satelliten"), `kind` sagt nur dem LLM, ob es ein Ort oder ein
  Mensch ist. Hannah braucht dafür zwei DB-Tabellen + n:n-Pivot, hat aber auch die Nutzer-Registry.
  **Keine** `satellites.<id>.group`/`.person`-States: Satelliten werden dynamisch entdeckt, ihre State-Id
  *ist* der Raumname, und die Zuordnung ist Konfiguration — die Tabelle deckt außerdem alle drei
  Transporte ab, Spalten in `esphomeDevices` hätten nur ESPHome erfasst.
  `main.ts.resolveTargets(name)` → `null` (alle) | `string[]` | `[]` (unbekannt; bei `askUser` ein Fehler,
  bei einer Durchsage eine Warnung). **Reihenfolge von Hannah** (`core/main.py:717`): konkreter
  Satellit/Raum **vor** Gruppe, sonst macht eine Gruppe mit Raumnamen dessen Lautsprecher unerreichbar.
  `announceToSatellites` löst jetzt selbst auf (alle Aufrufer übergeben weiter einfach einen Namen),
  synthetisiert **einmal** und liefert dann pro Mitglied via `deliverPcm`. `askUser` armt mehrere Keys
  (`PendingQuestions.ask(keys[])` konnte das schon) → Frage an eine Gruppe, erste Antwort gewinnt.
  **Neues LLM-Tool `announce`** (`buildAnnounceTool`, nur bei `voiceEnabled`): das Modell konnte schalten
  und lesen, aber keinen Lautsprecher sprechen lassen — „sag Denis, dass das Essen fertig ist" wäre sonst
  nur aus Skripten gegangen; die konfigurierten Namen stehen per `describeTargets()` in der
  Tool-Beschreibung. Test: `test/integration/targets.test.js`.
- **Präsenz „wer ist zuhause" (Hannah-Port B1)** — `src/lib/presence.ts` (`PresenceTracker`,
  `interpretHome`, `parsePresenceRows`, `buildPresencePrompt` de/en/ru). **Bewusst kein
  `residentsInstance`-Mapper:** der residents-Adapter hat keinen Typ im `@iobroker/type-detector` (der kennt
  `motion`/`location`, aber kein `presence`) und Hannahs Kern kennt die State-Ids nicht (die liegen in ihrem
  Adapter-Submodul) — ein geratenes Layout hätte stillschweigend nie gematcht. Stattdessen **Config-Tabelle
  `presence`**, in der der Nutzer auf seine eigenen States zeigt (State-Id, Name, Art `person|guest|pet`,
  optionaler `homeValue`): funktioniert mit residents-Adapter, `ping.0.<handy>.alive`, Router-Client-State
  oder eigenem Flag gleichermaßen. Numerische Vorgabe `1 = zuhause` folgt Hannahs `HOME_PRESENCE_STATE`
  (dort global konfigurierbar, hier pro Zeile). Ein **nicht verstandener Wert bleibt „unbekannt"** statt
  „abwesend" (gleiche Linie wie `unless` bei den Triggern), und der **erste** gelesene Wert feuert nie
  Ankunft/Abgang — sonst grüßt der Assistent nach jedem Neustart. Pets zählen nicht für `anyoneHome`.
  `main.ts`: `setupPresence` (eigene `subscribeForeignStates` + einmaliges Lesen, weil Präsenz-States nur
  bei Änderung melden), `renderPresence`, `buildPresenceContext()` (in den **User-Turn** beider LLM-Tiers,
  nicht in den gecachten System-Prompt), `emptyHouse()`. States
  `presence.{anyoneHome,count,list,lastArrival,lastDeparture}`. **Gate:** `announceToSatellites(…,
  {onlyWhenHome})` — geprüft **vor** der TTS-Synthese — und `notify({onlyWhenHome:true})`; „nichts
  konfiguriert" heißt dabei **nicht** „niemand da", sonst verstummt alles. Ankunft/Abgang brauchte **keinen
  neuen Code**: ein Trigger (A2) auf `assistant.0.presence.anyoneHome` ist die Begrüßung, `also` darauf das
  Gate für jeden Trigger. Routing in `onStateChange` liegt wie bei den Triggern **vor** dem `ack`-Filter.
  Test: `test/integration/presence.test.js`. Nicht übernommen: Hannahs Mood-Level und das Zurückschreiben
  der eigenen Präsenz (beides hängt an ihrer Nutzer-Registry).
- **Gesprochene Systemmeldungen + „Nicht stören" (Hannah-Port A3)** — `src/lib/notifications.ts`
  (`parseSeverity`/`toneFor`/`bypassesDnd`/`cleanupNotificationText`/`flattenNotification`). Severities sind
  **ioBrokers eigene** `info|notify|alert` (aus `ioBroker.NotificationCategory`) plus unser `direct`
  (= wörtlich sprechen, kein LLM). `LlmAgent.rewordNotification()` macht aus dem Log-Text einen gesprochenen
  Satz im Ton der Severity; der Prompt trägt Hannahs erprobte Hinweise (Versionsnummern vs.
  `M/D/YYYY`-Zeitstempel, `system.host.X: adapter.0:`-Präfixe weglassen, leeres `{}` ist kein Fehler) —
  `rephrase` (Trigger) und `rewordNotification` teilen sich nur `complete()`, **nicht** den Prompt.
  `main.ts.notify()` (+ `handleSystemNotification()` für `sendNotification`), States
  `notify.{text,alert,last}`; Config `notifyRephrase` (Default **an** — der Text kommt aus einer Maschine,
  anders als bei Triggern). sendTo `notify` (`{text,severity,target|room}` → `{spoken}`) und
  `sendNotification`; `io-package.json` meldet `common.supportedMessages.notifications` an, womit der
  Adapter im **notification-manager** als Ausgabe wählbar ist (gesprochene Systemmeldungen gibt es so noch
  nicht). ⚠️ Die Payload-Form von `sendNotification` ließ sich hier nicht verifizieren (gehört dem
  notification-manager, nicht in `@iobroker/types`) — `flattenNotification` parst defensiv und fällt auf
  Kategorie+Beschreibung zurück; beim ersten echten Lauf prüfen.
  **DND setzt jetzt der Adapter durch, für alle drei Transporte** (vorher nur der native Satellit selbst):
  States `dnd` (global) + `satellites.<id>.dnd`, Felder `globalDnd`/`dndById`, Prüfung in `deliverPcm` über
  `silenced()`/`isDeviceSilenced()`. Deshalb adressiert `deliverPcm` UDP/ESPHome **pro Gerät statt per
  Broadcast** — sonst schaltet ein stummer Satellit alle anderen mit stumm. `alert` und das `!`-Prefix
  umgehen DND; Antworten auf eigene Fragen sind nie betroffen.
  `announceToSatellites(value, targetId, {listen, priority})` — dritter Parameter jetzt Options-Objekt.
  Test: `test/integration/notifications.test.js`. Nicht übernommen: Hannahs Telegram-Push an Nutzer mit
  `system_messages=true` (wir haben keine Nutzer-Registry).
- **Rückfrage-API (Hannah-Port A1)** — `src/lib/ask.ts` (`PendingQuestions`: eine Frage wird für eine oder
  mehrere **Quellen** scharf gestellt — Gerätename, `chat`, `telegram:<user>`, oder `ANY_SOURCE` bei
  Broadcast —, die nächste Äußerung dieser Quelle wird als Antwort zugestellt, Timeout → `null`).
  Abgefangen in `produceAnswer()` **vor** allen Tiers (die NLU würde ein bloßes „ja" sonst als eigenen
  Befehl lesen) und **nach** dem Stop-Wort-Check. `main.ts.askUser()` + sendTo `askUser`
  (`{question, room|target|source, timeoutMs}` → `{answer}`/`{timeout}`/`{error}`); Mikro-Öffnen über ein
  `listen`-Flag durch `announceToSatellites`→`deliverPcm` in **alle drei** Transporte: ESPHome
  `start_conversation` (eine Nachricht, Gerät spielt + öffnet selbst), UDP neue additive Control-Nachricht
  `{type:'listen'}` + `VoiceServer.listen()`, native das Flag im `announce`-Message. Scharf gestellt wird
  **nach** der Durchsage (vorher könnte eine zufällige Äußerung die Frage „beantworten", und antworten kann
  das Gerät ohnehin erst, wenn es die Frage gespielt hat). Nebenbei gefixt: der UDP-Zweig von `deliverPcm`
  zählte eine Durchsage auch ohne registrierten Satelliten als zugestellt. Vorbild: Hannah
  `core/main.py:972` `_ask_fn`/`:990` `_try_answer_pending`. Test: `test/integration/ask.test.js`.
- **Proaktive Trigger (Hannah-Port A2)** — `src/lib/triggers.ts` (`TriggerEngine` + `parseTriggerRows`).
  State- und Zeit-Trigger: `when` als Dict **oder** Liste (ODER), `value`/`above`/`below`, `time`+`days`
  (0=So…6=Sa wie `alarms.ts`), `also`/`unless`, `cooldownSec` (Default 3600), `delay` (`90s`/`30m`/`5h`/`2d`)
  + `cancelWhen`, `actions` (`say`/`setState`) und **`ask` + `onResponse`** (LLM klassifiziert die Antwort
  per `LlmAgent.classify()` gegen `match`, erste Treffer-Regel gewinnt, Regel ohne `match` = Fallback).
  Semantik 1:1 aus Hannah `core/hannah/trigger_engine.py` übernommen, inkl. der teuer erkauften Ecken:
  Feuern nur beim **Übergang** in die Bedingung, `also` mit unlesbarem State **blockt**, `unless` mit
  unlesbarem State **blockt nicht**, und der Cooldown wird beim *Start* genommen (sonst stapeln sich
  Auslösungen während eines langen Delays). **Kein Poll-Loop** (Hannah tickt 1×/min): Zeit-Trigger feuern
  per eigenem `setTimeout` auf `computeNextFire()` aus `alarms.ts`. Delays laufen **nicht** über den
  `TimerManager` — ein interner 5-h-Delay hätte sonst als Nutzer-Timer in `timers.count` gestanden.
  `prime()` liest beim Start alle beobachteten States einmal, sonst feuert ein Gerät, das seinen
  unveränderten Wert zyklisch wiederholt, nach jedem Adapter-Start. `main.ts`: `setupTriggers`
  (abonniert per `subscribeForeignStates` **nur** die referenzierten IDs, nie Wildcards),
  `renderTriggers`/`ensureTriggerObject`, `executeTrigger`/`askTrigger`/`runTriggerAction`/`triggerText`.
  **Routing in `onStateChange` liegt vor dem `state.ack`-Filter** — Geräte melden mit `ack:true`, genau
  darauf reagiert ein Trigger (dieselbe Falle wie Hannahs `AgentWatchMore`). **Definition = Config**
  (jsonConfig-Tab „Trigger", `when`/`onResponse`/`actions` als JSON-Spalten), **Status = States**
  (`triggers.{count,list,lastFired,enabled}` + `triggers.items.<id>.{name,lastFired,nextFireAt,
  pendingUntil,enabled,fire}`; `triggers.list` persistiert `enabled`/`lastFired` über Neustarts).
  `setState` einer Aktion respektiert `allowWriteStates`. sendTo `listTriggers`/`fireTrigger`/
  `setTriggerEnabled`. Test: `test/integration/triggers.test.js` (29). Offen: No-Code-Editor als Custom
  Component statt JSON-Spalten.
- **ESPHome-Sprachsatelliten (4. Transport)** — `src/lib/voice/esphome.ts` (`EsphomeSatellites` +
  `EsphomeConnection`), `esphomeProto.ts` (Plain-Text-Framing + Message-Registry aus der `api.proto` von
  `@2colors/esphome-native-api`), `mediaServer.ts`, `vad.ts`. **Umgekehrte Richtung als UDP/Wyoming: der
  Adapter ist Client** — die Geräte (ThirdReality Voice & Music Assistant, HA Voice PE,
  linux-voice-assistant) sind Server auf TCP 6053. Zwei Eigenheiten, beide aus den Firmware-Quellen
  (`linux-voice-assistant-cpp/src/satellite/Satellite.cpp`) verifiziert: (1) **die Geräte haben kein
  eigenes VAD** und streamen, bis der Server `STT_VAD_END`/`STT_END` schickt → Sprachende-Erkennung liegt
  bei uns (`vad.ts`, Energie-Gate); (2) **TTS wird als URL geliefert**, nicht als Stream — das Gerät holt
  sie per HTTP und spielt sie mit mpv → daher `mediaServer.ts` (In-Memory-Clips, Token, TTL). Ansagen
  laufen über `VoiceAssistantAnnounceRequest{media_id}`; `deliverPcm` hat dafür einen dritten Zweig.
  Config: `esphomeEnabled`, `esphomeDevices` (Tabelle ip/port/room/password), `esphomeMediaPort`,
  `esphomeMediaHost`, `esphomeSilenceMs`. **Nicht** die `Connection`/`FrameHelper` des npm-Pakets nutzen:
  deren id↔type-Tabelle lässt den VoiceAssistant-Bereich (89–92, 106, 115, 119–123) aus und bleibt bei
  unbekannter id hängen, ohne den Lesepuffer weiterzuschieben. Test: `test/integration/esphome.test.js`
  (Framing, VAD, Media-Server, kompletter Pipeline-Loopback gegen ein Fake-Gerät).
  **✅ Gegen echte Hardware verifiziert** (2026-09-26, ThirdReality Voice & Music Assistant
  `3RSPK-A8E29151F889`, Linux Voice Assistant, ESPHome 2025.9.0, FW 1.02.03, 192.168.1.195):
  Handshake (`usesPassword:false`, `apiEncryptionSupported:false` → Plain-Text stimmt),
  `voiceAssistantFeatureFlags:61` = VOICE_ASSISTANT|API_AUDIO|TIMERS|ANNOUNCE|START_CONVERSATION,
  aktives Wake-Word `okay_nabu` (max. 2). Unsere Registry dekodierte jede Nachricht des Geräts — auch
  die, die `@2colors` nicht kennt (107 `ListEntitiesEventResponse`, 117 `UpdateStateResponse`, 120/122).
  Verifiziert: Announce-Pfad (Gerät holt den Clip vom `mediaServer`, `AnnounceFinished{success:true}`),
  Wake-Word → `VoiceAssistantRequest{start,wake_word_phrase:"okay_nabu"}` → `VoiceAssistantAudio` (16 kHz,
  ~2,8 s, Peak RMS 20103) → unser `vad.ts` schloss die Äußerung nach 900 ms Stille → Antwort-URL wurde
  geholt und gespielt. Der Wake-Trigger war dabei ein **Fehlauslöser** (niemand stand vor dem Gerät) —
  für den Protokollpfad zählt er, ein gezielter Sprechtest mit echtem STT steht noch aus. Auch der Mic-Weg
  **ohne** Wake-Word ist bestätigt: `VoiceAssistantAnnounceRequest{start_conversation:true}` öffnet das
  Mikrofon (Feature-Flag 32) — praktisch zum Testen, wenn niemand „Okay Nabu" sagen kann.
  Reconnect/Keepalive liefen über ~40 min ohne Abriss. **Zwei Mess-Fallen** (beide geprüft, KEIN Bug — nicht erneut hinterherjagen):
  (1) `MediaPlayerStateResponse{state:2}` kommt ~0,8 s **nach** dem tatsächlichen Playback-Start
  (mpv-Startup), daher wirkt `state:2`→`AnnounceFinished` bei kurzen Clips wie ein Abbruch — der Versatz
  ist konstant (1 s⇒239 ms, 3 s⇒2207 ms, 6 s⇒5183 ms, 10 s⇒9194 ms), die Clips laufen vollständig, und
  16/22,05/24/44,1/48 kHz verhalten sich identisch. (2) Im Pipeline-Pfad meldet die Firmware
  `AnnounceFinished{success:false}`, obwohl korrekt abgespielt wurde — harmlos, wir gehen unabhängig vom
  Flag auf `idle`.
  **Antwort-Stufe real gegengetestet** (Anthropic, `claude-sonnet-5`, Tool-Loop gegen ein Fake-Haus):
  Frage→Tool→Antwort→Wiedergabe lief dreimal sauber durch, inkl. echtem `set_state`-Schreibzugriff;
  3,2–4,4 s pro Runde, davon fast alles LLM (`claude-haiku-4-5` war im Vortest 819 ms statt 1786 ms —
  für Sprache die bessere Wahl). Ungeprüft bleibt nur noch der Lauf mit **echten** STT/TTS-Engines
  (Anthropic hat keine Speech-API; dafür braucht es OpenAI/Azure/AWS oder lokal Vosk/Piper).
  **VAD an dieses Gerät angepasst** (aus 4 echten Aufnahmen, `vad.ts` + `esphome.ts`): Das Gerät hört
  seinen eigenen Wake-Ack-Chirp mit — Vollausschlag, RMS ~19k, geclippt, Abfall bis ~550 ms —, während
  die Sprache danach nur RMS 358–469 hat. Mit den alten Fixwerten (`startLevel` 700/`endLevel` 400)
  setzte **immer der Chirp** `sawSpeech`, nie die Stimme: die „nur Stille → verwerfen"-Prüfung war tot
  und jeder Fehlauslöser ging an die STT-Abrechnung; zugleich lag die halbe echte Sprache unter
  `endLevel`, was mitten im Satz abschneiden konnte. Jetzt: `skipMs` (ESPHome: **600 ms**, per Sweep
  als kleinster Wert bestimmt, der Chirp-only verwirft und in allen 4 Aufnahmen die Sprache noch
  erkennt) hält den Chirp aus der **Analyse** (Audio geht unverändert an STT), und `adaptive: true`
  leitet die Schwellen aus einem verfolgten Rauschboden ab (Start bei 0 = empfindlich, fällt sofort,
  steigt nur mit `NOISE_RISE`, und **steigt gar nicht mehr, sobald Sprache erkannt ist** — sonst zieht
  eine lange Äußerung `endLevel` auf ihr eigenes Niveau und schneidet sich selbst ab). Ergebnis gegen
  die echten Aufnahmen: Fehlauslöser wird jetzt verworfen, Sprache überall erkannt, Schließzeit nur
  +30…120 ms, Rauschboden 5–6, Gate 250/150. ⚠️ Beim Ändern dieser Werte immer gegen echte Captures
  prüfen, nicht nur gegen `micFrame()` — das Fake-Gerät im Test sendet jetzt bewusst erst `chirpMs`
  Chirp und dann Sprache, weil es sonst die Realität nicht abbildet.
  **Sprachschwelle pro Gerät** (2026-11-03, Feldbericht „Handy-Alex“): ein Handy mit Satelliten-App
  (kein Chirp, Rauschunterdrückung → digitale Stille, Rauschboden 0) liefert normale Sprache mit
  **Peak RMS ~190** → das Minimum 250 ließ nur lautes Sprechen direkt am Telefon durch. Neue Spalte
  `speechLevel` in `esphomeDevices` (`speechLevelOf()`, leer = `DEFAULT_SPEECH_LEVEL` 250) setzt
  `minStartLevel`, `minEndLevel` = 0,6× (Verhältnis 250/150). `SpeechDetector.analysedPeak` = Peak
  **ohne** den Chirp-Vorlauf; liegt er beim Verwerfen ≥ 40 % des Gates, loggt `finishCapture` auf
  **info** mit Wertvorschlag (≈0,6× Peak) statt nur „nothing but silence“ auf debug.
  **Abbruch ohne Sprachbeginn** (`SpeechDetector.startTimeoutMs`, Verdict `'no-speech'`, gezählt ab
  Stream-Beginn inkl. Chirp): ESPHome `NO_SPEECH_MS` 5 s nach Wake-Word, `NO_SPEECH_FOLLOW_UP_MS` 8 s nach
  Rückfrage. Anlass vitanova 2026-11-03: das eigene Wake-Word „ioBroker“ löste in einer Nacht ~10× aus
  (okay_nabu nie), sechsmal ohne jede Sprache → Mikro jeweils 12,6 s offen (`maxMs`), viermal mit
  Geräusch → STT leer. Die 12,6-s-Fälle waren **keine** verpassten Sprachenden.
  **Diagnose-Aufnahmen** (`src/lib/voice/captures.ts`, `CaptureStore`): Config `esphomeSaveCaptures`
  (Default aus, Raumaudio!). `esphome.ts` meldet per `onDiscarded` jede Aufnahme, die nicht zur Anfrage
  wurde (`no-speech` | `silence` | `empty-stt`, mit `vad` inkl. `analysedPeak`); `main.keepCapture()`
  schreibt in den **ioBroker-Dateispeicher** `assistant.N/captures/<Zeit>_<Gerät>_<Grund>.{wav,json}`
  (Admin → Dateien, also auch für Nutzer ohne Shell), JSON mit `levels` = RMS pro 100 ms. Nur die neuesten
  `MAX_CAPTURES` (50) bleiben; Speichern läuft seriell (sonst prunen sich parallele Saves gegenseitig).
  Test: `test/integration/captures.test.js`.
  **Erste Auswertung (2026-11-03, vitanova):** eine Rückfrage-Antwort „Мессенджер. Да, да.“ kam bei
  RMS 150–500 an (Stimme ein paar Meter weg) — die Stille-Grenze 150 lag mitten in der Sprache, „Мессенджер“
  stand 0,7 s komplett darunter. Nemotron (`nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b`) lieferte
  dafür leer, auch ×10 verstärkt; Whisper lieferte mit Piepton+Stille „Продолжение следует...“ (Halluzination),
  verstärkt den richtigen Text. Folgen: **lange Pause nach langer Rede** (`SpeechDetector` `longSilenceMs`/
  `longAfterMs`, ESPHome: nach `LONG_REQUEST_MS` 2,5 s Sprache × `LONG_PAUSE_FACTOR` 1,5 — Anlass „…чтобы утром
  говорить мне“ abgeschnitten), **`speechAudio.ts` `prepareForStt`** (ab Sprachbeginn − `PRE_ROLL_MS` 400,
  bis letzter Laut ≥ 40 % der Stille-Grenze + `TAIL_MS` 400 — in lauten Räumen bleibt das Ende also stehen —,
  Peak auf `TARGET_PEAK` 16000, max. ×10; die Diagnose-Aufnahme bleibt unverändert), **`FallbackStt` bei
  leerem Text** (`overEngines(…, useful)`), und **`VadReport`** (`vad.ts`) im Trace: `speechStartMs`, `end`,
  `silenceMs`, `stt {fromMs,toMs,gain}`, `levels` (RMS/100 ms, nur im Trace, nicht in der Capture-`vad`).
  Mit dem Zuschnitt (0,89–4,14 s ×10) lieferte Whisper „Мессенджер. Да, нет?“, mit voller Länge „Мессенджер.
  Да, да.“ — das Schlüsselwort stimmt beide Male, der leise Rest schwankt; ohne Verstärkung „Меседжет.
  Меседжет.“. Auf vitanova: `speechLevel` 150, `esphomeSilenceMs` 1200, STT Whisper.
  **Zweite Auswertung (2026-11-03, Fehlauslöser des eigenen Wake-Words):** (a) ein einzelner Laut 100 ms bei
  RMS 197 öffnete das Gate 150 → Whisper machte aus ×10 verstärkter Stille „и все просят.“ → **`minSpeechMs`**
  (`vad.ts`, ESPHome `MIN_SPEECH_MS` 200): ein Laut über `startLevel` ist erst Kandidat, Sprache erst nach
  200 ms über `endLevel`; fällt er `speechGapMs` (300) still, wird er vergessen; `speechStartMs` = Beginn des
  Kandidaten; der Rauschboden steigt während eines Kandidaten nicht; `longestSoundMs` → eigenes Debug-Log
  „only a short sound“ (sonst hätte das Log fälschlich „Schwelle senken“ empfohlen). Gegen die echte
  „Мессенджер“-Aufnahme und das Pegelprofil des Fehlauslösers nachgespielt. (b) Das Gerät hörte nach 2,69 s
  auf, Audio zu schicken, **ohne** `end` → 30 s `PIPELINE_TIMEOUT_MS` auf „listening“ (im Trace stand
  `end:'stream'`, weil der Timeout `finishCapture()` ohne Grund rief) → **`checkStall`** (Intervall 250 ms,
  `STREAM_STALL_MS` 2 s nach dem letzten Audio, `STREAM_START_MS` 5 s ohne jedes Audio), `CaptureEnd` =
  `SpeechEnd | 'stream' | 'stall' | 'pipeline-timeout'`. (c) Firmware: `wake_word_N_sensitivity` ist der
  **Wahrscheinlichkeits-Cutoff** (höher = strenger), Slot = Reihenfolge der aktiven Modelle; ein per
  `SetConfiguration` aktiviertes Modell läuft mit dem `probability_cutoff` seiner JSON, bis das Gerät neu
  startet oder die Entity geschrieben wird — danach gilt der gespeicherte Slot-Wert.
  **Wake-Words aus ioBroker setzbar** (gegen echte Hardware getestet, Originalzustand wiederhergestellt):
  `esphome.ts` merkt sich die `VoiceAssistantConfigurationResponse` als `WakeWordConfig`
  (active/available[{id,phrase,languages}]/max), meldet sie per `onWakeWords` und sendet auf
  `setWakeWords()` die `VoiceAssistantSetConfiguration` (id 123) — danach **immer** ein
  `VoiceAssistantConfigurationRequest` als Rücklesung, weil das Gerät eine abgelehnte Liste
  kommentarlos schluckt statt zu fehlern. Unbekannte ids und alles über `max` werden vorher mit Warnung
  gefiltert. `main.ts`: States `satellites.<id>.wakeWords` (schreibbar, ids kommagetrennt) und
  `.availableWakeWords` (read-only JSON); der Schreibpfad **ackt bewusst nicht selbst**, der ack kommt
  aus der Geräte-Rückmeldung — so zeigt ioBroker nie eine Auswahl, die das Gerät gar nicht übernommen
  hat. sendTo `getWakeWords`/`setWakeWords`. Nur `okay_nabu` ist auf mehr als Englisch trainiert
  (en, nl, fr, de, it, es, sv), die übrigen acht sind rein englisch — für de ist die Werkseinstellung
  also die beste Wahl.
  **Geräte-Entities komplett angebunden** — neues Modul `src/lib/voice/esphomeEntities.ts`
  (`EntityRegistry` + tabellengetriebene `KINDS`), **bewusst generisch über die ESPHome-Entity-Liste
  statt gegen ThirdReality-Objekt-ids**, damit HA Voice PE & Co. ohne Codeänderung funktionieren.
  Unterstützt switch/number/select/event/update/mediaPlayer; jede Art kennt ihre `ListEntities…Response`,
  ihre `…StateResponse` und ihre Command-Nachricht (33/51/54/65/118), adressiert über `fixed32 key`.
  `esphome.ts` schickt jetzt `ListEntitiesRequest` **vor** `SubscribeStatesRequest` (State-Nachrichten zu
  noch unbekannten Entities werden sonst verworfen) und leert die Registry bei jedem Reconnect (Keys sind
  nicht stabil über Reboots). Callbacks `onEntities`/`onEntityState`, Methoden `entities()`/`setEntity()`.
  `main.ts`: States unter `satellites.<id>.controls.*` — Skalare direkt, mediaPlayer und update als
  Ordner (`.state/.volume/.command/.muted` bzw. `.currentVersion/.latestVersion/.inProgress/.progress/
  .install`), mit min/max/step/unit bzw. `states` aus der Geräte-Ankündigung. **Kein optimistisches ack**
  (wie bei den Wake-Words): Zahlen außerhalb des Bereichs werden geklemmt, unbekannte Select-Werte
  abgelehnt — der ack kommt immer aus der Geräte-Rückmeldung. sendTo `getControls`/`setControl`.
  Am echten Gerät verifiziert: 12 Entities gefunden, Schreiben/Klemmen (99999→4000)/Case-insensitive
  Select/Ablehnungen korrekt, alle Originalwerte wiederhergestellt.
  **GUI (Roadmap #6-Erweiterung)** — `src-admin/src/SatelliteSettingsDialog.tsx`, geöffnet über einen
  Zahnrad-Knopf pro Zeile in `SatellitesComponent.tsx` (bei offline deaktiviert). **Rendert komplett aus
  den Objekt-Metadaten** (`min`/`max`/`step` → Slider, `states` → Dropdown, `boolean` → Switch,
  `role:'button'` → Button, `write:false` → Textanzeige) — kein produktspezifischer Code, andere Geräte
  bekommen automatisch ihre eigenen Regler. Wake-Words als Chips aus `availableWakeWords` inkl.
  max-Limit (überzählige werden disabled) und Sprach-Tooltip. `SatellitesComponent` hält jetzt zusätzlich
  `vals` (alle Roh-Werte unter `satellites.*`) und lädt beim Öffnen die Control-Objekte per
  `getForeignObjects`. Slider schreibt erst auf `onChangeCommitted` (sonst pro Pixel ein Geräte-Roundtrip).
  Nach Änderungen hier: `npm run build:gui` **und** `iobroker upload assistant`.
  **float32-Rauschen** (2026-11-03): die protobuf-`float`-Felder kommen als 0.5000000237487257 bzw. step
  0.0010000000474974513 an → `esphomeEntities.float32()` (7 signifikante Stellen) für number min/max/step/
  state, Sensorwert, Media-Volume, Update-Progress; Sensoren zusätzlich auf `decimals` gerundet
  (`writeSatelliteControl`). Bestehende number-Objekte zieht `syncNumberRange()` nach (`extendObject` nur bei
  Abweichung). Dialog: Gruppenüberschrift = Kanalname (`groupNames`, Kanäle werden mitgeladen), Zahlen per
  `formatNumber(value, step)`. Firmware-Update-Gruppe (`isUpdateGroup`/`renderUpdateGroup`, erkannt an den
  Blättern latestVersion+install+progress): Install-Knopf nur bei `latestVersion ≠ currentVersion` und ohne
  laufendes Update, `progress` nur während `inProgress` als `LinearProgress` (unbestimmt bis > 0 %),
  `inProgress` ohne eigene Zeile.
  **Timer-Spiegelung** — `VoiceAssistantTimerEventResponse` (115) via `EsphomeSatellites.timerEvent()`;
  `main.ts.mirrorTimerList()` diffed die `onChange`-Liste gegen `mirroredTimers` (neu→started,
  verschwunden→cancelled, sonst updated), `onFire`→finished. Ziel ist der Ursprungs-Satellit, sonst
  Broadcast — sonst bliebe ein per Text gesetzter Timer auf allen Lautsprechern stumm. Gegen echte
  Hardware: started/updated/cancelled akzeptiert, Verbindung bleibt stehen.
  ⚠️ Beim Testen am Gerät Originalwerte notieren und zurücksetzen — ein aktiviertes zweites Wake-Word
  hat hier `wake_word_2_sensitivity` von 0,85 auf 0,97 gezogen (wurde zurückgesetzt).
  `mic_volume` 1600/4000 und `mic_gain` 10/31 hochzudrehen würde den Sprachpegel verbessern, ändert aber
  nichts am Chirp-Problem.
- **Timer + Wecker (Roadmap #2)** — `src/lib/timers.ts` (`TimerManager`, Countdown) und `src/lib/alarms.ts`
  (`AlarmManager`, feste Uhrzeit HH:MM + optional Wochentage, One-Shot/wiederkehrend, `enabled`). **Beide
  feuern per eigenem `setTimeout` — KEIN Poll-Loop und KEINE periodischen State-Writes**; States tragen nur
  absolute Zeitstempel (`fireAt`/`nextFireAt`), Vis/JS rechnen die Rest-Zeit selbst aus. NLU (`nlu.ts`): eine
  `parseSchedule` + `parseDurationSeconds`/`parseClockTime`/`parseWeekdays` (de/en/ru), Intents
  `timerSet/Query/Cancel` + `alarmSet/Query/Cancel`; entzerrt Uhrzeit vs. Dauer (ru „7 часов"=7 Uhr; „Wecker
  in 5 Minuten"=Timer; „Timer um 5 Minuten"≠5 Uhr). `TIMER_RE` matcht nie das bloße „time". `main.ts`:
  `setupTimers`/`setupAlarms`/`render*`/`execute*Intent`. States `timers.{count,list,nextExpiry,nextLabel,
  lastFired,cancelAll}` + `timers.items.<id>.{label,room,duration,fireAt,cancel}`; `alarms.{count,list,
  nextAlarm,nextLabel,lastFired,cancelAll}` + `alarms.items.<id>.{label,room,time,weekdays,nextFireAt,enabled,
  delete}` (schreibbar: cancel/enabled/delete/cancelAll). Persistenz via `timers.list`/`alarms.list` → `restore()`.
  Ansage beim Auslösen an den Ursprungs-Satelliten (`timerAnnounce`/`alarmAnnounce`). LLM-Tools
  `set_timer/list_timers/cancel_timer` + `set_alarm/list_alarms/cancel_alarm`; sendTo
  `setTimer/cancelTimer/listTimers` + `setAlarm/cancelAlarm/listAlarms`. **Hannah legte KEINE Timer/Wecker-States
  an** (nur SQLite + gRPC/MQTT) — hier bewusst ioBroker-first.
- **Jingles/Sound-Assets (Roadmap #5)** — Upload eigener mp3/wav über jsonConfig `fileSelector`
  (`objectID:"assistant.%INSTANCE%"`, `upload:"sounds"`) → `assistant.0/sounds/`; `onReady` legt das
  `meta`-Objekt an. Config `timerSound`/`alarmSound`. `main.ts`: `playStoredSound` (readFile → ffmpeg-stdin-
  Decode `decodeAudioBufferToPcm`/`runFfmpegDecode` → `deliverPcm`), `playAndAnnounce` (Jingle → warten →
  TTS-Ansage); fehlt ffmpeg/Datei → nur Ansage. Test-Button/Skript-API `playSound`. Delivery aus
  `announceToSatellites` in `deliverPcm` extrahiert. ⚠️ ffmpeg-Pfad noch nicht end-to-end getestet.
- **Langzeit-Gedächtnis (Roadmap #6)** — `src/lib/memory.ts` (`MemoryStore`: CRUD, Dedup per `key`/Text,
  Cap 100/500, JSON-Persistenz; `buildMemoryPrompt` de/en/ru). **Speicher = ioBroker-States**, **Retrieval =
  alles in den Prompt** (beides Nutzer-Entscheidung). `main.ts`: `setupMemory`/`renderMemory`/`buildMemoryContext`
  (vor jedem Cloud-Call an System-Prompt vorangestellt, neben `buildDeviceContext`). States `memory.{count,list,
  add,forget,clearAll}` + `memory.items.<id>.{text(editierbar),key,source,createdAt,delete}`; Persistenz via
  `memory.list` → `restoreMemory()`. LLM-Tools `remember`/`list_memories`/`forget`; sendTo `saveMemory`/
  `forgetMemory`/`listMemories`. Config `useLongTermMemory` (Default an, gated Tools + Injection). Later:
  Embeddings-Top-K möglich (Format bleibt kompatibel).
- **Wetter-Fragen (Roadmap)** — Nutzer wählt in der Config `weatherInstance` (`selectSendTo`
  `getWeatherInstances` listet installierte Wetter-Instanzen; Open-Meteo pro Standort-Option). `src/lib/weather.ts`
  `buildWeatherReport(adapter,root,states)` normalisiert die Adapter-State-Bäume in einen `WeatherReport`
  (current+forecast); **8 source-verifizierte Mapper**: `open-meteo-weather` (`<Ort>.weather.current.*`/
  `forecast.dayN.*`, `weather_code`→`wmoText`), `weatherunderground` (`forecast.current.*`/`forecast.Nd.*`),
  `openweathermap` (Wind m/s), `brightsky` (`weather.current.*`/`weather.daily.N.*`, DWD gratis), `pirate-weather`
  (`weather.currently.*`/`weather.daily.N.*`, m/s), `accuweather` (`Current.*`/`Daily.DayN.*`, nested
  `Temperature.Min/Max`), `daswetter` (pro Standort `location_N.ForecastDaily.Day_N.*`), `yr`/met.no (nur
  stündlich → current aus `forecastHourly.0h`, keine Tagesvorhersage). Adapter mit `perLocationProbe`
  (open-meteo, daswetter) → Dropdown-Option pro Standort. Unbekannt (`dwd`=Warnungen) → gefilterter Roh-Dump.
  `main.ts`: `buildWeatherTool` (LLM-Tool `get_weather({when?})`, nur wenn `weatherInstance` gesetzt),
  `readWeather` (liest `getForeignStates(${root}.*)`), `getWeatherInstances`, sendTo `getWeather`.
  **Kontext-Injektion (statt nur Tool):** `weather.ts.buildWeatherPrompt(report,lang)` rendert current +
  heute/morgen als kompakte, lokalisierte (de/en/ru) Zeilen; `main.ts.buildWeatherContext()` (Cache
  `weatherCtx`, TTL `WEATHER_CTX_TTL`=5 min, Key `source|lang`) hängt sie in `produceAnswer` **an den
  User-Turn** — wie `buildTimeContext` bewusst **nicht** in den prompt-gecachten System-Prompt (Werte ändern
  sich ständig → würde den Cache inkl. Geräteliste jede Runde busten). Gilt für **beide** LLM-Tiers: auch
  `localLlm.ask()` bekommt die Zeile vorangestellt (das lokale Modell hat keine Tools und würde sonst
  Wetter erfinden). Tage nach morgen bleiben beim Tool (Hinweis-Satz am Ende der Injektion). Adapter ohne
  Mapper (Roh-Dump) → keine Injektion, nur Tool. **Hannah
  nutzte `openweathermap` via MQTT** (`weather.py`) — Vorbild für die Normalisierung.
- **Leere `ask`-Fragen abgewiesen** (Feldbericht Alex F., 2026-11-03): ein Aufrufer ohne `source` (→ `'chat'`)
  schickte nach jeder Antwort sofort ein leeres `ask` (7–70 ms Abstand, ~1/s) — pi-agent bekam nur den Zeitkontext
  („Nur Zeit ohne Text…“) und verbrauchte Tokens. Der Admin-Chat schickt nie leer (`send()` trimmt), pi-agent ruft
  `ask` nur beim telegram-Adapter → vermutlich ein Skript auf `text.response`. Jetzt: `onMessage` trimmt, leer →
  `{error:'empty question'}`, `reportEmptyAsk()` warnt höchstens einmal pro Minute pro Absender (`EMPTY_ASK_REPORT_MS`)
  mit Zähler; jede `Q (ask from <instanz>)`-Zeile nennt den Absender (`obj.from`). `answer()` selbst gibt bei leerer
  Frage `''` zurück (Sicherung für alle anderen Wege; `text.request` filterte schon).
- LLM-Agent mit Tool-Calling-Schleife für **OpenAI + Anthropic** — `src/lib/llm.ts` (`LlmAgent`).
- Tools über native ioBroker-API — `src/lib/tools.ts`: `list_rooms`, `list_functions`,
  `find_states({room?,func?,query?})`, `get_state({id})`, `set_state({id,value})`.
- Typisierte Config — `src/types.d.ts` (`AdapterConfig`).
- Adapter — `src/main.ts`: schreibt in `assistant.0.text.response`, wenn man `assistant.0.text.request`
  setzt; zusätzlich `sendTo('assistant.0','ask',{text:'…'},cb)`.
- **Telegram-Integration — bereits kompatibel, KEIN Code nötig** (geprüft in `C:\pWork\ioBroker.telegram`,
  `src/main.ts:2476`). Der telegram-Adapter hat ein Config-Feld `assistantInstance`; ist es gesetzt, ruft er für
  jede nicht intern gematchte Nachricht `sendTo(assistantInstance,'ask',{text,source:'telegram:<user>',user,
  chatId,userId,messageThreadId})` und schickt `res.answer||res.error` selbst an den richtigen Chat/Thread
  zurück. **Unser `ask`-Handler erfüllt das 1:1**: liest `message.text`+`message.source`, gibt `{answer}`/`{error}`
  per Callback; `source:'telegram:<user>'` speist den Pro-Quelle-Kontext (#1). Zusatzfelder ignorieren wir
  gefahrlos (telegram routet die Antwort selbst). → nur `assistantInstance=assistant.0` konfigurieren. Fallback-
  Skript-Rezept für Chat-Adapter OHNE native Integration (Matrix/WhatsApp/Discord …) in `docs/TODO.md`.
- Admin-Config — `admin/jsonConfig.json` (`i18n: true`), Icon `admin/assistant.svg`,
  Übersetzungen `admin/i18n/{en,de}.json`. **Reiter nach Themen** (2026-11-10): `_main` KI (Anbieter, Gespräch,
  aufklappbar „Advanced“ = maxTokens/systemPrompt) · `_commands` Befehle (NLU, Ton, Synonyme, Routinen) ·
  `_localModels` · `_devices` (Rechte + `_deviceAcl`) · `_services` Dienste (Wetter/Kalender, Präsenz, YouTube,
  Timer/Wecker, Systemmeldungen) · `_triggers` · `_voice` (inkl. aufklappbar ffmpeg, `_voiceTest`) · `_satellites`
  (UDP/Wyoming/ESPHome, aufklappbar Sprachende/Diagnose, Durchsage-Ziele, Status) · `_chat` zuletzt. json-config kann
  **keine verschachtelten Tabs** (`tabs` in einem Panel zeigt nur die Beschriftung) — Unterteilung nur per `header`
  oder `panel` mit `collapsable: true` (Zustand in localStorage).
- `io-package.json` `instanceObjects`: `info.connection`, `text.request`, `text.response`.

**Config-Felder aktuell:** `provider` (openai|anthropic|custom), `credentialType` (manual|manager),
`apiKey`, `credentialIdApiKey`, `model`, `baseUrl` (nur bei `custom` sichtbar), `maxTokens`,
`allowControl`, `systemPrompt`.

**Key-Storage (Phase 2, fertig):** `src/lib/credentials.ts` — `resolveApiKey(adapter, config, override?)`.
`manual` = `apiKey` (in `encryptedNative`/`protectedNative`); `manager` = `credentialIdApiKey` →
`Credentials.getCredentials` (defensiv, js-controller ≥ 7.2). Admin-Test-Button `testApiConnection`
→ `main.ts.testApiConnection()` → `LlmAgent.testConnection()` (OpenAI `models.list`, Anthropic 1-Token-Ping).
**Modell-Feld** = `type: "autocompleteSendTo"` (`command: getModels`, `freeSolo: true`) → `main.ts.getModels()`
→ `LlmAgent.listModels()` (gibt `string[]` zurück; OpenAI/Anthropic `models.list`, gefiltert). Freie Eingabe möglich.

## Architektur / wichtige Dateien

| Datei | Zweck |
|---|---|
| `src/main.ts` | Adapter-Klasse, State-/Message-Handler, baut `LlmAgent` |
| `src/lib/llm.ts` | `LlmAgent`: `ask()` + Tool-Loop (OpenAI Chat Completions / Anthropic Messages) |
| `src/lib/tools.ts` | `Tool`-Interface + `createTools(adapter, config)` |
| `src/types.d.ts` | `AdapterConfig` (typisiert `this.config`) |
| `admin/jsonConfig.json` | Config-UI (`i18n: true`) |
| `admin/i18n/{en,de}.json` | Übersetzungen (Keys = englische Labels) |
| `io-package.json` | Metadaten, `native`, `instanceObjects` |

## Build / Test / Konventionen

```bash
npm install
npm run build          # build:backend + build:gui (Backend nach build/, GUI nach admin/custom/)
npm run build:backend  # nur Backend: tsc -p tsconfig.build.json -> build/ (Entry: build/main.js)
npm run build:gui      # nur GUI: cd src-admin && npm install && npm run build  (langsam: npm i im GUI-Ordner)
npm run lint           # eslint -c eslint.config.mjs (@iobroker/eslint-config)

# Tests (node:test). Laufen gegen das KOMPILAT (build/lib/*.js) — Backend muss vorher gebaut sein.
npm test               # = test:integration: baut Backend (tsc -p tsconfig.build.json) + node --test test/integration/*.test.js
npm run test:package   # mocha test/testPackageFiles.ts (validiert package.json + io-package.json via @iobroker/testing)

# Einzelner Test (Backend muss aktuell gebaut sein, z.B. per `npm run build:backend`):
node --test test/integration/nlu.test.js
```
- **`npm run watch` gibt es NICHT** (kein watch-Script) — für schnelles Iterieren `npm run build:backend` (überspringt den langsamen GUI-`npm install`).
- **Tests** liegen in `test/integration/*.test.js` (plain JS, `node:test`), importieren aus `build/lib/…` und mocken den Adapter — reine Unit-/Logik-Tests der `lib/`-Module (nlu, timers, alarms, weather, tools, llm, memory, credentials, voice-engines, wyoming, voiceServer, context, localLlm). **Kein laufender ioBroker/js-controller nötig.** Nach jeder `lib/`-Änderung: `npm run build:backend` **vor** `node --test …`, sonst testet man alten Code.
- **TypeScript strict**, `module: node16`. Kompilat in `build/` (gitignored).
- Org/Repo: `ioBroker/ioBroker.assistant`. Prettier + ESLint sind eingerichtet.
- Nach Änderungen an `admin/jsonConfig.json`-Labels: passende Keys in `admin/i18n/*.json` pflegen.
- Restliche Sprachen: `npx @iobroker/adapter-dev translate` (oder Weblate-Bot beim PR).

## Plan / Roadmap (Phasen)

1. **Text-Assistent** — ✅ fertig (LLM + Tool-Calling).
2. **Zentrales API-Key-Storage** — ✅ fertig (`manual`/`manager`, Admin-Test-Button).
3. **MCP-Bridge** — ✅ fertig. Tools kommen aus `@iobroker/mcp-server` via `createInProcessMcp`
   (`src/lib/tools.ts` = `buildMcpTools(mcp)`, in `main.ts.onReady` erzeugt, `onUnload` geschlossen;
   `allowSetState = config.allowControl`, `allowObjectChange = false`). `src/lib/devices.ts` wieder entfernt.
   System-Prompt verbietet Markdown/Emoji und erzwingt Tool-Nutzung.
4. **Access-Liste (coarse)** — ✅ fertig. jsonConfig-Checkboxen → **Tool-Allowlist-Filter** (`isToolAllowed`)
   in `buildMcpTools(mcp, access)` (gibt `{ tools, denied }` zurück) + `allowSetState`/`allowObjectChange`.
   Config-Felder: `allowWriteStates`, `allowObjectChange`, `readObjects` (devices|all), `allowReadLogs`,
   `allowWriteLogs`, `allowHistory`, `allowFiles`, `allowSystemInfo`. Unbekannte Tools → deny by default.
5. **Per-Device-ACL (Custom Component)** — ✅ fertig. `src-admin/`-React (Vite + Module-Federation,
   `ConfigCustomAssistant`, baut nach `admin/custom/`; `npm run build:gui`). jsonConfig `type:"custom"`
   `_deviceAcl` → `DeviceAclComponent` zeigt Geräte (Typ+Raum, via `getDevices`-sendTo → `list_devices`)
   mit read/write-Checkboxen; speichert Abweichungen in `config.deviceAcl`.
   Backend-Enforcement in `tools.ts`: **Write** (`guardWrite`) — `set_state`/`set_states` auf `write:false`
   (explizit **oder** Typ-Default, z. B. `lock`) werden abgelehnt; **Read** (`guardRead` + `postProcessListDevices`)
   — `read:false`-Geräte werden aus `list_devices` **entfernt** und ihre Werte aus `get_states` gefiltert.
   Map/Enforcement laden, sobald `allowWriteStates` **oder** ein `read:false`-Eintrag existiert.
   NLU (`executeIntent`) respektiert beides (query→read, control→write). **Buttons** (write-only) werden
   überall ausgeblendet: GUI-Liste, LLM (`HIDDEN_LLM_TYPES` in `postProcessListDevices`), NLU (`getNluDevices`).
   Typ-Defaults (GUI `defaultAclFor` + Backend `DEFAULT_WRITE_FALSE_TYPES`): `lock`→write:false. GUI
   `READONLY_TYPES` (Sensoren, camera, …) → Write-Checkbox disabled. Deaktivierte Zeilen (read=false) `opacity:0.5`.
   - **ACL-Key = primäre stateId** (`deviceKey(stateIds)` = lexikografisch kleinste Control-stateId),
     nicht mehr `room|name|type` — verhindert Kollisionen gleichnamiger Controls (z.B. mehrere „SET").
     ⚠️ Format-Wechsel: alt gespeicherte `deviceAcl`-Einträge greifen nicht mehr (Reset, war v0.0.1).
   - **Namensauflösung iot-konform** (`main.ts.resolveDeviceName`): `common.smartName` (User-Edit) →
     Eltern-Channel/Device/**Folder**-Name (Walk-up wie iot `Devices.tsx#resolveDeviceDisplay`) →
     Detector-Name. mcp-server nahm nur channel/device (ohne folder) → zeigte „SET".
   - **Name editierbar + mehrsprachig** in der GUI: `TextField` pro Zeile → `setDeviceName`-sendTo
     `{stateId,name,language}` → schreibt `common.smartName[lang]` (immer als Sprach-Map,
     smartType/byON bleiben erhalten; leer = Sprache löschen). Editiersprache kommt aus dem Voice-Tab
     (`data.voiceLanguage`, live via `props.data`), **kein eigenes Dropdown**. Fehlt der Name in der
     Sprache → Feld zeigt `en`/erste/Auto-Name mit `helperText`-Warnung; beim Tippen wird unter der
     richtigen Sprache gespeichert. **🌐 Übersetzen-Button** pro Zeile → `translateName`-sendTo →
     `LlmAgent.translate()` (Single-Completion ohne Tools) → speichert Übersetzung. Backend liefert
     in `getDeviceList` zusätzlich `smartName` (Roh-Map) + `autoName` (`resolveParentName`, ohne smartName).
   - **LLM sieht dieselben Namen**: `buildMcpTools(..., resolveName)` schreibt in `list_devices` die
     `deviceName` per `rewriteDeviceNames` um (im ListCache gecacht).
   - **ListCache** (`tools.ts`, TTL 30 s) für `list_devices`/`list_rooms`/`list_functions`; invalidiert via
     `objectChange` auf `enum.rooms.*`/`enum.functions.*`, Button/Tool `clearCache`/`refresh_device_cache`.
6. **Test-Chat (Custom Component)** — ✅ fertig. `src-admin/src/ChatComponent.tsx` (registriert in
   `Components.tsx`, jsonConfig-Tab `_chat` → `ConfigCustomAssistant/Components/ChatComponent`). Zeigt
   einen scrollenden Chat-Verlauf, sendet Prompts per `socket.sendTo(id,'ask',{text})` (Backend liefert
   `{answer}`/`{error}`), Enter=senden / Shift+Enter=Zeilenumbruch. Composer nur aktiv wenn Instanz
   `alive` (live via `subscribeState('system.adapter.<id>.alive')`) **und** Config gespeichert (`props.changed`).
   - **Browser-Sprache (Web Speech API, kein Backend):** Mikro-Button = `webkitSpeechRecognition` (STT) füllt
     das Eingabefeld/sendet; nur sichtbar in Secure Context (`window.isSecureContext` → https/localhost),
     über http/LAN automatisch verborgen. Lautsprecher-Toggle = `speechSynthesis` (TTS) liest Antworten vor
     (geht auch über http). Sprache aus `I18n.getLanguage()` → BCP-47 (`speechLang()`).
   - **Backend-TTS (echte Engine-Stimme, pro Antwort):** ▶️-Button an Assistant-Nachrichten → `tts`-sendTo →
     `synthesizeToWav()` nutzt `createTtsEngine` (OpenAI/Azure/AWS, wie die Satelliten), PCM→WAV
     (`pcmToWav`, 44-Byte-Header) → base64 → Chat spielt via `<audio>`. Gut zum Testen der echten TTS.
   - **Satelliten-Tab (Custom Component)** — ✅ fertig. `src-admin/src/SatellitesComponent.tsx` (registriert in
     `Components.tsx`, jsonConfig-Tab `_satellites` → `ConfigCustomAssistant/Components/SatellitesComponent`).
     Live-Ansicht aller `assistant.0.satellites.*`: liest per `getForeignStates` + Pattern-`subscribeState`
     (`satellites.*`) und zeigt je Satellit Online-Punkt/Status-Chip/Raum/„zuletzt gesehen". Composer pro Zeile
     schreibt `satellites.<id>.tts`, Broadcast-Composer schreibt `tts.text` (Test-Ansagen).
7. **Hybrid lokal→Cloud** — Tier-Pipeline in `main.ts.answer(question)`:
   - **Tier 0 — Regel-NLU** ✅ fertig, **mehrsprachig (de/en/ru)**. `src/lib/nlu.ts` (`Nlu`, Port von Hannahs
     `nlu.py`: Raum+Gerät+Aktion, längster Match gewinnt). Kyrillisch-fähig: `wordInText()` matcht per
     Unicode-Wortgrenze (`\p{L}`) mit **Stemming** (Suffix-tolerant → russische Flexion „подсветку"↔„подсветка").
     Wortlisten de/en/ru. Namen werden in `voiceLanguage||language` aufgelöst (`getNluDevices`), Antworten
     (`executeIntent`/`describeValue`) ebenfalls de/en/ru. Deckt an/aus, Level (%), Farbe (hex), Status-Query
     und **Aggregat-Query „welche Fenster sind offen"** (`parseWindowsOpen` → `action:'listByState'` über alle
     `window`/`windowTilt`-Geräte, optional raumgefiltert → `executeListByState` liest alle States, nennt die offenen).
     **Zeit/Datum** (`parseTimeQuery` → `action:'timeQuery'|'dateQuery'`, geräteunabhängig, läuft nach
     `parseSchedule` damit „weck mich um 7 Uhr" Wecker bleibt): „wie spät ist es / what time is it / который час"
     bzw. „welcher Tag/Datum / what day/date / какое число" → `main.ts.executeTimeIntent()` antwortet direkt
     aus der Host-Uhr (`Intl`, Host-Zeitzone, de/en/ru), ohne LLM. Zusätzlich speist `buildTimeContext()` die
     aktuelle Zeit in **jeden** Cloud-LLM-User-Turn ein (nicht in den gecachten System-Prompt).
     **Synonym-Wörterbuch** (`Nlu(rooms,devices,aliases)`, `applyAliases` schreibt gesprochene/getippte Varianten
     vor dem Matching auf kanonische Begriffe um — Wortgrenzen, normalisiert; z. B. „TV"→„Fernseher"): Config
     `nluAliases: {from,to,language?}[]` (jsonConfig-`table`, sichtbar bei `useLocalNlu`), sprachgefiltert in
     `main.ts.getNluAliases()` (leere `language` = alle), gilt für **alle** Kanäle (Voice + Text).
     `main.ts`: `getNluDevices()` baut `NluDevice[]` (controls = controlType→stateId) aus gecachtem
     `list_devices`; `tryLocalNlu()`→`executeIntent()` ruft direkt `set_state`/`get_states`, respektiert
     `allowWriteStates` + `deviceAcl`. Config-Schalter `useLocalNlu` (default true). Kein Modell, 0 Install.
     Fällt bei Nicht-Treffer auf das LLM zurück. NLU pur/getestet (Scratch-Test grün).
     - **Kombi-Befehle (mehrere Kommandos in einem Satz)** — `Nlu.parseAll(text): NluIntent[]` (neben
       `parse()` = weiterhin genau ein Intent). `splitCommands()` trennt an Konjunktions-**Ketten**
       (`CONJUNCTIONS` = und|sowie|dann|danach|and|then|plus|и|затем|потом, „und dann" zählt als eine),
       `,`/`;` — **kein** Split bei `,` vor einer Ziffer (Dezimalwerte „50,5 %"). Zwei Formen: verschiedene
       Befehle („Licht an und Rollo auf 30 %") und **ein Verb für mehrere Geräte** („Schalte A und B an").
       Dafür ist `parse()` zerlegt in `prepare()` (Prepared: raw/norm/tokens/joined/tokenSet),
       `extractFeatures()` (`CommandFeatures` = action/level/color/isQuery/onOffQuery = die „Was tun"-Hälfte)
       und `buildDeviceIntent()` (die „Welches Gerät"-Hälfte); `parsePrepared()` klebt beides zusammen.
       Ein Segment **ohne eigene Aktion** (`isBare`) erbt die des nächsten Nachbarn (erst vorwärts, dann
       rückwärts) — aber **nur** wenn `namesOnly()` gilt: außer Gerätename, Raum und einem richtungslosen
       Verb (`NEUTRAL_VERBS`: schalte/stelle/setze/set/turn/поставь …) steht nichts drin. Sonst („mach die
       Musik **lauter**") kein Erben → LLM. **Fallback:** liefert der Split < 2 Intents, gilt wieder das
       Ergebnis von `parse()` über den Gesamttext — so bleiben „1 Stunde und 30 Minuten", Raum-/Gerätenamen
       mit „und" usw. unverändert. Ausführung: `main.ts.tryLocalNlu` → `parseAll` → **erst** `canExecuteNlu()`
       für **alle** Intents (Manager da? Geräte bekannt? `allowWriteStates`?), dann sequenziell
       `executeNluIntent()`; Antworten mit `' '` verkettet. Nie halb ausführen und dann ans LLM geben (das
       würde bereits Geschriebenes wiederholen); wirft ein späterer Intent, kommt `nluFailureText()` in die
       Antwort statt eines Abbruchs. Nebenbei gefixt: `findLevel` kannte **`percent`** (en) nicht.
     - **Control-Auswahl (`pickControl`) typ-/rollenbasiert:** An/Aus bevorzugt einen **booleschen** Control —
       auch unter nicht-standard Key (`ON_SET`) —, nie einen numerischen Level; nur-numerisches Gerät → An/Aus =
       Level 100/0 (nicht `true`→1 %). **Level-Befehl** (`setze auf 30%`) setzt den Level **und** flippt einen
       separaten Schalter (`intent.also`, gefunden per `findSwitch` über Rolle `switch*`/Typ boolean; 0 % → aus);
       Geräte ohne Schalter unberührt. `NluDevice.roles` aus `list_devices` (`getNluDevices`).
   - **Tier 1a — lokales LLM** ✅ implementiert (Runtime-Test auf Zielhardware steht aus). `src/lib/localLlm.ts`:
     `node-llama-cpp` wird **on-demand** installiert (NICHT in package.json — sonst großer Native-Download für
     alle) via `installLocalLlm()` = gespawntes `npm install` ins **Instanz-Datenverzeichnis**
     (`getAbsoluteInstanceDataDir()`, upgrade-sicher). Lazy geladen per dynamischem `import()` (v3 = ESM).
     Modell (Default Qwen2.5-1.5B GGUF, `DEFAULT_LOCAL_MODEL_URL`) wird bei Bedarf heruntergeladen.
     **Tool-frei**: beantwortet Allgemeines, gibt bei Gerätebezug/Unsicherheit `HANDOFF` zurück → `answer()`
     eskaliert ans Cloud-LLM. Config: `useLocalLlm`, `localLlmModelUrl`; Admin-Button `installLocalLlm`.
     `main.ts`: `ensureLocalLlm()` (Hintergrund-Load), `onUnload` dispose; `getAbsoluteInstanceDataDir` fehlt
     in den Typen → `instanceDataDir()`-Cast. ⚠️ auf ARM nur kleines Modell sinnvoll.
   - **Tier 2 — Cloud-LLM** (`LlmAgent`) als Fallback. **Perf:** kompakte **Geräteliste im System-Prompt**
     (`main.ts.buildDeviceContext()` „Name (Raum, Typ): stateId", read-ACL-gefiltert, in `answer()` an
     `agent.ask(question, sys)` übergeben) → das Modell schaltet direkt via stateId, **ohne erste
     `list_devices`-Runde** (spart Runde 0 + Tool-Call). Anthropic **Prompt-Caching** (`llm.ts`:
     `cache_control` auf System+letztem Tool + wanderndem Breakpoint am letzten Message-Block via
     `markLastMessageForCache`) → große Kontexte (list_devices-Ergebnis) werden gecacht statt jede Runde neu
     bezahlt. `list_devices`-Ausgabe für den LLM **getrimmt** (`postProcessListDevices`: nur
     controlType→{stateId,writable}, kein role/unit/min/max/…) → weniger Tokens & Latenz.
8. **Voice / Satelliten** — umgesetzt (V1–V3 fertig, auf dem Pi bestätigt; Reste in `docs/TODO.md`).
   `VOICE_PLAN.md` wurde entfernt (umgesetzt/überholt). Zwei Transporte: **ioBroker-nativ** (Audio über den
   Nachrichtenbus via `voice`-sendTo, kein Port, Default) und **UDP** (Hannah-Protokoll, ESP-kompatibel,
   `udpServerEnabled`). Zusätzlich **Wyoming-TCP-Endpoint**. STT/TTS austauschbar (Cloud + lokal Vosk/Piper),
   globale `voiceLanguage`. Nutzer-Doku: `docs/{en,de}.md`.
   - **V1 — Server-Seite Cloud ✅ fertig.** `src/lib/voice/{protocol,stt,tts,voiceServer}.ts`: `dgram`-UDP-Server
     (Typ-Bytes `0x01/0x02/0x03`, `register`/`heartbeat`/`audio_end` ↔ `registered`/`heartbeat_ack`/`status`/
     `tts_end`) sammelt 16 kHz-mono-PCM bis `audio_end` → OpenAI-STT (`whisper-1`) → `main.ts.answer()` (Tier-Pipeline)
     → OpenAI-TTS (`tts-1`, `pcm` 24 kHz) → `0x03`-Chunks + `tts_end`. States `assistant.0.satellites.<id>.{status,
     room,alive,lastSeen}`. Config-Tab „Voice" (`voiceEnabled/port/bind/voiceLanguage/ttsVoice/voiceApiKey`;
     Key = `voiceApiKey` sonst Haupt-Key bei Provider openai). In `onReady` gestartet, `onUnload` gestoppt.
     Protokoll-Smoke-Test grün; **echter OpenAI-Call + Python-Sat-Interop noch ungetestet.**
   - **STT-Vokabular-Biasing ✅ fertig.** `main.ts.buildSttHints()` (Raum- + Gerätenamen aus der gecachten
     NLU-Liste) → `SttEngine.transcribe(pcm,rate,lang,hints?)`. Die Voice-Server (`voiceServer`/`wyoming`) holen
     die Hints pro Utterance via `getHints`-Callback; der native `ask`-Pfad ebenso. **Soft-Bias** nur wo möglich:
     OpenAI-Whisper `prompt` (`hintsToPrompt`, längenbegrenzt) + Azure `PhraseListGrammar`. **Ignoriert** bei AWS
     (Transcribe-Streaming kennt nur vorab registrierte `VocabularyName`) und Vosk (Grammar = harter Constraint,
     bräche freie Fragen). Verbessert die Erkennung genau der Eigennamen, die die NLU danach matchen muss.
   - **V1b — Cloud-Provider Azure + AWS ✅ fertig.** STT/TTS **unabhängig** wählbar (`sttProvider`/`ttsProvider` =
     openai|azure|aws) via Factory `src/lib/voice/engines.ts` (`createSttEngine`/`createTtsEngine`, `VoiceCredentials`).
     `azure.ts` (Azure Speech: `recognizeOnceAsync` aus PushStream, TTS `Raw24Khz16BitMonoPcm`, `audioConfig=null`),
     `aws.ts` (Polly `pcm`/16 kHz + Transcribe **Streaming**, async-gen AudioStream), `lang.ts` (ISO→Locale; OpenAI
     nutzt ISO, Azure/AWS Locale). Deps (normal): `microsoft-cognitiveservices-speech-sdk`, `@aws-sdk/client-polly`,
     `@aws-sdk/client-transcribe-streaming`. Config: Azure-Key/Region/Voice, AWS-KeyId/Secret/Region/Voice
     (encrypted: `azureSpeechKey`+`awsSecretAccessKey`), Voice pro Provider (`ttsVoice`/`azureVoice`/`awsVoice`).
     Factory-Smoke-Test grün; **echte Cloud-Calls noch ungetestet.**
   - **V1c — Credential-Store + dynamische Voice-Liste ✅ fertig.** `resolveVoiceCredentials` (`credentials.ts`):
     `voiceCredentialType` = manual|manager; manager zieht aus zentralem Store via Picker `voiceCredentialId` (Typ `ai`),
     `azureCredentialId` (Typ `azure` → `{key,region}`), `awsCredentialId` (Typ `aws` → `{accessKeyId,secretAccessKey,
     region}`) — Store-Typen `aws`/`azure` in der Admin-Credential-Komponente definiert. Voices dynamisch: `getVoices`-
     sendTo → `listVoices` (`engines.ts`; Azure `getVoicesAsync`, Polly `DescribeVoices`, OpenAI fixe 6) → jsonConfig
     `autocompleteSendTo` (freeSolo) für `ttsVoice`/`azureVoice`/`awsVoice`. Smoke-Tests grün.
   - **V2** lokale Engines (Vosk-STT, Piper-TTS auto-download). ⚠️ **Vosk NICHT über das `vosk`-npm-Paket**
     (hängt an `ffi-napi`, das auf Node ≥20/22 NICHT baut — `node_api_basic_finalize`-Signatur). Stattdessen
     bindet `src/lib/voice/vosk.ts` die **prebuilt `libvosk`** (GitHub-Release, plattform-Asset via
     `libvoskAsset()`) direkt über **`koffi`** (moderner FFI, prebuilt, Node 22/arm64 OK) — on-demand
     `npm install koffi` + libvosk-Download ins Instanz-Datenverzeichnis, C-API via `lib.func(...)`.
   - **V3** Node-Satellit (2 Repos: Core-Lib `@iobroker/assistant-satellite` + Adapter
     `iobroker.assistant-satellite`), **V4** Wyoming/Politur. Siehe Plan.
9. **Hannah-Abgleich (2026-10-04)** — Hannah (`C:\iot\Hannah`, Stand v0.51.2, letzter Commit 2026-07-03) gegen
   diesen Adapter gelegt; die Liste der Übernahme-Kandidaten mit Fundstellen, Priorität und Begründung steht
   in **`docs/TODO.md`** (nicht im Git). Daraus fertig: **A1 Rückfrage-API**, **A2 Proaktive Trigger** und
   **A3 Systemmeldungen + DND**, **B1 Präsenz**, **B2 Durchsage-Ziele** und **alle zehn Quick Wins**
   (siehe Status oben) — damit ist die Liste bis auf den „Später/optional"-Teil abgearbeitet. Dort offen:
   **Speaker-ID** (Hannahs `voiceid/`-Service, braucht ein Embedding-Modell), **Trust-Level/Nutzerrechte**
   (unsere ACL ist pro Gerät, nicht pro Person), **BLE-Indoor-Lokalisierung** (nur sinnvoll, wenn das Gerät
   `esp32_ble_tracker` fährt) und das **Sammelantwort-Muster** für zusammengesetzte Geräte. Außerdem
   ungebaut: der **No-Code-Editor** für Trigger (heute JSON-Spalten in der Tabelle). Hannahs jüngste Commits
   (AWS-Transcribe-STT, Anthropic-Provider) sind Dinge, die wir längst haben — dort ist nichts mehr zu holen.

**GUI-Build:** `cd src-admin && npm i && npm run build` (oder `npm run build:gui` vom Repo-Root) →
`admin/custom/customComponents.js` + `admin/custom/i18n/*.json` (via `copyI18n`-Plugin aus `src/i18n/`).
`src-admin/node_modules` ist gitignored; `admin/custom/` wird committet (ausgeliefert).

**⚠️ Module-Federation-Versionen ohne `^` pinnen:** `@module-federation/vite` und
`@module-federation/runtime` stehen in `src-admin/package.json` bewusst exakt. Hintergrund: ein falsches
Paar bricht das React-Sharing (`TypeError: Cannot read properties of null (reading 'useContext')` — die
Component lädt eine leere React-Instanz), und das merkt man erst zur Laufzeit im Admin, nicht im Build.
**Stand 2026-10-04: `1.22.1` / `2.9.1` auf React 19** (`@iobroker/json-config` 10, MUI 9) — die früher hier
dokumentierten Werte `1.14.5`/`2.3.3` und „React 18" sind überholt. Nach einem Bump dieser beiden Pakete
also nicht nur bauen, sondern die Custom-Tabs im Admin wirklich öffnen.

**mcp-server-Tool-Palette (Referenz, `@iobroker/mcp-server`):** lesen: `get_states`, `get_logs`,
`history_query`, `system_info`, `search_objects`, `list_devices`, `list_instances`, `list_hosts`,
`list_adapters`, `search_adapter_repository`, `list_rooms`, `list_functions`, `get_object`, `read_file`,
`list_files`, `file_exists`, `ping_host`. schreiben (gated `allowSetState`): `set_state`, `set_states`,
`write_log`. objekt/datei-änderung (gated `allowObjectChange`): `set_object`, `delete_object`,
`create_state`, `create_scene`, `write_file`, `delete_file`, `rename_file`, `mkdir`. **Nicht vorhanden:**
Node.js ausführen / JS an `javascript.0` senden (bewusst nicht).

## ✅ ERLEDIGT (Referenz): Zentrales Key-Storage (Vorbild: `C:\pWork\ioBroker.javascript`)

**Status: implementiert** — `src/lib/credentials.ts`, Config-Felder + Admin-Test-Button. Der folgende
Abschnitt bleibt als Muster-Referenz stehen.

Der Admin unterstützt ab **js-controller ≥ 7.2** einen zentralen Credential-Store
(`system.credentials.*`). Der `javascript`-Adapter macht das mustergültig — 1:1 übernehmen, aber auf
unsere Provider (openai/anthropic, evtl. später gemini/deepseek/custom) reduziert.

**Zwei Modi über `credentialType: 'manual' | 'manager'` (Default `manual`):**
- `manual`: Key direkt im Adapter-Config, verschlüsselt.
- `manager`: Config speichert nur die **ID** einer Credential (`system.credentials.<name>`), der
  echte Key wird zur Laufzeit aufgelöst.

**Umzusetzen:**

1. **`io-package.json`** — `native` erweitern: `credentialType: "manual"`, `credentialIdApiKey: ""`.
   Und den Key schützen:
   ```json
   "encryptedNative": ["apiKey"],
   "protectedNative": ["apiKey"]
   ```
   (verschlüsselt at-rest, nie ans Frontend gesendet).

2. **`src/types.d.ts`** — `AdapterConfig` um `credentialType: 'manual' | 'manager'` und
   `credentialIdApiKey: string` erweitern.

3. **`admin/jsonConfig.json`** — pro Provider drei Felder:
   - `credentialType`: `type: "select"` (manual/manager).
   - `apiKey`: `type: "password"`, `"hidden": "data.credentialType === 'manager'"`.
   - `credentialIdApiKey`: `type: "credential"`, `"credentialType": "ai"`,
     `"hidden": "data.credentialType !== 'manager'"`.
   - optional Test-Button: `type: "sendTo"`, `command: "testApiConnection"`,
     `jsonData: "{\"apiKey\":\"${data.apiKey}\",\"provider\":\"${data.provider}\",\"credentialType\":\"${data.credentialType}\",\"credentialId\":\"${data.credentialIdApiKey}\"}"`.

4. **Backend-Resolver** (neu `src/lib/credentials.ts`, analog `javascript/src/lib/aiProviderResolver.ts`):
   - `import { Credentials } from '@iobroker/adapter-core';`
   - manual: Key aus `this.config.apiKey`.
   - manager: `const cred = await Credentials.getCredentials<Credentials.KeyCredentials>(this, id);`
     → `cred?.values?.key`. Guard: `if (!Credentials?.getCredentials)` → Warnung „nur ab js-controller 7.2".
   - Optional: entschlüsselte Keys cachen + `subscribeForeignObjects('system.credentials.*')` für Hot-Reload
     (wie `subscribeAiCredentials` im Vorbild) — kann später kommen.
   - In `main.ts` `onReady()` den Key **vor** `new LlmAgent(...)` auflösen.

5. **i18n** — neue Labels („Credential mode", „ChatGPT credential", …) in `admin/i18n/{en,de}.json` ergänzen.

**Konkrete Fundstellen im Vorbild `C:\pWork\ioBroker.javascript`:**
- `src/lib/aiProviderResolver.ts` — Provider→Feld-Mapping, `resolveProviderCredentials`, `getProviderCredentialId`.
- `src/main.ts` — `readAiCredentialKey()` (~Zeile 972), `resolveAiCredentials()` (~Zeile 1000),
  Import `Credentials` aus `@iobroker/adapter-core` (~Zeile 44).
- `admin/jsonConfig.json` — Panel `_ai`: Felder `gptKey`/`credentialIdGptKey` (`type:"credential"`,
  `credentialType:"ai"`), Test-Button `_testOpenAi`.
- `io-package.json` — `encryptedNative`/`protectedNative`-Listen, `native.credentialType`.

## Referenzen

- **Vorbild-Adapter (Key-Storage):** `C:\pWork\ioBroker.javascript`.
- **Python-Ursprung (Feature-Ideen, Satelliten-Protokoll):** `C:\iot\Hannah` (dessen `CLAUDE.md`).
- **Telegram-Integration (native `assistantInstance`→`ask`-Bridge):** `C:\pWork\ioBroker.telegram`
  (`src/main.ts:2476` sendTo, `:2509` `communicate.request` = `[user] text`).

## Offene Entscheidungen

- Provider: ✅ openai, anthropic, **gemini**, **deepseek**, custom, **none** (nur lokale Stufen:
  `agent` bleibt `null`, MCP-Tools werden trotzdem gebaut, weil die NLU darüber schaltet; Bereitschaft
  hängt deshalb an `this.ready`, nicht an `this.agent`; Rest-Anfragen → `localOnlyFallback()`, und das
  lokale Modell übernimmt dann auch Folgefragen). `custom` braucht keinen Key (`effectiveApiKey`) und kein
  Modell (`LlmAgent.ensureModel()` holt das erste aus `/models` — sonst schickte man `"model":""`). gemini/deepseek laufen über die
  OpenAI-kompatible SDK-Schiene mit fester baseUrl (`PROVIDER_PRESETS`/`resolveProvider` in `llm.ts`).
  **Single-Provider** (ein aktiver Provider) — bewusst so; „mehrere gleichzeitig" (wie `javascript`) nicht umgesetzt.
- Offline-Betrieb nötig? (sonst rein Cloud → einfacher).
- Icon: SVG vorhanden; für offizielle ioBroker-Repo evtl. zusätzlich PNG 128×128.
- Audio (Phase 4/5): Streaming-STT in Node (`dgram` + AWS/Azure/OpenAI-SDK) ist der fummeligste Teil.

## Arbeitsweise-Notizen

- Nach jedem sinnvollen Schritt: `npm run build` grün halten.
- Diese Datei aktualisieren, wenn sich Stand/Plan ändert (Status-Abschnitt + Roadmap-Häkchen).
- Secrets (API-Keys) niemals committen.
