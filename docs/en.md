# ioBroker.assistant — User Guide

A voice and text **assistant for ioBroker**. It answers free questions **and** questions about your
**ioBroker states, devices and weather**, and it can **control devices** — driven by a Large Language
Model (LLM) with tool-calling over the native ioBroker API. No rule trees, no virtual-device tree to
maintain.

Optionally it works with **satellites** (microphone + speaker boxes in each room) for hands-free voice.

---

## 1. What can it do?

- **Answer questions** — general knowledge and about your home: *"Is a window still open?"*, *"How warm
  is it in the living room?"*, *"How much did the heating pump consume today?"*
- **Control devices** — *"Turn off the living-room light"*, *"Set the blinds to 50 %"*, *"Make the
  kitchen warm white"*.
- **Text or voice** — write to a state / use the built-in test chat, or talk to a satellite.
- **Runs cheap and private where possible** — a tiered pipeline tries a fast **offline rule engine**,
  then optionally a **small local LLM**, and only escalates to the **cloud LLM** when needed.
- **Fine-grained permissions** — decide what the assistant may read/write, down to **per-device** access.

---

## 2. How it works (concept)

### The tiered answer pipeline

Every request runs through up to three tiers, stopping at the first that can answer:

1. **Rule-based NLU (offline, instant)** — recognises simple commands (on/off, dimming, colour, status)
   in **German, English and Russian**. No model, no cloud. Toggle: *Answer simple commands locally*.
2. **Local LLM (optional)** — a small model (via `node-llama-cpp`) installed on demand, for general
   questions. It escalates to the cloud when it needs live device data. Toggle: *Use a local LLM*.
3. **Cloud LLM (tool-calling)** — the full assistant. It gets a compact list of your devices in its prompt
   and calls tools (read states, set states, history, logs …) over the native ioBroker API.

### Providers

One active LLM provider: **OpenAI, Anthropic (Claude), Google Gemini, DeepSeek**, or any
**OpenAI-compatible** endpoint (e.g. Groq, a local server) via a custom base URL.

### Satellites (voice)

A **satellite** is a microphone + speaker in a room. The **wake word** ("Hey Jarvis" …) is detected
**on the satellite**; it then records your sentence, the assistant turns it into text (STT), answers, and
speaks the reply back (TTS). Speech recognition and synthesis run **centrally in the assistant** — the
satellites stay simple. See §7.

---

## 3. What you need

**Minimum (text assistant):**

- An **ioBroker** installation with a recent Admin and js-controller (≥ 7.2 recommended, needed for the
  central credential store).
- **One** of:
  - an **API key** for an LLM provider (OpenAI, Anthropic, Gemini, DeepSeek, or a custom endpoint), **or**
  - enough CPU/RAM to run the **local LLM** (small models recommended on Raspberry Pi / arm64).

**Additionally for voice / satellites:**

- A **speech provider**: OpenAI, Azure or AWS (cloud), **or** local **Vosk** (STT) + **Piper** (TTS),
  which install on demand — no cloud.
- One or more **satellite devices** with a microphone and speaker (e.g. a Raspberry Pi with a USB
  speakerphone). **ffmpeg** is required on the satellite host (Windows and Linux).
- **Node.js ≥ 22** on the satellite device.

---

## 4. Installation & basic setup (text)

1. Install the **ioBroker.assistant** adapter from the ioBroker admin and create an instance.
2. Open the instance settings → **Settings** tab:
   - **Provider** — pick your LLM provider.
   - **Credential mode** — *Store key in adapter* (simplest) or *Central credential store* (js-controller
     ≥ 7.2; the adapter only stores the credential id, the key stays in the store).
   - **API key** (or select the credential).
   - Click **Test connection**. On success, pick a **Model** (the dropdown loads the provider's models;
     you can also type a model id).
3. *(Optional)* enable **Answer simple commands locally** (offline rule engine) and/or **Use a local LLM**
   (click **Install local model** — downloads engine + model; watch the progress).
4. Set **Access / permissions** (see §6) and save.

### Using it as text

- Write your question into the state **`assistant.0.text.request`** → the answer appears in
  **`assistant.0.text.response`**. The origin is recorded in `text.querySource`.
- Or from a script: `sendTo('assistant.0', 'ask', { text: 'Is a window open?' }, cb)`.
- Or use the **Test chat** tab in the adapter settings (works while the instance is running).

---

## 5. Permissions & per-device access

Under **Access / permissions** you control what the assistant may do:

- **Object read access** — only devices/rooms/functions, or any object.
- **Allow writing states** (control devices), **allow object/file changes** (dangerous), reading **logs**,
  **history**, **files**, **system info**, writing **logs**.
- **Per-device ACL** (Devices tab) — a list of all detected devices (type + room). For each device you can
  allow/deny **read** and **write** individually. Locks default to write-denied; sensors/cameras are
  read-only. Buttons are hidden everywhere. You can also **rename** a device (multi-language) and
  auto-**translate** the name.

The permissions apply to **all** tiers (rule engine, local LLM, cloud LLM).

---

## 6. Voice — the satellite concept

Voice is optional and off by default. Turn on **Enable voice (STT/TTS)** on the **Voice** tab. This makes
speech recognition/synthesis available; **it does not open any network port**. Then choose:

- **Voice language** — used for STT and the spoken reply.
- **Speech-to-text provider** — OpenAI, Azure, AWS, or **Vosk** (local, offline).
- **Text-to-speech provider** — OpenAI, Azure, AWS, or **Piper** (local, offline).
- Provider keys (separate from the LLM key; a *Speech credential mode* mirrors manual/manager). Voices and
  local models load into dropdowns.

### Two kinds of satellites / transports

|                       | **ioBroker-native satellite** (recommended)        | **UDP satellite** (ESP / Hannah)              |
|-----------------------|----------------------------------------------------|-----------------------------------------------|
| Adapter               | `ioBroker.assistant-satellite` on the device       | ESP firmware, or the same adapter in UDP mode |
| Transport             | Audio over the ioBroker **message bus** (`sendTo`) | Raw audio **UDP stream** (Hannah protocol)    |
| Port on the assistant | **none**                                           | UDP port (enable *Run the UDP voice server*)  |
| STT/TTS               | central, in the assistant                          | central, in the assistant                     |
| Best for              | Raspberry Pi / PC satellites                       | ESP32 devices, existing Hannah satellites     |

- For **ioBroker-native** satellites you need nothing extra on the assistant beyond *Enable voice*.
- For **ESP/UDP** satellites, additionally enable **Run the UDP voice server** (opens the UDP port).
- **Wyoming**: optionally enable the **Wyoming TCP endpoint** so **Home Assistant Voice PE**,
  `wyoming-satellite` and **ESPHome** voice devices can stream to the assistant (default port 10700).

### What runs where

- **On the satellite:** microphone capture, **wake-word detection** (OpenWakeWord), recording, playback.
- **In the assistant:** STT → answer (the tiered pipeline) → TTS. So keys and configuration stay in **one
  place**.

---

## 7. Setting up a satellite

On each room device (e.g. a Raspberry Pi):

1. Install the **ioBroker.assistant-satellite** adapter and create an instance (Node.js ≥ 22, **ffmpeg**
   installed).
2. In its settings:
   - **Assistant instance** — pick your `assistant.0`.
   - **Transport** — leave on **ioBroker** (recommended; no port). Use **UDP** only for ESP compatibility.
   - **Audio backend** — *Auto* (ALSA on Linux, ffmpeg elsewhere).
   - **Microphone / Speaker device** — pick from the dropdown. On a Pi use an ALSA hardware device such as
     **`plughw:2,0`** (run `arecord -l` / `aplay -l` to find the card number). Avoid `default` — it often
     has no capture slave.
   - **Room** — the room name.
   - **Wake word** — see §8.
   - **Follow-up conversation** *(optional)* — keeps the mic open briefly after a reply so you can
     continue (*"…and the kitchen too"*) without repeating the wake word; returns to wake-word mode after
     silence. Uses the conversation context (§2), so follow-ups resolve naturally.
3. Save. The satellite loads the wake-word model on first run and then listens.

> **Standalone (without ioBroker):** the core library `@iobroker/assistant-satellite` also runs on its own
> (e.g. on an ESP-adjacent box) via UDP — no js-controller required. That path uses the UDP transport.

---

## 8. Wake word

- **Built-in words:** `hey_jarvis`, `alexa`, `hey_mycroft`, `hey_rhasspy` — just pick one.
- **Multiple words:** you can configure up to **three** wake words; the satellite triggers on any of them.
- **Threshold:** lower = more sensitive (more false triggers). Tune per device.
- **Test button:** the settings show a live **Test wake word** panel — click it, say the word, and watch
  the **microphone level** and the **wake-word score** rise in real time; a banner lights up on detection.
  Great for finding the right device and threshold. (Needs the instance running; it briefly pauses the
  satellite during the test.)

### Custom wake word (e.g. "ioBroker")

The `wakewordModel` field also accepts a **URL** or a **local `.onnx` path**. To use a custom phrase you
train an OpenWakeWord model for it (it synthesises speech samples and trains a small classifier) and point
the field at the resulting `.onnx`. A reproducible AWS/Terraform training setup is documented separately
(the `wakeword-training` project). Custom words are a bit less robust than the built-in ones — tune the
threshold.

---

## 9. Announcements (text-to-speech to satellites)

Make a satellite speak without a question:

- **All satellites:** write text (or an mp3/wav path/URL) to **`assistant.0.tts.text`**.
- **One satellite:** write to **`assistant.0.satellites.<id>.tts`**.

Text is synthesised with the configured TTS engine; an audio file is decoded and played as-is.

### Volume, mute, Do-Not-Disturb (per satellite)

An ioBroker-native satellite exposes these writable states (they drive the speaker's ALSA mixer, so they
apply to answers, announcements and the beep alike):

- **`assistant-satellite.<n>.volume`** — 0–100 %.
- **`assistant-satellite.<n>.mute`** — silence the speaker.
- **`assistant-satellite.<n>.dnd`** — Do-Not-Disturb: **announcements are suppressed** (replies to your
  own questions still play).

**Priority announcements:** if the announcement text starts with **`!`**, the `!` is stripped and the
announcement plays **even when Do-Not-Disturb is on** — e.g. `!Water leak in the basement`.

---

## 10. Troubleshooting

- **No microphone audio / `arecord: capture slave is not defined` / `Device or resource busy`** — the mic
  device is wrong. Set it to a real capture device like `plughw:2,0` (from `arecord -l`), not `default`.
  Verify on the device: `arecord -D plughw:2,0 -f S16_LE -c1 -r16000 -d3 /tmp/t.wav && aplay /tmp/t.wav`.
- **Wake word not detected** — say it clearly, move closer, lower the threshold; watch the Test panel's
  score. Custom models may need retraining with more samples.
- **"No API key configured"** — enter the LLM key (or select the credential) on the Settings tab.
- **Satellite can't reach the assistant** — make sure the assistant instance is **running**; for
  ioBroker-native transport nothing else is needed, for UDP check the port/host.
- **Voice tab options hidden** — enable **Enable voice (STT/TTS)** first.

---

## 11. States overview

| State                                              | Meaning                                                        |
|----------------------------------------------------|----------------------------------------------------------------|
| `info.connection`                                  | assistant ready                                                |
| `text.request` / `text.response`                   | ask a question / read the answer                               |
| `text.querySource`                                 | origin of the last request (`''`, `chat`, or a satellite name) |
| `tts.text`                                         | announce to **all** satellites (text or audio path)            |
| `satellites.<id>.{status,room,alive,lastSeen,tts}` | per-satellite state + announce                                 |
