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
- **Geräte steuern** — *„Schalte das Wohnzimmerlicht aus"*, *„Stell die Rollos auf 50 %"*, *„Mach die
  Küche warmweiß"*.
- **Text oder Sprache** — in einen State schreiben / den eingebauten Test-Chat nutzen, oder mit einem
  Satelliten reden.
- **Wo möglich günstig und privat** — eine gestufte Pipeline versucht zuerst eine schnelle **Offline-
  Regel-Engine**, dann optional ein **kleines lokales LLM**, und eskaliert nur bei Bedarf ans **Cloud-LLM**.
- **Feingranulare Rechte** — du legst fest, was der Assistent lesen/schreiben darf, bis auf **Geräte-Ebene**.

---

## 2. Wie es funktioniert (Konzept)

### Die gestufte Antwort-Pipeline

Jede Anfrage läuft durch bis zu drei Stufen und stoppt bei der ersten, die antworten kann:

1. **Regelbasiertes NLU (offline, sofort)** — erkennt einfache Befehle (an/aus, Dimmen, Farbe, Status) auf
   **Deutsch, Englisch und Russisch**. Kein Modell, keine Cloud. Schalter: *Einfache Befehle lokal
   beantworten*.
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

### Zwei Arten von Satelliten / Transporten

|                   | **ioBroker-nativer Satellit** (empfohlen)             | **UDP-Satellit** (ESP / Hannah)                     |
|-------------------|-------------------------------------------------------|-----------------------------------------------------|
| Adapter           | `ioBroker.assistant-satellite` auf dem Gerät          | ESP-Firmware, oder derselbe Adapter im UDP-Modus    |
| Transport         | Audio über den ioBroker-**Nachrichtenbus** (`sendTo`) | Roher Audio-**UDP-Stream** (Hannah-Protokoll)       |
| Port am Assistant | **keiner**                                            | UDP-Port (*UDP-Sprach-Server betreiben* aktivieren) |
| STT/TTS           | zentral, im Assistenten                               | zentral, im Assistenten                             |
| Am besten für     | Raspberry Pi / PC-Satelliten                          | ESP32-Geräte, bestehende Hannah-Satelliten          |

- Für **ioBroker-native** Satelliten brauchst du am Assistant nichts außer *Sprache aktivieren*.
- Für **ESP/UDP**-Satelliten zusätzlich **UDP-Sprach-Server betreiben** aktivieren (öffnet den UDP-Port).
- **Wyoming**: optional den **Wyoming-TCP-Endpunkt** aktivieren, damit **Home Assistant Voice PE**,
  `wyoming-satellite` und **ESPHome**-Voice-Geräte an den Assistenten streamen können (Standard-Port 10700).

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

### Lautstärke, Stumm, Nicht stören (pro Satellit)

Ein ioBroker-nativer Satellit bietet diese beschreibbaren States (sie steuern den ALSA-Mixer des
Lautsprechers und gelten damit für Antworten, Durchsagen und den Beep gleichermaßen):

- **`assistant-satellite.<n>.volume`** — 0–100 %.
- **`assistant-satellite.<n>.mute`** — Lautsprecher stummschalten.
- **`assistant-satellite.<n>.dnd`** — Nicht stören: **Durchsagen werden unterdrückt** (Antworten auf
  deine eigenen Fragen laufen weiter).

**Priority-Durchsagen:** beginnt der Durchsage-Text mit **`!`**, wird das `!` entfernt und die Durchsage
läuft **auch bei „Nicht stören"** — z. B. `!Wasserleck im Keller`.

---

## 10. Fehlerbehebung

- **Kein Mikrofon-Ton / `arecord: capture slave is not defined` / `Device or resource busy`** — das Mic-
  Gerät ist falsch. Auf ein echtes Aufnahmegerät wie `plughw:2,0` (aus `arecord -l`) setzen, nicht
  `default`. Auf dem Gerät prüfen: `arecord -D plughw:2,0 -f S16_LE -c1 -r16000 -d3 /tmp/t.wav && aplay /tmp/t.wav`.
- **Wake-Word wird nicht erkannt** — deutlich sprechen, näher rangehen, Schwelle senken; den Score im Test-
  Panel beobachten. Eigene Modelle brauchen ggf. mehr Trainings-Samples.
- **„No API key configured"** — den LLM-Schlüssel im Settings-Reiter eintragen (oder Zugangsdaten wählen).
- **Satellit erreicht den Assistant nicht** — die Assistant-Instanz muss **laufen**; für ioBroker-nativen
  Transport ist sonst nichts nötig, für UDP Port/Host prüfen.
- **Voice-Tab-Optionen ausgeblendet** — zuerst **Sprache aktivieren (STT/TTS)**.

---

## 11. States-Übersicht

| State                                              | Bedeutung                                                            |
|----------------------------------------------------|----------------------------------------------------------------------|
| `info.connection`                                  | Assistent bereit                                                     |
| `text.request` / `text.response`                   | Frage stellen / Antwort lesen                                        |
| `text.querySource`                                 | Herkunft der letzten Anfrage (`''`, `chat` oder ein Satelliten-Name) |
| `tts.text`                                         | Durchsage an **alle** Satelliten (Text oder Audio-Pfad)              |
| `satellites.<id>.{status,room,alive,lastSeen,tts}` | Zustand pro Satellit + Durchsage                                     |
