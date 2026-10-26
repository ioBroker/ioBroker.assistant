/**
 * Voice-satellite UDP wire protocol — compatible with the Hannah satellite
 * (`C:\iot\Hannah\satellite-pi\satellite.py`) so existing ESP/Python satellites keep working.
 *
 * One UDP socket, first byte is the packet type:
 *   0x01 CONTROL — UTF-8 JSON message (both directions)
 *   0x02 AUDIO   — raw 16 kHz mono 16-bit signed LE PCM (satellite → server)
 *   0x03 TTS     — raw mono 16-bit signed LE PCM (server → satellite)
 *
 * ⚠️ KEEP IN SYNC with the copy in the standalone `@iobroker/assistant-satellite` repo.
 */

export const TYPE_CONTROL = 0x01;
export const TYPE_AUDIO = 0x02;
export const TYPE_TTS = 0x03;

/** Audio on the wire from the satellite is always 16 kHz, mono, 16-bit signed little-endian PCM. */
export const AUDIO_SAMPLE_RATE = 16000;

/** Control messages sent by a satellite to the server. */
export type SatToServer =
    | { type: 'register'; device: string; room?: string; listen_port?: number }
    | { type: 'heartbeat'; device: string }
    | { type: 'audio_end'; device: string }
    /** The satellite's playback volume (0–100) after a `volume` command, or whenever it changed locally. */
    | { type: 'volume'; device: string; level: number };

/** Satellite lifecycle/status as reflected to the satellite (drives its LED) and to ioBroker states. */
export type SatelliteState = 'idle' | 'listening' | 'processing' | 'speaking';

/**
 * Control messages sent by the server to a satellite.
 *
 * `listen` re-opens the microphone without a wake word, for the answer to a question the assistant just
 * asked (see `PendingQuestions`). The same request rides on `tts_end.listen` when the reply itself is the
 * question, so it cannot overtake the audio. `volume` sets the playback volume, absolute (`level`, 0–100)
 * or relative (`delta`, ±percentage points); the satellite answers with its resulting level.
 *
 * All of these are additive: a satellite built before they existed ignores the unknown type or field and
 * simply waits for its wake word, or keeps its volume.
 */
export type ServerToSat =
    | { type: 'registered'; ok: boolean }
    | { type: 'heartbeat_ack' }
    | { type: 'reregister' }
    | { type: 'tts_end'; sample_rate: number; listen?: boolean }
    | { type: 'status'; state: SatelliteState }
    | { type: 'listen' }
    | { type: 'volume'; level?: number; delta?: number };

/** Prefix a control JSON message with the CONTROL type byte. */
export function encodeControl(msg: ServerToSat): Buffer {
    return Buffer.concat([Buffer.from([TYPE_CONTROL]), Buffer.from(JSON.stringify(msg), 'utf8')]);
}

/** Prefix a raw PCM chunk with the TTS type byte. */
export function encodeTts(pcm: Buffer): Buffer {
    return Buffer.concat([Buffer.from([TYPE_TTS]), pcm]);
}

/** Split an incoming datagram into its type byte and payload (a view onto the original buffer). */
export function decodePacket(data: Buffer): { type: number; payload: Buffer } {
    return { type: data[0], payload: data.subarray(1) };
}
