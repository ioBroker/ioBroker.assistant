# ioBroker.assistant — Anleitung

Ein Sprach- und Text-**Assistent für ioBroker**. Er beantwortet freie Fragen **und** Fragen zu deinen
**ioBroker-States, -Geräten und zum Wetter**, und er kann **Geräte steuern** — angetrieben von einem
Large Language Model (LLM) mit Tool-Calling über die native ioBroker-API. Keine Regelbäume, kein
virtueller Geräte-Baum, den man pflegen muss.

Optional arbeitet er mit **Satelliten** (Mikrofon-/Lautsprecher-Boxen in jedem Raum) für freihändige Sprache.

---

## 1. Was kann er?

- **Fragen beantworten** — Allgemeinwissen und über dein Zuhause: *„Ist noch ein Fenster offen?"*,
  *„Wie warm ist es im Wohnzimmer?"*, *„Wie viel hat die Heizungspumpe heute verbraucht?"*
- **Nach Kategorie antworten, offline** — *„Wie ist die Luft hier?"*, *„Wie warm ist es überall?"*,
  *„Wie hell ist es?"* werden aus allen Sensoren dieser Art beantwortet, ohne ein Gerät zu nennen
  und ohne Cloud.
- **Geräte steuern** — *„Schalte das Wohnzimmerlicht aus"*, *„Stell die Rollos auf 50 %"*, *„Mach die
  Küche warmweiß"*.
- **Text oder Sprache** — in einen State schreiben / den eingebauten Test-Chat nutzen, oder mit einem
  Satelliten reden.
- **Wetter** — beantwortet Wetterfragen aus einem **bereits installierten Wetter-Adapter** (siehe §4),
  ohne zusätzlichen Dienst oder API-Schlüssel.
- **Wo möglich günstig und privat** — eine gestufte Pipeline versucht zuerst eine schnelle **Offline-
  Regel-Engine**, dann optional ein **kleines lokales LLM**, und eskaliert nur bei Bedarf ans **Cloud-LLM**.
- **Timer und Wecker** — *„Stell einen Timer auf 10 Minuten"*, *„Weck mich um 6:30 wochentags"*;
  klingeln mit eigenem Ton und lassen sich per *„Stopp"* verstummen (§11).
- **Routinen und proaktive Trigger** — eine Phrase löst mehrere Aktionen aus (*„Gute Nacht"*), und
  der Assistent fängt von selbst an: er sagt etwas, schaltet etwas, oder **fragt dich** und handelt
  nach deiner Antwort (§10).
- **Durchsagen und Systemmeldungen** — an einen Raum, eine Gruppe oder die Lautsprecher einer
  Person; ioBroker-Benachrichtigungen werden zu einem sprechbaren Satz umformuliert, „Nicht stören"
  wird beachtet (§9).
- **Er merkt sich, wer zuhause ist** und **was du ihm sagst** — Anwesenheit aus deinen eigenen
  States, plus ein einsehbares Langzeit-Gedächtnis (§4, §11).
- **Feingranulare Rechte** — du legst fest, was der Assistent lesen/schreiben darf, bis auf **Geräte-Ebene**.

---

## 2. Wie es funktioniert (Konzept)

### Die gestufte Antwort-Pipeline

Jede Anfrage läuft durch bis zu drei Stufen und stoppt bei der ersten, die antworten kann:

1. **Regelbasiertes NLU (offline, sofort)** — erkennt einfache Befehle (an/aus, Dimmen, Farbe, Status) auf
   **Deutsch, Englisch und Russisch**. Auch **mehrere Befehle in einem Satz**: *„Schalte das Licht an und
   setze das Rollo auf 30 %"* — und ein Verb für mehrere Geräte: *„Schalte das Licht und die Lampe an"*
   (getrennt durch *und / sowie / dann*, Komma oder Semikolon). Kein Modell, keine Cloud. Schalter:
   *Einfache Befehle lokal beantworten*.
2. **Lokales LLM (optional)** — ein kleines Modell (über `node-llama-cpp`), bei Bedarf installiert, für
   allgemeine Fragen. Es eskaliert an die Cloud, wenn es aktuelle Gerätedaten braucht. Schalter: *Lokales
   LLM verwenden*.
3. **Cloud-LLM (Tool-Calling)** — der volle Assistent. Er bekommt eine kompakte Geräteliste im Prompt und
   ruft Tools auf (States lesen/schreiben, Historie, Logs …) über die native ioBroker-API.

### Anbieter

Ein aktiver LLM-Anbieter: **OpenAI, Anthropic (Claude), Google Gemini, DeepSeek** oder ein beliebiger
**OpenAI-kompatibler** Endpunkt (z. B. Groq, ein lokaler Server) über eine eigene Basis-URL.

### Satelliten (Sprache)

Ein **Satellit** ist ein Mikrofon + Lautsprecher in einem Raum. Das **Wake-Word** („Hey Jarvis" …) wird
**auf dem Satelliten** erkannt; er nimmt dann deinen Satz auf, der Assistent macht daraus Text (STT),
antwortet und liest die Antwort vor (TTS). Spracherkennung und -synthese laufen **zentral im Assistenten**
— die Satelliten bleiben einfach. Siehe §7.

---

## 3. Was du brauchst

**Minimum (Text-Assistent):**

- Eine **ioBroker**-Installation mit aktuellem Admin und js-controller (≥ 7.2 empfohlen, nötig für den
  zentralen Zugangsdaten-Speicher).
- **Eines** von:
  - einen **API-Schlüssel** für einen LLM-Anbieter (OpenAI, Anthropic, Gemini, DeepSeek oder ein eigener
    Endpunkt), **oder**
  - genug CPU/RAM für das **lokale LLM** (auf Raspberry Pi / arm64 kleine Modelle empfohlen).

**Zusätzlich für Sprache / Satelliten:**

- Einen **Sprach-Anbieter**: OpenAI, Azure oder AWS (Cloud), **oder** lokal **Vosk** (STT) + **Piper**
  (TTS), die bei Bedarf installiert werden — ohne Cloud.
- Einen oder mehrere **Satelliten** mit Mikrofon und Lautsprecher (z. B. ein Raspberry Pi mit USB-
  Speakerphone). **ffmpeg** wird auf dem Satelliten-Host benötigt (Windows und Linux).
- **Node.js ≥ 22** auf dem Satelliten-Gerät.

---

## 4. Installation & Grundeinrichtung (Text)

1. Installiere den **ioBroker.assistant**-Adapter aus dem ioBroker-Admin und lege eine Instanz an.
2. Öffne die Instanz-Einstellungen → Reiter **Settings**:
   - **Anbieter** — wähle deinen LLM-Anbieter.
   - **Schlüssel-Quelle** — *Schlüssel im Adapter speichern* (am einfachsten) oder *Zentraler Zugangsdaten-
     Speicher* (js-controller ≥ 7.2; der Adapter speichert nur die Zugangsdaten-ID, der Schlüssel bleibt im
     Speicher).
   - **API-Schlüssel** (oder die Zugangsdaten auswählen).
   - **Verbindung testen** klicken. Bei Erfolg ein **Modell** wählen (das Dropdown lädt die Modelle des
     Anbieters; du kannst auch eine Modell-ID eintippen).
3. *(Optional)* **Einfache Befehle lokal beantworten** (Offline-Regel-Engine) und/oder **Lokales LLM
   verwenden** aktivieren (**Lokales Modell installieren** klicken — lädt Engine + Modell; Fortschritt
   beobachten).
4. **Zugriff / Berechtigungen** setzen (siehe §6) und speichern.

### Als Text nutzen

- Schreibe deine Frage in den State **`assistant.0.text.request`** → die Antwort erscheint in
  **`assistant.0.text.response`**. Die Herkunft steht in `text.querySource`.
- Oder aus einem Skript: `sendTo('assistant.0', 'ask', { text: 'Ist ein Fenster offen?' }, cb)`.
- Oder den **Test-Chat**-Reiter in den Adapter-Einstellungen nutzen (funktioniert bei laufender Instanz).

### Wetter

Wetterfragen (*„Wie ist das Wetter?"*, *„Regnet es morgen?"*) beantwortet der Assistent aus einem
Wetter-Adapter, den du ohnehin schon betreibst — kein zusätzlicher Dienst, kein weiterer API-Schlüssel:

1. Installiere und starte einen Wetter-Adapter (Open-Meteo, Weather Underground, OpenWeatherMap,
   Bright Sky/DWD, Pirate Weather, AccuWeather, DasWetter, Yr) und lass ihn einmal Daten holen.
2. Instanz-Einstellungen → **Wetter-Quelle**: das Dropdown listet die installierten Wetter-Instanzen
   (bei Open-Meteo und DasWetter jeden Standort einzeln). Auswählen und speichern.

Danach bekommt das LLM bei **jeder** Anfrage das aktuelle Wetter samt heute/morgen kompakt in den Kontext
gelegt (5 Minuten gecacht) und antwortet direkt daraus; für weitere Tage ruft es zusätzlich das Werkzeug
`get_weather` auf. Aus einem Skript: `sendTo('assistant.0', 'getWeather', { when: 'week' }, cb)`.
Andere Wetter-Adapter lassen sich ebenfalls wählen — sie werden dann bestmöglich als Roh-Daten gelesen.

---

### Wer ist zuhause

Sag dem Assistenten, welche States angeben, ob jemand zuhause ist — eine Zeile pro Person in der Tabelle
**Anwesenheit** im Tab Einstellungen. Jeder State geht, denn Anwesenheit steckt in jedem Haus woanders:

| Spalte | Bedeutung |
|---|---|
| **State-Id** | z. B. `residents.0.denis.presence`, `ping.0.phone-denis.alive`, `0_userdata.0.anna_zuhause`. |
| **Name** | Wie der Assistent die Person nennt (Standard: der letzte Teil der State-Id). |
| **Art** | `person` (Standard), `guest` oder `pet` — ein Haustier macht das Haus nie „bewohnt". |
| **Wert für „zuhause"** | Leer lassen für die üblichen Formen (`true`, `1`, `home`, `anwesend`), oder genau den Wert eintragen, der „zuhause" bedeutet. |

Ein Wert, der keiner bekannten Form entspricht, lässt die Anwesenheit **unbekannt** — nicht „abwesend".
Der Assistent behauptet nicht, jemand sei weg, wenn er es nicht wissen kann.

Wofür das genutzt wird:

- **Der Assistent weiß, wer da ist.** Er kann „Wer ist zuhause?" oder „Ist Anna da?" beantworten und hat
  die Information zur Hand, wenn eine Anfrage davon abhängt („mach überall aus"). Die Zeile geht in jede
  Frage mit ein, ist also nie veraltet.
- **Durchsagen an ein leeres Haus lassen sich zurückhalten** — pro Durchsage opt-in:
  `sendTo('assistant.0', 'notify', { text: 'Die Waschmaschine ist fertig', onlyWhenHome: true })`. Ohne
  konfigurierte Anwesenheit wird nie etwas zurückgehalten.
- **Trigger** können sie wie jeden anderen State nutzen — so begrüßt man auch jemanden:

```json
{ "state": "assistant.0.presence.anyoneHome", "value": true }
```

…mit `Ansage: Willkommen zuhause!`, oder pro Person auf deren eigenem Anwesenheits-State. Mit
`"also": { "state": "assistant.0.presence.anyoneHome", "value": true }` läuft ein Trigger nur, solange
jemand da ist.

States: **`presence.anyoneHome`** (ein Mensch ist da), **`presence.count`**, **`presence.list`** (JSON pro
Person), **`presence.lastArrival`** / **`presence.lastDeparture`** (wer es war).

---

### Routinen (eine Phrase, die mehreres tut)

Eine Routine ist ein Makro, das du aufgeschrieben hast: eine Phrase, eine Liste von Aktionen, eine
Antwort. Einzutragen in der Tabelle **Routinen** im Tab Einstellungen:

| Spalte | Beispiel |
|---|---|
| **Name** | `Gute Nacht` |
| **Phrasen** | `gute nacht, ich gehe schlafen` — mit Komma getrennt |
| **Aktionen (JSON)** | `[{"setState":{"id":"hm-rpc.0.ABC.1.STATE","value":false}},{"say":"Schlaf gut"}]` |
| **Antwort** | `Gute Nacht!` (leer = nichts sagen) |

Die Phrase wird irgendwo im Satz erkannt ("mach mal gute nacht bitte"), Groß-/Kleinschreibung,
Satzzeichen und Umlaute sind egal (`Büro` = `buero`). Es zählen nur ganze Wörter, eine Routine auf
`licht` wird also nicht von "Lichtschalter" ausgelöst. Passen zwei Routinen, gewinnt die **längere**
Phrase.

Routinen werden **vor** der Offline-Regel-Engine und vor dem LLM geprüft. Genau das ist der Zweck: bei
"Gute Nacht, und das Licht noch aus" würde die Regel-Engine "Licht" finden und nur diese Hälfte machen,
und das LLM würde eine Runde kosten für eine Entscheidung, die schon getroffen ist. Die Aktionen haben
dieselbe Form wie bei einem Trigger — eine Routine ist also ein Trigger, dessen Bedingung eine Phrase ist,
inklusive `{"say":…,"room":…}`, um irgendwo etwas zu sagen.

---

### Was die Offline-Regel-Engine beantwortet

Bevor irgendein Modell gefragt wird, versucht eine Regel-Engine die Anfrage — sofort, kostenlos und ohne
Internet. Es lohnt sich zu wissen, was sie abdeckt, denn das sind die Sätze, die dich nie einen
Cloud-Aufruf kosten:

- **Schalten und stellen** — „schalte das Wohnzimmerlicht aus", „stell die Rollos auf 30 %", „mach die
  Küche warmweiß". Mehrere Befehle in einem Satz gehen auch („Licht an und Rollo auf 30 %"), ebenso ein
  Verb für mehrere Geräte („schalte das Licht und die Lampe an").
- **Status** — „ist das Küchenlicht an?", „wie warm ist es im Schlafzimmer?"
- **Aggregate** — „welche Fenster sind offen?" prüft alle Fenster, optional in einem Raum.
- **Nach Kategorie, ohne ein Gerät zu nennen** — „wie ist die Luft hier?", „wie warm ist es überall?",
  „wie hell ist es?", „wie feucht ist es?". Es antworten alle Sensoren dieser Art; ein Raumname filtert
  sie, „überall" hebt den Filter wieder auf. Bei der Luftqualität bekommt die Zahl zusätzlich ein Wort
  („gut", „mäßig") — ein IAQ von 85 sagt vorgelesen niemandem etwas.
- **Timer, Wecker, Zeit und Datum** — siehe §11.

Zwei Regeln entscheiden, was gewinnt: ein **genannter Gerätename** schlägt die Kategorie („wie warm ist
die Heizung" ist über dieses Thermostat), und eine **Routine** schlägt alles (siehe oben). Was die Engine
nicht auflösen kann, fällt ans LLM durch — du verlierst also nichts, wenn sie daneben liegt.

#### Synonym-Wörterbuch

Die Engine matcht deine Geräte- und Raumnamen, was ein Problem ist, wenn niemand sie so ausspricht. Die
Tabelle **Synonym-Wörterbuch** im Tab Einstellungen schreibt das Gesagte vor dem Matching um: `TV` →
`Fernseher`, `Couchlicht` → `Licht Wohnzimmer`. Bleibt die Sprachspalte leer, gilt die Zeile für alle
Sprachen. Sie wirkt für Sprache **und** Text, Chat und Telegram profitieren also von denselben Einträgen.

Mit **Gespräch merken** funktionieren Nachfragen pro Quelle für ein paar Minuten: „Licht an" — „und in der
Küche auch", „mach es wieder aus". Der Gesprächsfaden liegt nur im Speicher, einer pro Kanal (Chat,
Telegram, jeder Satellit).

---

## 5. Berechtigungen & Geräte-Zugriff

Unter **Zugriff / Berechtigungen** steuerst du, was der Assistent darf:

- **Objekt-Lesezugriff** — nur Geräte/Räume/Funktionen, oder beliebige Objekte.
- **States schreiben** (Geräte steuern), **Objekt-/Datei-Änderungen** (gefährlich), **Logs** lesen,
  **Historie**, **Dateien**, **Systeminfos**, ins **Log** schreiben.
- **Geräte-ACL** (Reiter Geräte) — eine Liste aller erkannten Geräte (Typ + Raum). Pro Gerät kannst du
  **Lesen** und **Schreiben** einzeln erlauben/verbieten. Schlösser sind standardmäßig schreibgeschützt;
  Sensoren/Kameras sind nur lesbar. Buttons werden überall ausgeblendet. Du kannst ein Gerät auch
  **umbenennen** (mehrsprachig) und den Namen automatisch **übersetzen** lassen.

Die Rechte gelten für **alle** Stufen (Regel-Engine, lokales LLM, Cloud-LLM).

---

## 6. Sprache — das Satelliten-Konzept

Sprache ist optional und standardmäßig aus. Aktiviere **Sprache aktivieren (STT/TTS)** im Reiter
**Voice**. Damit werden Spracherkennung/-synthese verfügbar; **es wird kein Netzwerk-Port geöffnet**. Dann
wähle:

- **Voice-Sprache** — für STT und die vorgelesene Antwort.
- **Spracherkennungs-Anbieter** — OpenAI, Azure, AWS oder **Vosk** (lokal, offline).
- **Sprachausgabe-Anbieter** — OpenAI, Azure, AWS oder **Piper** (lokal, offline).
- Anbieter-Schlüssel (getrennt vom LLM-Schlüssel; eine *Sprach-Schlüssel-Quelle* spiegelt manual/manager).
  Stimmen und lokale Modelle laden in Dropdowns.

### Arten von Satelliten / Transporten

|                   | **ioBroker-nativer Satellit** (empfohlen)             | **UDP-Satellit** (ESP / Hannah)                     | **ESPHome-Satellit** (ThirdReality, HA Voice PE)                                       |
|-------------------|-------------------------------------------------------|-----------------------------------------------------|----------------------------------------------------------------------------------------|
| Adapter           | `ioBroker.assistant-satellite` auf dem Gerät          | ESP-Firmware, oder derselbe Adapter im UDP-Modus    | keiner — die Werks-Firmware des Geräts                                                 |
| Transport         | Audio über den ioBroker-**Nachrichtenbus** (`sendTo`) | Roher Audio-**UDP-Stream** (Hannah-Protokoll)       | ESPHome-Native-API über **TCP 6053**; der Adapter wählt das Gerät an                   |
| Port am Assistant | **keiner**                                            | UDP-Port (*UDP-Sprach-Server betreiben* aktivieren) | keiner eingehend — aber ein HTTP-**Medien-Server**, von dem das Gerät die Antwort holt |
| STT/TTS           | zentral, im Assistenten                               | zentral, im Assistenten                             | zentral, im Assistenten                                                                |
| Am besten für     | Raspberry Pi / PC-Satelliten                          | ESP32-Geräte, bestehende Hannah-Satelliten          | fertige Sprach-Lautsprecher, die man nicht flashen will                                |

- Für **ioBroker-native** Satelliten brauchst du am Assistant nichts außer *Sprache aktivieren*.
- Für **ESP/UDP**-Satelliten zusätzlich **UDP-Sprach-Server betreiben** aktivieren (öffnet den UDP-Port).
- Für **ESPHome**-Satelliten **Auch ESPHome-Sprachsatelliten ansteuern** aktivieren — siehe unten.
- **Wyoming**: optional den **Wyoming-TCP-Endpunkt** aktivieren, damit `wyoming-satellite` und andere
  Rhasspy-Clients an den Assistenten streamen können (Standard-Port 10700). Achtung: ESPHome-Voice-Geräte
  — **auch der Home Assistant Voice PE** — sprechen *kein* Wyoming; dafür ist der ESPHome-Transport da.

### ESPHome-Sprachsatelliten (ThirdReality, HA Voice PE)

Fertige Sprach-Lautsprecher mit dem **ESPHome-Voice-Assistant** — der ThirdReality *Voice & Music
Assistant*, der *Home Assistant Voice PE* oder jede Kiste mit `linux-voice-assistant` — funktionieren
andersherum als alle anderen Transporte: Sie verbinden sich nicht zu einem Server, sie **sind** einer und
warten auf **TCP 6053**. Der Adapter wählt also *sie* an, so wie Home Assistant es täte.

Auf dem Gerät muss nichts installiert oder geflasht werden, und ESPHome-Werkzeuge braucht es auch nicht —
„ESPHome-Native-API" ist bloß der Name des Protokolls, das die Werks-Firmware ohnehin spricht.

1. Im Reiter **Voice** die Option **Auch ESPHome-Sprachsatelliten ansteuern** aktivieren.
2. Pro Gerät eine Zeile anlegen: **Adresse** (z. B. `192.168.1.195`), **Port** (leer = 6053), **Raum** und
   ein **Passwort** nur dann, wenn am Gerät wirklich eins gesetzt ist.
3. Speichern. Der Adapter verbindet sich, loggt Gerätename und aktives Wake-Word, und der Satellit
   erscheint wie jeder andere unter `assistant.0.satellites.*`.

Wake-Word, Echo-Unterdrückung und Wiedergabe bleiben auf dem Gerät; der Adapter macht Spracherkennung,
Antwort und Sprachausgabe. Durchsagen (`tts.text`, `satellites.<id>.tts`, Timer, Wecker) erreichen diese
Geräte ebenfalls.

Zwei Dinge laufen hier anders:

- **Der Adapter entscheidet, wann du fertig geredet hast.** Diese Geräte streamen, bis der Server sie
  stoppt — die Sprachende-Erkennung läuft also im Adapter. Über **Sprachende nach (ms Stille)**
  (Standard 900) justieren, falls dir die Antwort ins Wort fällt oder der Assistent zu lange wartet.
- **Die gesprochene Antwort wird geholt, nicht geschickt.** Das Gerät spielt eine URL ab, deshalb betreibt
  der Adapter einen kleinen HTTP-Server (**Port des Medien-Servers**, Standard `8099`), der jeden Clip ein paar
  Minuten lang ausliefert. Er muss **vom Gerät aus** erreichbar sein; die Adresse wird automatisch aus der
  jeweiligen Geräteverbindung genommen und muss nur hinter NAT, Docker oder VLAN von Hand gesetzt werden.

#### Wake-Words

Das Wake-Word läuft **auf dem Gerät**, welche seiner eingebauten Modelle lauschen, lässt sich aber von hier
aus setzen. Jeder Satellit bekommt dafür zwei States:

| State                                |                                                                                                                                      |
|--------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------|
| `satellites.<id>.availableWakeWords` | nur lesbar, JSON: alle Modelle der Firmware mit gesprochener Phrase, trainierten Sprachen und wie viele gleichzeitig lauschen dürfen |
| `satellites.<id>.wakeWords`          | schreibbar, ids kommagetrennt, z. B. `okay_nabu,hey_jarvis`                                                                          |

Du schreibst die gewünschten ids hinein, das Gerät stellt um — und der Wert wird vom Gerät
zurückgelesen, du siehst also immer den echten Zustand. Unbekannte ids werden mit einer Warnung
verworfen, eine zu lange Liste wird gekürzt, statt den ganzen Schreibvorgang stillschweigend zu
schlucken. Das Gerät merkt sich die Auswahl selbst, sie übersteht also einen Neustart des Adapters.

Aus einem Skript:

```js
sendTo('assistant.0', 'getWakeWords', {}, r => log(JSON.stringify(r)));
sendTo('assistant.0', 'setWakeWords', { device: '3RSPK-…', wakeWords: ['okay_nabu'] });
```

Ein ThirdReality-Lautsprecher bringt neun Modelle mit, aktiv ist `okay_nabu`, zwei Plätze sind frei.
Wichtig vor dem Umstellen: **nur `okay_nabu` ist auf mehr als Englisch trainiert** (en, nl, fr, de, it,
es, sv) — auf einem deutschen System ist die Werkseinstellung also zugleich die beste Wahl.

#### Geräte-Einstellungen

Im Reiter **Satelliten** der Instanz-Einstellungen hat jede Zeile einen Zahnrad-Knopf, der die
Geräte-Einstellungen öffnet — Wake-Words als anklickbare Chips (mit der Maus darüber siehst du die
trainierten Sprachen) und für jede Stellschraube des Geräts das passende Bedienelement. Bei einem
Offline-Satelliten ist der Knopf deaktiviert, denn die Einstellungen liegen auf dem Gerät.

Dieselben Werte gibt es auch als States unter `satellites.<id>.controls.*` — aufgebaut aus dem, was das
Gerät selbst meldet. Eine Home Assistant Voice PE bekommt so ihren eigenen Satz, ohne dass hier etwas
geändert werden muss. Ein ThirdReality-Lautsprecher bietet zwölf:

| Control                                                                 |                                                                                                    |
|-------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------|
| `mic_gain`, `mic_volume`                                                | Mikrofon-Verstärkung (0–31) und -Lautstärke (1–4000)                                               |
| `mic_noise`                                                             | Rauschunterdrückung: Off / Low / Medium / High / Max                                               |
| `wake_word_1_sensitivity`, `wake_word_2_sensitivity`                    | je eine pro Wake-Word-Platz, 0–1                                                                   |
| `stop_word_sensitivity`                                                 | wie leicht das Stop-Wort eine Antwort unterbricht, 0–1                                             |
| `continue_conversation_delay`                                           | wie lange das Mikro für eine Nachfrage offen bleibt, 0–10 s                                        |
| `mute`, `thinking_sound`                                                | Mikrofon stumm und der „Denk“-Ton                                                                  |
| `<media player>.{state,volume,command,muted}`                           | `command` nimmt play, pause, stop, mute, unmute, toggle, volume_up, volume_down, turn_on, turn_off |
| `<firmware>.{currentVersion,latestVersion,inProgress,progress,install}` | `install` ist ein Button                                                                           |

Schreibvorgänge werden **nicht** optimistisch bestätigt: das Gerät meldet zurück, was es tatsächlich
übernommen hat, und genau das steht im State. Eine Zahl außerhalb des Geräte-Bereichs wird darauf
geklemmt statt verworfen; ein Wert, den ein `select` nicht kennt, wird mit einer Warnung samt gültiger
Optionen abgelehnt.

```js
sendTo('assistant.0', 'getControls', {}, r => log(JSON.stringify(r)));
sendTo('assistant.0', 'setControl', { device: '3RSPK-…', control: 'mic_volume', value: 2400 });
```

Wenn dich der Assistent zu leise hört — die Log-Zeile nach jeder Äußerung nennt Spitzenpegel und
Rauschboden —, sind `mic_volume` und `mic_gain` die beiden Stellschrauben.

#### Timer auf dem Gerät

Satelliten, die das ESPHome-Feature *timers* melden, bekommen die Countdown-Timer des Assistenten
übertragen und können sie auf ihrem eigenen LED-Ring anzeigen und selbst klingeln lassen. Ein per
Sprache gesetzter Timer geht an den Satelliten, an dem er gesetzt wurde; einer aus Chat, Telegram oder
einem Skript an alle.

### Was wo läuft

- **Auf dem Satelliten:** Mikrofon-Aufnahme, **Wake-Word-Erkennung** (OpenWakeWord), Aufnahme, Wiedergabe.
- **Im Assistenten:** STT → Antwort (die gestufte Pipeline) → TTS. So bleiben Schlüssel und Konfiguration
  an **einem** Ort.

---

## 7. Einen Satelliten einrichten

Auf jedem Raum-Gerät (z. B. einem Raspberry Pi):

1. Installiere den **ioBroker.assistant-satellite**-Adapter und lege eine Instanz an (Node.js ≥ 22,
   **ffmpeg** installiert).
2. In den Einstellungen:
   - **Assistant-Instanz** — wähle deine `assistant.0`.
   - **Transport** — auf **ioBroker** lassen (empfohlen; kein Port). **UDP** nur für ESP-Kompatibilität.
   - **Audio-Backend** — *Auto* (ALSA unter Linux, ffmpeg sonst).
   - **Mikrofon-/Lautsprecher-Gerät** — aus dem Dropdown wählen. Auf einem Pi ein ALSA-Hardware-Gerät wie
     **`plughw:2,0`** nehmen (Kartennummer via `arecord -l` / `aplay -l` finden). **Nicht** `default` —
     das hat oft keinen Capture-Slave.
   - **Raum** — der Raumname.
   - **Wake-Word** — siehe §8.
   - **Folge-Gespräch** *(optional)* — hält das Mikro nach einer Antwort kurz offen, damit du fortsetzen
     kannst (*„…und die Küche auch"*), ohne das Wake-Word zu wiederholen; nach Stille zurück zum Wake-Word-
     Modus. Nutzt den Gesprächskontext (§2), damit Rückfragen natürlich aufgelöst werden.
3. Speichern. Der Satellit lädt beim ersten Start das Wake-Word-Modell und hört dann zu.

> **Standalone (ohne ioBroker):** Die Core-Library `@iobroker/assistant-satellite` läuft auch eigenständig
> (z. B. auf einer ESP-nahen Box) über UDP — kein js-controller nötig. Dieser Weg nutzt den UDP-Transport.

---

## 8. Wake-Word

- **Eingebaute Wörter:** `hey_jarvis`, `alexa`, `hey_mycroft`, `hey_rhasspy` — einfach eins wählen.
- **Mehrere Wörter:** du kannst bis zu **drei** Wake-Words konfigurieren; der Satellit reagiert auf jedes.
- **Schwelle:** niedriger = empfindlicher (mehr Fehlauslöser). Pro Gerät justieren.
- **Test-Button:** die Einstellungen zeigen ein interaktives **Wake-Word testen**-Panel — klicken, das Wort
  sagen, und **Mikrofon-Pegel** sowie **Wake-Word-Score** live steigen sehen; bei Erkennung leuchtet ein
  Banner auf. Ideal, um Gerät und Schwelle zu finden. (Instanz muss laufen; der Satellit wird während des
  Tests kurz pausiert.)

### Eigenes Wake-Word (z. B. „ioBroker")

Das Feld `wakewordModel` akzeptiert auch eine **URL** oder einen **lokalen `.onnx`-Pfad**. Für eine eigene
Phrase trainierst du dafür ein OpenWakeWord-Modell (es synthetisiert Sprachbeispiele und trainiert einen
kleinen Klassifikator) und trägst den Pfad zur entstandenen `.onnx` ein. Ein reproduzierbares
AWS/Terraform-Trainings-Setup ist separat dokumentiert (das Projekt `wakeword-training`). Eigene Wörter sind
etwas weniger robust als die eingebauten — Schwelle justieren.

---

## 9. Durchsagen (Text-to-Speech an Satelliten)

Einen Satelliten ohne Frage sprechen lassen:

- **Alle Satelliten:** Text (oder einen mp3/wav-Pfad/URL) in **`assistant.0.tts.text`** schreiben.
- **Ein Satellit:** in **`assistant.0.satellites.<id>.tts`** schreiben.

Text wird mit der konfigurierten TTS-Engine synthetisiert; eine Audiodatei wird dekodiert und direkt
abgespielt.

### Sprach-Engines: Kosten, Latenz und was passiert, wenn die Cloud weg ist

Vier Einstellungen, die sich meist selbst bezahlen:

- **Speech-to-Text-/Text-to-Speech-Reserve** (Tab Voice) — eine zweite Engine, die einspringt, wenn die
  erste ausfällt: Störung, abgelaufener Key, leeres Guthaben. Mit `Vosk (lokal)` und `Piper (lokal)`
  hinter einem Cloud-Anbieter hört und antwortet das Haus auch ohne Internet weiter. Die Übergabe steht
  im Log.
- **Gesprochener Text wird auf Platte gecacht.** Der Assistent sagt dieselben kurzen Dinge immer wieder
  ("Ok.", "Timer abgelaufen"), und sie erneut zu synthetisieren kostet eine Cloud-Runde und eine halbe
  Sekunde Latenz für identisches Audio. Kurze Texte (bis 200 Zeichen) liegen deshalb im Datenverzeichnis
  der Instanz, mit Text, Sprache, Anbieter und Stimme als Schlüssel — nach einem Stimmenwechsel wird also
  nichts Altes mehr ausgespielt. Lange Einmal-Antworten werden nicht gecacht, und der Cache räumt sich
  selbst auf 64 MB zurück.
- **Schaltbefehle mit einem Ton bestätigen** (Tab Einstellungen) — ein erfolgreicher Schaltbefehl
  antwortet mit einem kurzen Ton statt mit einem Satz. Sofort, während Sprechen einen
  Text-to-Speech-Aufruf kostet. Fragen, Fehler und die Textkanäle sind davon unberührt, Timer und Wecker
  ebenfalls.
- **Geräte-Rückmeldung prüfen** (Tab Einstellungen) — nach einem Schaltbefehl bis zu 2 Sekunden auf die
  Bestätigung des Geräts warten (`ack:true`) und "hat nicht reagiert" sagen, wenn sie ausbleibt. Bei
  Geräten, die nie bestätigen (MQTT, Skripte, `0_userdata`), **ausgeschaltet** lassen: sonst sieht jeder
  Befehl fehlgeschlagen aus.

Zwei Dinge passieren ohne jede Einstellung: eine Antwort über 400 Zeichen wird **am letzten passenden
Satzende abgeschnitten** (ein vorgelesener Absatz ist eine Minute, die niemand unterbrechen kann), und
eine Durchsage in **SSML** (`<speak>…</speak>`) wird von Azure und Polly als SSML gesprochen — mit Pausen
und Betonung —, während die übrigen Engines den Text ohne Markup bekommen, statt die Tags vorzulesen.

### Gruppen und Personen als Ziel

Gib einer Gruppe von Satelliten in der Tabelle **Durchsage-Ziele** im Tab Voice einen Namen — dann kann
alles, was ansagt, sie ansprechen: eine Gruppe von Räumen oder die Lautsprecher einer Person.

| Spalte                            | Beispiel                                      |
|-----------------------------------|-----------------------------------------------|
| **Name**                          | `Obergeschoss`, `Denis`                       |
| **Satelliten, Räume oder Geräte** | `bad_oben, schlafzimmer` — mit Komma getrennt |
| **Art**                           | leer oder `group`, oder `person`              |

Das gilt überall, wo ein Ziel erlaubt ist — der `tts`-State pro Satellit, `notify`, die Spalte **Room**
eines Triggers und `askUser` (eine Frage geht an alle Mitglieder, die erste Antwort zählt):

```js
sendTo('assistant.0', 'notify', { text: 'Das Essen ist fertig', target: 'Denis' });
sendTo('assistant.0', 'askUser', { question: 'Soll ich die Rollos zumachen?', room: 'Obergeschoss' }, cb);
```

Und per Sprache, denn der Assistent hat ein **`announce`**-Tool: *„Sag Denis, dass das Essen fertig ist"*
landet auf seinen Lautsprechern, *„sag allen oben, dass die Waschmaschine fertig ist"* in dieser Gruppe.
Die konfigurierten Namen stehen in der Tool-Beschreibung, das Modell kennt sie also.

Ein echter Satellit oder Raum gleichen Namens gewinnt immer gegen eine Gruppe — eine Gruppe nach einem
Raum zu benennen kann dessen Lautsprecher also nie unerreichbar machen. `all` (oder gar kein Ziel) heißt
„alle Satelliten". Der Text wird für eine ganze Gruppe **einmal** synthetisiert, nicht pro Lautsprecher.

### Lautstärke, Stumm, Nicht stören

„Nicht stören" setzt der Assistent selbst durch und gilt damit für **jede** Art von Satellit:

- **`assistant.0.dnd`** — Durchsagen auf allen Satelliten unterdrücken.
- **`assistant.0.satellites.<id>.dnd`** — nur auf einem Satelliten.

Antworten auf deine eigenen Fragen laufen immer, ebenso Timer und Wecker, die du selbst gestellt hast:
„Nicht stören" stoppt Durchsagen, die niemand angefordert hat — nicht das, was du angefordert hast.

Ein ioBroker-nativer Satellit hat zusätzlich seine eigenen beschreibbaren States; sie steuern den
ALSA-Mixer des Lautsprechers und gelten damit für Antworten, Durchsagen und den Beep gleichermaßen:

- **`assistant-satellite.<n>.volume`** — 0–100 %.
- **`assistant-satellite.<n>.mute`** — Lautsprecher stummschalten.
- **`assistant-satellite.<n>.dnd`** — das „Nicht stören" des Satelliten selbst.

**Priority-Durchsagen:** beginnt der Durchsage-Text mit **`!`**, wird das `!` entfernt und die Durchsage
läuft **auch bei „Nicht stören"** — z. B. `!Wasserleck im Keller`.

### Gesprochene Systemmeldungen

ioBrokers Benachrichtigungen sind für eine Log-Ansicht geschrieben: `system.host.pi: admin.0: …`,
Versionsnummern, `M/D/YYYY`-Zeitstempel. Wörtlich vorgelesen sind sie unzumutbar; der Assistent entfernt
deshalb die Herkunfts-Präfixe und lässt das LLM **einen gesprochenen Satz** daraus machen, im Ton der
Severity (**Systemmeldungen umformulieren** im Tab Einstellungen, standardmäßig an; ein kleiner LLM-Aufruf
pro Meldung, bei einem Fehler wird der Originaltext gesprochen).

| Severity            | Ton                                         | Nicht stören                                      |
|---------------------|---------------------------------------------|---------------------------------------------------|
| `alert`             | klar und dringlich                          | **wird ignoriert** — ein Alert ist immer zu hören |
| `notify` (Standard) | locker und direkt                           | wird beachtet                                     |
| `info`              | beiläufig erwähnt                           | wird beachtet                                     |
| `direct`            | gar nicht umformuliert, wörtlich gesprochen | wird beachtet                                     |

Über States:

- **`assistant.0.notify.text`** — eine Meldung schreiben (Severity `notify`).
- **`assistant.0.notify.alert`** — eine dringende schreiben (ignoriert „Nicht stören").
- **`assistant.0.notify.last`** — lesen, was zuletzt gesprochen wurde.

Aus einem Skript, mit Severity und optionalem Raum:

```js
sendTo('assistant.0', 'notify', { text: 'Backup fertig', severity: 'info' });
sendTo('assistant.0', 'notify', { text: 'Wasserleck im Keller', severity: 'alert', room: 'Küche' }, res =>
    log(`auf ${res.spoken} Kanal/Kanälen gesprochen`),
);
```

**ioBroker-Benachrichtigungsmanager:** der Assistent meldet sich als Benachrichtigungs-Ziel an
(`supportedMessages.notifications`), lässt sich also im Adapter *notification-manager* als Ausgabe für
beliebige Benachrichtigungs-Kategorien auswählen — Host-Probleme, fehlgeschlagene Updates, Plattenplatz.
Die kommen dann mit ihrer eigenen Severity hier an und werden genauso gesprochen.

### Rückfrage: der Assistent fragt *dich*

Die andere Richtung eines Gesprächs: ein Skript stellt eine Frage über einen Satelliten, der Satellit
spricht sie aus und **öffnet sein Mikrofon ohne Wake-Word** — die Antwort kommt zurück ins Skript.

```js
sendTo('assistant.0', 'askUser', { question: 'Die Friteuse ist noch an. Soll ich sie ausschalten?', room: 'Küche' }, res => {
    if (res.timeout) { log('niemand hat geantwortet'); return; }
    log(`Antwort: ${res.answer}`);           // die gesprochene Antwort, wörtlich
});
```

| Feld        | Bedeutung                                                                                                                                    |
|-------------|----------------------------------------------------------------------------------------------------------------------------------------------|
| `question`  | Die Frage (Pflichtfeld).                                                                                                                     |
| `room`      | Auf dem Satelliten in diesem Raum fragen.                                                                                                    |
| `target`    | Auf einem Satelliten fragen, per State-Id (`satellites.kueche`, `kueche`) oder Gerätename.                                                   |
| *(keins)*   | Auf **allen** Satelliten fragen — die erste Antwort gewinnt.                                                                                 |
| `source`    | Stattdessen einen Textkanal scharf stellen (`chat`, `telegram:Max`): es wird nichts gesprochen, die nächste Nachricht dort gilt als Antwort. |
| `timeoutMs` | Wartezeit, Standard `60000`.                                                                                                                 |

Die Antwort ist `{ answer: '…' }`, oder `{ timeout: true }`, wenn niemand rechtzeitig etwas gesagt hat,
oder `{ error: '…' }`, wenn die Frage nicht gestellt werden konnte (unbekannter Raum, kein Satellit
erreichbar).

Solange eine Frage offen ist, wird das Nächste auf diesem Satelliten **nicht** als Befehl interpretiert —
ein bloßes „ja" geht an dein Skript statt an die Regel-Engine. Der Assistent selbst sagt dazu nichts, dein
Skript entscheidet also über die Reaktion (in `satellites.<id>.tts` schreiben). Eine neue Frage ersetzt
eine ältere für denselben Satelliten, und der Timeout gibt ihn in jedem Fall wieder frei.

**Mikrofon-Unterstützung:** ESPHome-Satelliten öffnen das Mikrofon selbst (die Frage wird mit
`start_conversation` gesendet). ioBroker-native und UDP-Satelliten bekommen die Aufforderung zuzuhören;
ob sie das können, hängt an ihrer Firmware — wenn nicht, funktioniert die Antwort trotzdem, braucht aber
vorher das Wake-Word.

---

## 10. Proaktive Trigger

Ein Trigger lässt den Assistenten **von selbst** anfangen. Er beobachtet States oder die Uhr und sagt dann
etwas, schreibt einen State oder - das Spannende - **stellt dir eine Frage und handelt nach deiner
Antwort**. Konfiguriert werden sie im Tab **Trigger**, eine Zeile pro Trigger.

### Die Felder

| Spalte                      | Bedeutung                                                                        |
|-----------------------------|----------------------------------------------------------------------------------|
| **Id**                      | Kurze, eindeutige Id; gleichzeitig der Name seiner `triggers.items.<id>`-States. |
| **Name**                    | Freie Bezeichnung für Log und States.                                            |
| **Wenn (JSON)**             | Die Bedingung - siehe unten.                                                     |
| **Room**                    | Wo gesprochen bzw. wer gefragt wird. Leer = alle Satelliten.                     |
| **Ansage**                  | Was angesagt wird.                                                               |
| **Rückfrage**               | Stattdessen fragen und nach der Antwort entscheiden (braucht Antwortregeln).     |
| **Antwortregeln (JSON)**    | Was mit der Antwort passiert - siehe unten.                                      |
| **Weitere Aktionen (JSON)** | Mehr als eine Sache tun, z. B. ansagen *und* schalten.                           |
| **Verzögerung**             | Vorher warten: `90s`, `30m`, `5h`, `2d`.                                         |
| **Cooldown (s)**            | Mindestabstand zweier Auslösungen. Standard 3600, `0` = keiner.                  |

### Bedingungen

```json
{ "state": "javascript.0.fenster.wohnzimmer", "value": true }
{ "state": "hm-rpc.0.ABC.1.TEMPERATURE", "below": 12 }
{ "time": "23:00", "days": [1, 2, 3, 4, 5] }
```

Eine State-Bedingung feuert beim **Übergang in** die Bedingung - ein Gerät, das denselben Wert wiederholt,
ändert nichts. Ohne `value`/`above`/`below` zählt jede Änderung. Eine Zeit-Bedingung feuert zur genannten
Uhrzeit an den angegebenen Wochentagen (0 = Sonntag ... 6 = Samstag; weglassen heißt täglich).

Eine **Liste** steht für Alternativen (eine genügt); `also` (muss ebenfalls gelten) und `unless` (sperrt,
solange es gilt) verfeinern eine Bedingung:

```json
[
  {
    "state": "javascript.0.fenster.wohnzimmer",
    "value": true,
    "also": { "state": "hm-rpc.0.ABC.1.TEMPERATURE", "below": 12 },
    "unless": { "state": "0_userdata.0.abwesend", "value": true }
  },
  { "time": "22:30" }
]
```

`also` akzeptiert auch eine Liste (alle müssen gelten) oder `{"op":"or","conditions":[...]}`. Ein State,
der nicht gelesen werden kann, lässt `also` scheitern (wir behaupten keine Bedingung, die wir nicht prüfen
können), sperrt bei `unless` aber **nicht** - ein Schloss, das versehentlich auslöst, ist schlimmer als
eines, das wartet.

### Fragen statt ansagen

```text
Rückfrage:      Die Friteuse ist seit 5 Stunden an. Soll ich sie ausschalten?
Wenn (JSON):    {"state":"shelly.0.friteuse.Relay0.Switch","value":true}
Verzögerung:    5h
Antwortregeln:  [{"match":"Zustimmung","say":"Okay, schalte ich aus.",
                  "setState":{"id":"shelly.0.friteuse.Relay0.Switch","value":false}},
                 {"match":"Verneinung","say":"Alles klar, lass ich an."},
                 {"say":"Das habe ich nicht verstanden."}]
```

Die Frage wird auf dem Satelliten gesprochen, danach öffnet sich sein Mikrofon ohne Wake-Word (siehe
Abschnitt 9). Die Antwort wird vom LLM gegen das `match` jeder Regel geprüft - beliebige Formulierung,
beliebige Sprache, "ja, mach das" trifft also `Zustimmung`. Es greift die **erste** passende Regel; eine
Regel **ohne** `match` ist der Auffang für eine Antwort, die zu keiner passt. Antwortet niemand innerhalb
einer Minute, passiert nichts.

Mit `"cancelWhen"` wird eine laufende Verzögerung abgebrochen - im Beispiel
`{"state":"shelly.0.friteuse.Relay0.Switch","value":false}`, damit die Frage entfällt, wenn du die
Friteuse selbst ausschaltest.

### Steuerung zur Laufzeit

- **`triggers.enabled`** - Hauptschalter; solange er aus ist, sagt und schreibt kein Trigger etwas.
- **`triggers.items.<id>.enabled`** - einen einzelnen Trigger abschalten (übersteht einen Neustart).
- **`triggers.items.<id>.fire`** - jetzt ausführen, ohne Cooldown und Verzögerung. So testet man einen.
- **`triggers.items.<id>.{lastFired,nextFireAt,pendingUntil}`** - wann er zuletzt lief, wann er das
  nächste Mal läuft und wann eine wartende Verzögerung fällig ist.
- Aus einem Skript: `sendTo('assistant.0', 'listTriggers', {}, cb)`, `fireTrigger` /
  `setTriggerEnabled` mit `{ id, enabled }`.

**States schreiben** folgt der Berechtigung des Assistenten: ein Trigger schreibt nur, wenn im Tab Geräte
die **Gerätesteuerung** erlaubt ist. Ansagen sind davon unberührt.

Mit **Trigger-Texte vom LLM umformulieren lassen** formuliert das Modell den Text vor dem Sprechen um,
damit eine tägliche Ansage nicht wie eine Aufnahme klingt. Das kostet einen kleinen LLM-Aufruf; schlägt er
fehl, wird der Originaltext genutzt.

---

## 11. Timer, Wecker, Töne und was er sich merkt

### Timer und Wecker

Beide werden in normaler Sprache gestellt — deutsch, englisch oder russisch — und beide erledigt die
Offline-Engine ohne Cloud-Aufruf:

- **Timer** (Countdown) — „stell einen Timer auf 10 Minuten", „Timer 1 Stunde 30 Minuten für die
  Wäsche", „wie lange noch?", „Timer abbrechen".
- **Wecker** (feste Uhrzeit, optional wiederkehrend) — „weck mich um 7", „Wecker um 6:30 wochentags",
  „welche Wecker habe ich?", „lösch den Wecker".

Die Engine unterscheidet die zwei daran, was du gesagt hast, nicht am verwendeten Wort: „weck mich in 5
Minuten" ist ein Timer, „Timer um 5 Minuten" ist kein Wecker.

Es wird nichts gepollt: jeder Timer und Wecker feuert aus seinem eigenen Timeout, und die States tragen
nur den absoluten Zeitstempel (`fireAt` / `nextFireAt`) — die Restzeit rechnet ein Vis-Widget oder ein
Skript selbst aus. Sie überstehen einen Neustart (persistiert in `timers.list` / `alarms.list`); ein
einmaliger Wecker, dessen Zeit während der Ausfallzeit verstrich, wird verworfen statt verspätet
auszulösen.

| State                                                                    |                                                                        |
|--------------------------------------------------------------------------|------------------------------------------------------------------------|
| `timers.{count,list,nextExpiry,nextLabel,lastFired}`                     | wie viele, alle als JSON, wann der nächste fällig ist und wie er heißt |
| `timers.items.<id>.{label,room,duration,fireAt,cancel}`                  | ein Kanal pro Timer; `cancel` ist ein Knopf                            |
| `timers.cancelAll`                                                       | Knopf: alle verwerfen                                                  |
| `alarms.{count,list,nextAlarm,nextLabel,lastFired}`                      | dasselbe für Wecker                                                    |
| `alarms.items.<id>.{label,room,time,weekdays,nextFireAt,enabled,delete}` | `enabled` schaltet einen ab, ohne ihn zu löschen                       |
| `alarms.cancelAll`                                                       | Knopf                                                                  |

Aus einem Skript:

```js
sendTo('assistant.0', 'setTimer', { duration: '10 min', label: 'Nudeln', room: 'Küche' }, r => log(r.id));
sendTo('assistant.0', 'setAlarm', { time: '06:30', weekdays: [1, 2, 3, 4, 5], label: 'Arbeit' });
sendTo('assistant.0', 'listTimers', {}, r => log(JSON.stringify(r)));
```

Ein per Sprache gestellter Timer sagt sich auf dem Satelliten an, an dem er gestellt wurde; einer aus
Chat, Telegram oder einem Skript überall. Auf einem Satelliten, der das ESPHome-Feature *timers* meldet,
laufen Timer zusätzlich auf dem LED-Ring des Geräts mit.

### Töne und Klingeln

Ein Timer oder Wecker kann einen Ton abspielen, bevor er spricht. Zwei sind vorinstalliert (`timer.wav`,
`alarm.wav`); eigene mp3/wav-Dateien lädst du im Tab Einstellungen hoch, sie landen in
`assistant.0/sounds/`. Unter **Timer-Ton** / **Wecker-Ton** wählst du pro Zweck einen aus — leer lassen
heißt: nur sprechen.

**Klingeldauer (Sekunden)** entscheidet, wie lange es weitergeht: über 0 wiederholt sich der Ton, bis
jemand ihn stoppt, und die Ansage kommt einmal dazwischen. Stoppen geht **per Sprache** — „Stopp",
„Halt", „aufhören" — und solange etwas klingelt, gewinnt dieses Wort immer gegen alles andere; außerdem
über den State `stopRinging` oder aus einem Skript. `ringing` sagt dir, ob gerade etwas klingelt.

```js
sendTo('assistant.0', 'playSound', { sound: 'tuerklingel.mp3', room: 'Küche' });
sendTo('assistant.0', 'stopRinging', {});
```

Töne abspielen braucht **ffmpeg** auf dem ioBroker-Host (es dekodiert mp3/wav zu Rohaudio); fehlt es,
wird trotzdem die Ansage gesprochen.

### Langzeit-Gedächtnis

Mit **Langzeit-Gedächtnis** (Standard an) kann sich der Assistent Dinge über Sitzungen hinweg merken —
Namen, Vorlieben, wo etwas liegt — und bekommt sie in späteren Gesprächen wieder in seinen Kontext. Er
entscheidet das selbst: „merk dir, dass das Katzenfutter in der Speisekammer steht" wird gespeichert, „was
habe ich über die Katze gesagt?" liest es zurück. Dafür gibt es Tools (`remember`, `list_memories`,
`forget`), du musst also keine States schreiben.

Alles ist sichtbar und editierbar, denn ein Gedächtnis, in das man nicht hineinsehen kann, ist
unheimlich:

| State                                              |                                                                         |
|----------------------------------------------------|-------------------------------------------------------------------------|
| `memory.count` / `memory.list`                     | wie viele Fakten, und alle als JSON                                     |
| `memory.items.<id>.text`                           | der Fakt selbst — **editierbar**, einfach überschreiben zum Korrigieren |
| `memory.items.<id>.{key,source,createdAt,delete}`  | woher er kam, wann, und ein Löschknopf                                  |
| `memory.add` / `memory.forget` / `memory.clearAll` | Fakt schreiben / per Id oder Text vergessen / alles leeren              |

```js
sendTo('assistant.0', 'saveMemory', { text: 'Der Gästezimmerschlüssel liegt in der Flurschublade' });
sendTo('assistant.0', 'listMemories', {}, r => log(JSON.stringify(r)));
sendTo('assistant.0', 'forgetMemory', { text: 'Gästezimmerschlüssel' });
```

Fakten werden dedupliziert und begrenzt, und die ganze Liste wird dem System-Prompt vorangestellt — halte
sie also auf Dinge, die zählen, statt auf ein Tagebuch.

---

## 12. Fehlerbehebung

- **Kein Mikrofon-Ton / `arecord: capture slave is not defined` / `Device or resource busy`** — das Mic-
  Gerät ist falsch. Auf ein echtes Aufnahmegerät wie `plughw:2,0` (aus `arecord -l`) setzen, nicht
  `default`. Auf dem Gerät prüfen: `arecord -D plughw:2,0 -f S16_LE -c1 -r16000 -d3 /tmp/t.wav && aplay /tmp/t.wav`.
- **Wake-Word wird nicht erkannt** — deutlich sprechen, näher rangehen, Schwelle senken; den Score im Test-
  Panel beobachten. Eigene Modelle brauchen ggf. mehr Trainings-Samples.
- **„No API key configured"** — den LLM-Schlüssel im Settings-Reiter eintragen (oder Zugangsdaten wählen).
- **Satellit erreicht den Assistant nicht** — die Assistant-Instanz muss **laufen**; für ioBroker-nativen
  Transport ist sonst nichts nötig, für UDP Port/Host prüfen.
- **Voice-Tab-Optionen ausgeblendet** — zuerst **Sprache aktivieren (STT/TTS)**.
- **ESPHome-Satellit bleibt offline** — der Adapter wählt das Gerät an, also muss das *Gerät* auf TCP 6053
  erreichbar sein (`nc -vz <ip> 6053`). Adresse prüfen — und ob nicht schon ein anderer Controller (z. B.
  eine Home-Assistant-Instanz) die Voice-Assistant-Subscription des Geräts hält.
- **ESPHome-Satellit hört zu, bleibt aber stumm** — er holt die Antwort per HTTP, der **Medien-Server** muss
  also *vom Gerät aus* erreichbar sein. Firewall der ioBroker-Maschine für den Port des Medien-Servers
  (Standard `8099`) prüfen und **Adresse des Medien-Servers für die Geräte** von Hand setzen, falls das Gerät
  diese Maschine unter einer anderen Adresse erreicht.

---

## 13. States-Übersicht

| State                                                      | Bedeutung                                                             |
|------------------------------------------------------------|-----------------------------------------------------------------------|
| `info.connection`                                          | Assistent bereit                                                      |
| `text.request` / `text.response`                           | Frage stellen / Antwort lesen                                         |
| `text.querySource`                                         | Herkunft der letzten Anfrage (`''`, `chat` oder ein Satelliten-Name)  |
| `tts.text`                                                 | Durchsage an **alle** Satelliten (Text oder Audio-Pfad)               |
| `satellites.<id>.{status,room,alive,lastSeen,tts}`         | Zustand pro Satellit + Durchsage                                      |
| `triggers.enabled` / `triggers.count` / `triggers.list`    | proaktive Trigger: Hauptschalter, Anzahl, Live-Status (JSON)          |
| `triggers.items.<id>.{enabled,fire,lastFired,nextFireAt}`  | Schalter, Test-Knopf und Zeiten pro Trigger                           |
| `notify.text` / `notify.alert` / `notify.last`             | Systemmeldung sprechen / dringend / was gesprochen wurde              |
| `dnd` / `satellites.<id>.dnd`                              | Nicht stören, global oder pro Satellit (Alerts laufen trotzdem)       |
| `presence.anyoneHome` / `presence.count` / `presence.list` | wer zuhause ist, aus den konfigurierten States                        |
| `presence.lastArrival` / `presence.lastDeparture`          | wer zuletzt kam / ging                                                |
| `timers.*` / `timers.items.<id>.*`                         | Countdown-Timer, je ein Kanal (§11)                                   |
| `alarms.*` / `alarms.items.<id>.*`                         | Wecker zur festen Uhrzeit, je ein Kanal (§11)                         |
| `memory.*` / `memory.items.<id>.*`                         | was er sich merkt — editierbar (§11)                                  |
| `ringing` / `stopRinging`                                  | ob gerade etwas klingelt, und der Knopf, der es stoppt                |

---

### Skript-Schnittstelle (sendTo)

Alles, was der Assistent kann, ist aus einem Skript erreichbar. Die Antwort kommt immer im Callback.

| Befehl                                               | Message                                                                  | Antwort                                                                      |
|------------------------------------------------------|--------------------------------------------------------------------------|------------------------------------------------------------------------------|
| `ask`                                                | `{ text, source? }`                                                      | `{ answer }` / `{ error }` — die komplette Pipeline, wie per Sprache gefragt |
| `askUser`                                            | `{ question, room?/target?/source?, timeoutMs? }`                        | `{ answer }` / `{ timeout: true }` — fragen und warten (§9)                  |
| `notify`                                             | `{ text, severity?, target?/room?, onlyWhenHome? }`                      | `{ spoken }` — Systemmeldung sprechen (§9)                                   |
| `tts` / `ttsAvailable`                               | `{ text, language? }` / `{}`                                             | ein WAV als base64 / ob eine Engine konfiguriert ist                         |
| `playSound`                                          | `{ sound, room?/target? }`                                               | eine Datei aus `sounds/` abspielen                                           |
| `stopRinging`                                        | `{}`                                                                     | klingelnden Timer oder Wecker verstummen lassen                              |
| `setTimer` / `cancelTimer` / `listTimers`            | `{ duration, label?, room? }` / `{ id? }` / `{}`                         | §11                                                                          |
| `setAlarm` / `cancelAlarm` / `listAlarms`            | `{ time oder hour+minute, weekdays?, label?, room? }` / `{ id? }` / `{}` | §11                                                                          |
| `saveMemory` / `forgetMemory` / `listMemories`       | `{ text, key? }` / `{ id? oder text? }` / `{}`                           | §11                                                                          |
| `listTriggers` / `fireTrigger` / `setTriggerEnabled` | `{}` / `{ id }` / `{ id, enabled }`                                      | §10                                                                          |
| `getWeather`                                         | `{ when? }`                                                              | das Wetter aus deinem Wetter-Adapter (§4)                                    |
| `getWakeWords` / `setWakeWords`                      | `{}` / `{ device, wakeWords }`                                           | §6                                                                           |
| `getControls` / `setControl`                         | `{}` / `{ device, control, value }`                                      | §6                                                                           |
| `getDevices` / `setDeviceName` / `translateName`     | `{ language? }` / `{ stateId, name, language }` / …                      | die Geräteliste, die der Assistent sieht, und ihre Namen (§5)                |
| `clearCache`                                         | `{}`                                                                     | Geräte, Räume und Funktionen jetzt neu einlesen                              |
| `sendNotification`                                   | die Payload des Benachrichtigungsmanagers                                | `{ sent }` — nicht für den Handbetrieb gedacht                               |
| `voice` / `registerSatellite`                        | Audio / Registrierung                                                    | das Satelliten-Protokoll, siehe §7                                           |

`getModels`, `getVoices`, `getSttModels`, `getWeatherInstances`, `installLocalLlm` und
`testApiConnection` gibt es für den Einstellungsdialog und sind anderswo kaum nützlich.
