# ioBroker.assistant

An LLM-based assistant for ioBroker. Ask questions in natural language and let the
assistant read or control **any ioBroker state** — it uses an LLM with **tool-calling**
over the native ioBroker API, so there is no rigid rule engine and no virtual-device tree.

> Status: **early proof-of-concept.** Text in → answer out. Audio (satellites, STT/TTS)
> and on-device wake word are planned next (see Roadmap).

## What works today

- Provider: **OpenAI** (and OpenAI-compatible endpoints via Base URL) or **Anthropic (Claude)**.
- The LLM can call these tools, all backed by the native adapter API:
  - `list_rooms`, `list_functions` — read `enum.rooms` / `enum.functions`
  - `find_states({ room?, func?, query? })` — find states + current values
  - `get_state({ id })` — read one value
  - `set_state({ id, value })` — control a device (can be disabled in settings)
- Text interface via two states:
  - write your question to `assistant.0.text.request`
  - read the answer from `assistant.0.text.response`
- Or from a script: `sendTo('assistant.0', 'ask', { text: 'Wie warm ist es im Wohnzimmer?' }, cb)`

## Configuration

In the adapter admin (Instances → assistant → ⚙):

| Setting                  | Meaning                                           |
|--------------------------|---------------------------------------------------|
| Provider                 | `openai` or `anthropic`                           |
| Model                    | e.g. `gpt-4o-mini`, `gpt-4o`, `claude-sonnet-4-6` |
| API key                  | your provider API key                             |
| Base URL                 | optional endpoint override (e.g. Groq)            |
| Allow controlling states | if off, the assistant is read-only                |
| System prompt            | persona / behaviour                               |

## Try it

1. `npm install` in this folder.
2. `npm run build` — compiles `src/*.ts` → `build/*.js` (or `npm run watch` while developing).
3. Install into ioBroker (e.g. `iobroker url .` from the folder, or `@iobroker/dev-server`).
4. Enter provider + API key in the admin, save.
5. Set `assistant.0.text.request` to `Welche Lichter sind an?` and watch `text.response`.

> Written in **TypeScript** (`src/`), compiled to `build/`. The adapter entry point is `build/main.js`.

## Roadmap

1. **Text assistant (done)** — LLM + tool-calling over ioBroker states.
2. **Fast-path** for common commands (on/off/timer) without an LLM round-trip.
3. **TTS / STT engines** (Polly / Azure / OpenAI / AWS Transcribe) as adapter modules + config.
4. **Satellite endpoint** — UDP audio + MQTT control, so ESP/Pi satellites talk to the adapter directly.
5. **Wake word** — trained/managed via ioBroker, running on the device.

## License

MIT © GermanBluefox
