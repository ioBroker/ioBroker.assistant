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
- **Quick Wins aus dem Hannah-Abgleich (alle zehn)** — vier neue Module plus Erweiterungen:
  - `src/lib/voice/ttsCache.ts` — `CachedTts` umhüllt **jede** TTS-Engine (in `engines.ts.createTtsEngine`,
    damit Satelliten, Durchsagen, Test-Chat und `tts`-sendTo dasselbe Verhalten haben): Plattencache
    (Verzeichnis pro Anbieter+Stimme, Sample-Rate im Dateikopf → nie falsche Tonhöhe, Key =
    sha256(lang+text), nur Texte ≤200 Zeichen — lange Einmal-Antworten füllen sonst die Platte —, LRU-Prune
    auf 64 MB), `truncateForTts` (400 Zeichen, Schnitt am letzten passenden Satzende; SSML wird nie
    geschnitten) und SSML-Routing. `TtsEngine` hat dafür optionale `synthesizeSsml`/`warm`-Hooks;
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
  Übersetzungen `admin/i18n/{en,de}.json`.
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

- Provider: ✅ openai, anthropic, **gemini**, **deepseek**, custom. gemini/deepseek laufen über die
  OpenAI-kompatible SDK-Schiene mit fester baseUrl (`PROVIDER_PRESETS`/`resolveProvider` in `llm.ts`).
  **Single-Provider** (ein aktiver Provider) — bewusst so; „mehrere gleichzeitig" (wie `javascript`) nicht umgesetzt.
- Offline-Betrieb nötig? (sonst rein Cloud → einfacher).
- Icon: SVG vorhanden; für offizielle ioBroker-Repo evtl. zusätzlich PNG 128×128.
- Audio (Phase 4/5): Streaming-STT in Node (`dgram` + AWS/Azure/OpenAI-SDK) ist der fummeligste Teil.

## Arbeitsweise-Notizen

- Nach jedem sinnvollen Schritt: `npm run build` grün halten.
- Diese Datei aktualisieren, wenn sich Stand/Plan ändert (Status-Abschnitt + Roadmap-Häkchen).
- Secrets (API-Keys) niemals committen.
