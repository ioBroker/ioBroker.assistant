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
- LLM-Agent mit Tool-Calling-Schleife für **OpenAI + Anthropic** — `src/lib/llm.ts` (`LlmAgent`).
- Tools über native ioBroker-API — `src/lib/tools.ts`: `list_rooms`, `list_functions`,
  `find_states({room?,func?,query?})`, `get_state({id})`, `set_state({id,value})`.
- Typisierte Config — `src/types.d.ts` (`AdapterConfig`).
- Adapter — `src/main.ts`: schreibt in `assistant.0.text.response`, wenn man `assistant.0.text.request`
  setzt; zusätzlich `sendTo('assistant.0','ask',{text:'…'},cb)`.
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
npm run build      # tsc -> build/  (Entry: build/main.js)
npm run watch      # tsc --watch
npm run lint       # eslint (eslint.config.mjs, @iobroker/eslint-config)
```
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
7. **Hybrid lokal→Cloud** — Tier-Pipeline in `main.ts.answer(question)`:
   - **Tier 0 — Regel-NLU** ✅ fertig, **mehrsprachig (de/en/ru)**. `src/lib/nlu.ts` (`Nlu`, Port von Hannahs
     `nlu.py`: Raum+Gerät+Aktion, längster Match gewinnt). Kyrillisch-fähig: `wordInText()` matcht per
     Unicode-Wortgrenze (`\p{L}`) mit **Stemming** (Suffix-tolerant → russische Flexion „подсветку"↔„подсветка").
     Wortlisten de/en/ru. Namen werden in `voiceLanguage||language` aufgelöst (`getNluDevices`), Antworten
     (`executeIntent`/`describeValue`) ebenfalls de/en/ru. Deckt an/aus, Level (%), Farbe (hex), Status-Query.
     `main.ts`: `getNluDevices()` baut `NluDevice[]` (controls = controlType→stateId) aus gecachtem
     `list_devices`; `tryLocalNlu()`→`executeIntent()` ruft direkt `set_state`/`get_states`, respektiert
     `allowWriteStates` + `deviceAcl`. Config-Schalter `useLocalNlu` (default true). Kein Modell, 0 Install.
     Fällt bei Nicht-Treffer auf das LLM zurück. NLU pur/getestet (Scratch-Test grün).
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
8. **Voice / Satelliten** — Architektur + Phasen in `docs/VOICE_PLAN.md`. Satelliten-Protokoll = Hannah-UDP
   (ESP-kompatibel), STT/TTS als austauschbares Interface (Cloud + lokal), globale `voiceLanguage`.
   - **V1 — Server-Seite Cloud ✅ fertig.** `src/lib/voice/{protocol,stt,tts,voiceServer}.ts`: `dgram`-UDP-Server
     (Typ-Bytes `0x01/0x02/0x03`, `register`/`heartbeat`/`audio_end` ↔ `registered`/`heartbeat_ack`/`status`/
     `tts_end`) sammelt 16 kHz-mono-PCM bis `audio_end` → OpenAI-STT (`whisper-1`) → `main.ts.answer()` (Tier-Pipeline)
     → OpenAI-TTS (`tts-1`, `pcm` 24 kHz) → `0x03`-Chunks + `tts_end`. States `assistant.0.satellites.<id>.{status,
     room,alive,lastSeen}`. Config-Tab „Voice" (`voiceEnabled/voicePort/voiceLanguage/ttsVoice/voiceApiKey`;
     Key = `voiceApiKey` sonst Haupt-Key bei Provider openai). In `onReady` gestartet, `onUnload` gestoppt.
     Protokoll-Smoke-Test grün; **echter OpenAI-Call + Python-Sat-Interop noch ungetestet.**
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
   - **V2** lokale Engines (Vosk-STT, Piper-TTS auto-download), **V3** Node-Satellit (2 Repos: Core-Lib
     `@iobroker/assistant-satellite` + Adapter `iobroker.assistant-satellite`), **V4** Wyoming/Politur. Siehe Plan.

**GUI-Build:** `cd src-admin && npm i && npm run build` (oder `npm run build:gui` vom Repo-Root) →
`admin/custom/customComponents.js` + `admin/custom/i18n/*.json` (via `copyI18n`-Plugin aus `src/i18n/`).
`src-admin/node_modules` ist gitignored; `admin/custom/` wird committet (ausgeliefert).

**⚠️ Module-Federation-Versionen exakt pinnen:** `@module-federation/vite` (`1.14.5`) und
`@module-federation/runtime` (`2.3.3`) in `src-admin/package.json` **ohne `^`** — neuere Versionen (1.16+/2.6+)
bauen das React-Sharing kaputt (`TypeError: Cannot read properties of null (reading 'useContext')`, die
Component lädt eine leere React-Instanz). React/MUI/adapter-react-v5 bleiben auf React 18 (Admin ist React 18).

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

## Offene Entscheidungen

- Provider-Umfang: aktuell openai + anthropic. Erweitern auf gemini/deepseek/custom wie `javascript`?
- Single-Provider-Auswahl (jetzt) vs. mehrere Provider gleichzeitig konfigurierbar (wie `javascript`)?
- Offline-Betrieb nötig? (sonst rein Cloud → einfacher).
- Icon: SVG vorhanden; für offizielle ioBroker-Repo evtl. zusätzlich PNG 128×128.
- Audio (Phase 4/5): Streaming-STT in Node (`dgram` + AWS/Azure/OpenAI-SDK) ist der fummeligste Teil.

## Arbeitsweise-Notizen

- Nach jedem sinnvollen Schritt: `npm run build` grün halten.
- Diese Datei aktualisieren, wenn sich Stand/Plan ändert (Status-Abschnitt + Roadmap-Häkchen).
- Secrets (API-Keys) niemals committen.
