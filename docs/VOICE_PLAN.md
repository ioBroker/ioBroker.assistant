# Voice / Satellite — Architektur & Implementierungsplan

> Ergänzung zu `CLAUDE.md` (Roadmap-Punkte 7/8). Ziel: Sprachbetrieb wie der Hannah-Satellit
> (`C:\iot\Hannah\satellite-pi`), aber Server-Seite im Adapter + eigener **Node-Satellit als npm-Paket**.
> Cloud **und** lokal müssen beide gehen. ESP-Satelliten müssen kompatibel bleiben.

## Leitentscheidungen (Architektur)

1. **Satelliten-Protokoll = Hannah-UDP, unverändert.** Ein UDP-Socket, Typ-Byte voran:
   `0x01` Control (JSON) · `0x02` Audio (16 kHz mono PCM, Sat→Server) · `0x03` TTS (mono PCM, Server→Sat).
   Grund: bestehende **ESP-Satelliten** bleiben nutzbar. Wyoming (TCP) wäre ein Bruch → nein als Satelliten-Protokoll.

2. **Wyoming nur als Engine-Anbindung**, nicht als Satelliten-Protokoll. Optionaler Lokal-Backend-Weg
   (`wyoming-piper`, `wyoming-faster-whisper`) hinter dem STT/TTS-Interface.

3. **Rollen-Split:**
   - **Satellit** (ESP oder Node) = *nur* Audio: Wake-Word lokal, Mikrofon streamen, TTS abspielen. Kein STT/TTS.
   - **Adapter** (`ioBroker.assistant`) = Gehirn: UDP-Server, **STT → `LlmAgent.ask()` → TTS**, Satelliten-Registry.
   → Der „schwacher Pi = Cloud / Purist = lokal"-Trade-off ist damit eine **Adapter**-Config, nicht Satelliten-Config.

4. **STT/TTS = austauschbares Interface** mit Cloud- und Lokal-Implementierungen (siehe Engine-Matrix).

5. **Wake-Word:** OpenWakeWord (ONNX, lizenzsauber, HASS-konform) als Default im Node-Satelliten;
   Porcupine optional (eigener AccessKey). ESP macht microWakeWord on-device — unverändert.

## Protokoll (Single Source of Truth)

Genau eine Definition, von beiden Seiten genutzt, um Drift zu vermeiden.
Umsetzung: `src/lib/voice/protocol.ts` im Adapter ist die Referenz; der Satellit bekommt eine **identische Kopie**
(kleines File, ~40 Zeilen) — bewusst dupliziert statt drittes Shared-Package (Overhead vermeiden).
Bei Änderung: beide Files anpassen (in beiden ein Kommentar-Hinweis „keep in sync").

Control-Nachrichten (aus `satellite.py` abgeleitet):

| Richtung | `type` | Felder |
|---|---|---|
| Sat→Server | `register` | `device, room, listen_port` |
| Sat→Server | `heartbeat` | `device` |
| Sat→Server | `audio_end` | `device` |
| Server→Sat | `registered` | `ok` |
| Server→Sat | `heartbeat_ack` | — |
| Server→Sat | `reregister` | — |
| Server→Sat | `tts_end` | `sample_rate` |
| Server→Sat | `status` | `state` (idle/listening/processing/speaking) |

Audio-Format über den Draht: **16 kHz, mono, 16-bit signed LE, raw PCM** (kein Header) in `0x02`-Paketen.
TTS zurück: raw mono PCM in `0x03`-Paketen, Rate im `tts_end.sample_rate`.

## Engine-Matrix (STT/TTS im Adapter)

```ts
interface SttEngine { transcribe(pcm: Buffer, sampleRate: number, lang: string): Promise<string>; }
interface TtsEngine { synthesize(text: string, lang: string): Promise<{ pcm: Buffer; sampleRate: number }>; }
```

| Rolle | Cloud (fertig: openai/azure/aws) | Lokal (Pi-tauglich) | Lokal (Qualität) |
|---|---|---|---|
| **STT** | OpenAI Whisper · **Azure** Speech (`recognizeOnce`) · **AWS** Transcribe (streaming) | **Vosk** (`vosk` npm, prebuilt + Auto-Model, echtzeitnah auf Pi) | whisper.cpp (`smart-whisper`) oder Wyoming→faster-whisper |
| **TTS** | OpenAI TTS (pcm 24k) · **Azure** (Raw24k pcm) · **AWS Polly** (pcm 16k) | **Piper** (Binary + Stimme auto-download) | Piper hochwertige Stimme / Wyoming→Piper |

**Provider-Auswahl** (STT und TTS **unabhängig** wählbar) über `sttProvider`/`ttsProvider` +
Factory `createSttEngine`/`createTtsEngine` (`src/lib/voice/engines.ts`). Sprach-Mapping ISO→Locale in `lang.ts`
(OpenAI nutzt ISO, Azure/AWS die Locale).

**Credentials** (`resolveVoiceCredentials` in `credentials.ts`) — `voiceCredentialType` = `manual`|`manager`:
- `manual`: verschlüsselte Config-Felder (`voiceApiKey`, `azureSpeechKey`+Region, `awsAccessKeyId`+Secret+Region).
- `manager`: zentraler Store via Credential-Picker — `voiceCredentialId` (Typ `ai`, `{key}`),
  `azureCredentialId` (Typ `azure`, `{key, region}`), `awsCredentialId` (Typ `aws`, `{accessKeyId, secretAccessKey, region}`).
  → Store-Typen `aws`/`azure` sind in der Admin-Credential-Komponente definiert.

**Voice-Auswahl dynamisch**: `getVoices`-sendTo (`main.ts`) → `listVoices` (Azure `getVoicesAsync`,
Polly `DescribeVoices`, OpenAI fixe 6) → jsonConfig `autocompleteSendTo` (freeSolo) für `ttsVoice`/`azureVoice`/`awsVoice`.

**Auto-Install lokal:**
- **Piper (TTS):** Binary passend zu Platform/Arch von `rhasspy/piper`-Releases laden + Stimme (`.onnx` + `.json`)
  beim ersten Lokal-Start herunterladen. Keine Systemdeps. Idiomatisch für ioBroker.
  **Stimme ist sprachabhängig konfigurierbar** (nicht auf Deutsch verdrahtet): Default `de_DE-thorsten-medium`,
  Russisch verfügbar (`ru_RU-irina/denis/dmitri/ruslan`), plus viele weitere Sprachen. Auswahl folgt `sttLanguage`.
- **Vosk (STT):** npm mit prebuilt Binaries, Modell (`vosk-model-small-de-*`) auto-download.
- **Whisper / Wyoming:** optional, für stärkere Server; Wyoming = Nutzer betreibt Container, Adapter verbindet nur.

Batch-Verarbeitung zuerst (wie Hannah: bis `audio_end` sammeln → STT). Streaming-STT später.

## Node-Satellit — Teil X (zwei Repos: Core-Lib + Adapter-Wrapper)

Ziel: derselbe Satelliten-Code läuft **standalone auf nacktem Pi** (`npx`, ohne js-controller) *und* als
**ioBroker-Adapter** (GUI-Config, States). Erreicht durch Core-Library + zwei dünne Wrapper.

- **Repo 2 — Core-Lib `@iobroker/assistant-satellite`** (`C:\pWork\ioBroker.assistant-satellite-core` o.ä.):
  - Enthält die **gesamte Logik**: UDP-Protokoll, MQTT-Discovery, Audio-I/O, VAD, Wake-Word (onnxruntime-node).
  - **Kein** `@iobroker/adapter-core`, kein js-controller. **Dependency Injection**: `Satellite`-Klasse bekommt
    `SatelliteConfig` + `SatelliteHost` (`{ log, onStatus? }`) rein — kennt ioBroker nicht.
  - `"bin"`-Eintrag → `npx @iobroker/assistant-satellite` liest `config.json`, `new Satellite(cfg, {log: console}).start()`.
  - `protocol.ts` = in-sync-Kopie aus dem Adapter-Repo `ioBroker.assistant`.
- **Repo 1 — Adapter `iobroker.assistant-satellite`** (`C:\pWork\ioBroker.assistant-satellite`):
  - Dünner ioBroker-Wrapper. `dependencies: { "@iobroker/assistant-satellite": "^x" }` (Richtung: Repo 1 → Repo 2).
  - `main.ts` liest Admin-Config → baut `SatelliteConfig` → `new Satellite(cfg, { log: this.log,
    onStatus: s => this.setState('status', s, true) }).start()`. Lifecycle in `onReady`/`onUnload`.
- **npm-Namen kollidieren nicht:** Lib scoped `@iobroker/assistant-satellite`, Adapter lowercase unscoped
  `iobroker.assistant-satellite`.
- **Dev:** `npm link` (Repo 2 verlinken in Repo 1) statt bei jeder Änderung publishen.
- **Erststart standalone ohne config:** Default-`config.json` erzeugen + Pfad ausgeben (Discovery via MQTT *oder* fixe Host-IP).
- **Bausteine (Node-Äquivalente zu `satellite.py`):**
  - MQTT-Discovery/Status/LWT → `mqtt`
  - UDP-Protokoll → `dgram` (built-in), Typ-Bytes 1:1
  - Mikrofon/Playback → `arecord`/`aplay` spawnen (robust, kein Native-Build) — Fallback `naudiodon2`
  - Aufnahme direkt @16 kHz mono → kein Resampling nötig
  - VAD = RMS-Stille-Erkennung (direkt aus `satellite.py` portierbar)
  - Wake-Word → OpenWakeWord via `onnxruntime-node` (Modell auto-download); Porcupine optional
  - Heartbeat + Backoff-Restart, optional LED (GPIO) — später
- **config.json** spiegelt Hannahs `Config`-Dataclass (device, room, host/discovery, wakeword, audio-devices,
  silence/threshold, listen_port …).

## Adapter-seitige States & Config

- **Objekte:** `assistant.0.satellites.<device>.{status, room, alive, lastSeen}` (Registry sichtbar in Admin/vis).
- **Config-Felder (jsonConfig):** `voiceEnabled`, `voicePort` (7775), `sttProvider` (cloud|vosk|whisper|wyoming),
  `ttsProvider` (cloud|piper|wyoming), `ttsVoice`, `sttLanguage`, `wyomingSttHost/Port`, `wyomingTtsHost/Port`,
  Default-Wake-Word-Einstellungen für Satelliten.
- Admin-Tab „Satelliten": Liste + Live-Status (reuse ChatComponent-Muster: `subscribeState`).

## Dateien (Adapter)

| Datei | Zweck |
|---|---|
| `src/lib/voice/protocol.ts` | Typ-Bytes + Control-Message-Typen (Referenz-Definition) |
| `src/lib/voice/voiceServer.ts` | `dgram`-Server: Registry, Heartbeat-ACK, Audio-Assembly, `status`-Broadcast |
| `src/lib/voice/stt.ts` | `SttEngine` + Cloud/Vosk/Whisper/Wyoming-Impls |
| `src/lib/voice/tts.ts` | `TtsEngine` + Cloud/Piper/Wyoming-Impls + Binary/Model-Downloader |
| `src/main.ts` | voiceServer in `onReady` starten, in `onUnload` schließen; wired an `LlmAgent` |

## Phasen (Reihenfolge)

- **V1b — Cloud-Provider Azure + AWS ✅ FERTIG.** `azure.ts` (Azure Speech STT/TTS), `aws.ts` (Polly + Transcribe
  Streaming), `engines.ts` (Factory), `lang.ts` (ISO→Locale). Deps: `microsoft-cognitiveservices-speech-sdk`,
  `@aws-sdk/client-polly`, `@aws-sdk/client-transcribe-streaming` (normale deps). Config: `sttProvider`/`ttsProvider`
  + Azure-Key/Region/Voice, AWS-Key/Secret/Region/Voice (encrypted). Factory-Smoke-Test grün; echte Cloud-Calls
  noch ungetestet.
- **V1 — Server-Seite, Cloud-only (testbar mit vorhandenem Python-Sat). ✅ FERTIG.**
  `src/lib/voice/{protocol,stt,tts,voiceServer}.ts` (UDP, Registry, Heartbeat, Audio-Assembly) → OpenAI-STT
  (`whisper-1`, PCM→WAV) → `LlmAgent.ask()` (via `main.ts.answer`) → OpenAI-TTS (`tts-1`, `response_format:'pcm'`
  24 kHz) → `0x03`-Chunks (8 KB) + `tts_end`. `status`-Broadcast → `assistant.0.satellites.<id>.{status,room,alive,
  lastSeen}`. Config-Tab „Voice" (`voiceEnabled/voicePort/voiceLanguage/ttsVoice/voiceApiKey`); Voice-Key =
  `voiceApiKey` oder Haupt-Key bei Provider openai. Stale-Sweep (30 s). Protokoll-Smoke-Test (UDP-Loopback) grün.
  **Offen für echten Test:** realer OpenAI-Key + echter Python-Sat (Cloud-Calls + Interop noch ungetestet).
- **V2 — Lokale Engines ✅ (Scaffold, Runtime-Test auf Pi offen).** `vosk.ts` (STT: On-Demand-`npm i vosk` ins
  Instanz-Datenverzeichnis wie localLlm + Modell-Zip-Download/Extract je Sprache), `piper.ts` (TTS: Binary +
  Stimme `.onnx`/`.json` auto-download, spawn `piper --output_raw`, sampleRate aus Voice-JSON), `download.ts`
  (`downloadFile`/`extractArchive` via tar/unzip). Factory `engines.ts` → `EngineContext` (creds + dataDir + log +
  voskModel); `sttProvider += vosk`, `ttsProvider += piper`. Config-Felder `voskModel`/`piperVoice`, jsonConfig
  „Local speech"-Block + Provider-Optionen. Lazy-Init im Engine (erster Aufruf lädt). Build/Factory-Smoke grün;
  **echte Downloads + Spawn auf dem Pi noch ungetestet** (braucht `unzip`/`tar`, Internet).
- **V3 — Node-Satellit (Scaffold ✅, Repo `C:\iot\assistant-satellite`).** Core-Lib `@iobroker/assistant-satellite`
  (standalone, kein js-controller): `protocol.ts` (in-sync-Kopie), `config.ts`, `audio.ts` (arecord/aplay-spawn,
  16 kHz-Capture via `plughw`), `vad.ts` (RMS), `mqtt.ts` (optionale Discovery), `models.ts` (OpenWakeWord-ONNX
  auto-download), `wakeword.ts` (melspec→embedding→classifier via onnxruntime-node), `satellite.ts` (Orchestrierung,
  DI `SatelliteHost{log,onStatus}`), `cli.ts` (`bin`, `config.json`). Build grün, CLI-Smoke grün. **Offen:** echter
  Lauf auf dem Pi + OpenWakeWord-Frame-Mathematik/Threshold validieren (der riskante Teil). Adapter-Wrapper
  `iobroker.assistant-satellite` bewusst später/optional.
- **V4 — Politur.** Admin-Satelliten-Tab, LED/GPIO, Streaming-STT, Barge-in (Wake-Word während TTS),
  Porcupine-Option, mehrere Räume/Zonen.

## Entschieden

- **Lokal-STT auf Pi = Vosk** (schnell, ungenauer) als Default; Whisper/Wyoming nur als Qualitäts-Option.
- **Satellit = zwei Repos:** Core-Lib `@iobroker/assistant-satellite` (standalone, js-controller-frei, `npx`) +
  ioBroker-Adapter `iobroker.assistant-satellite` (dünner Wrapper, nutzt die Lib). DI über `SatelliteHost`.
- **Wyoming = erst V4** (nicht V2).
- **Piper-Default-Stimme `de_DE-thorsten-medium`**, aber Stimme **pro Sprache konfigurierbar** (Russisch `ru_RU-*` u.v.m.).
- **Eine globale Sprach-Einstellung `assistant.language`** steuert STT-Sprache *und* TTS-Stimme gemeinsam.
  Default aus `system.config.language`. Voice-Auswahl leitet sich daraus ab (Lang → Vosk-Model + Piper-Stimme);
  überschreibbare Feinwahl bleibt möglich, ist aber nicht der primäre Config-Weg.
