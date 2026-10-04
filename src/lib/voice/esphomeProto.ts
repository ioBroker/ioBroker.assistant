/**
 * ESPHome native-API wire codec (plain-text framing) — the transport half of `esphome.ts`.
 *
 * Frame layout: `0x00 | varint(payload length) | varint(message id) | payload (protobuf)`.
 *
 * Only the generated protobuf classes of `@2colors/esphome-native-api` are reused, not its
 * `Connection`/`FrameHelper`: that package's id↔type table stops at the Bluetooth range and omits the
 * whole VoiceAssistant block (89–92, 106, 115, 119–123). Worse, an unknown id makes its frame helper
 * throw *without advancing the read buffer*, so the connection stalls instead of skipping the message.
 * The registry here is derived from the `api.proto` the package ships, which covers every message the
 * device can send, and unknown ids are skipped by their declared length.
 *
 * The device speaks plain text (no noise encryption) — confirmed in the firmware's
 * `linux-voice-assistant-cpp` README ("ESPHome native API server (TCP 6053, plain-text framing,
 * protobuf)") — so the encrypted variant is deliberately not implemented; `decode` reports it clearly
 * if a device ever shows up with encryption switched on.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── minimal structural typing over the generated protobuf classes ───────────────────────────────────

export interface PbMessage {
    serializeBinary(): Uint8Array;
}

/** Messages we build and send (client → device). */
export interface HelloRequest extends PbMessage {
    setClientInfo(value: string): void;
    setApiVersionMajor(value: number): void;
    setApiVersionMinor(value: number): void;
}
export interface AuthenticationRequest extends PbMessage {
    setPassword(value: string): void;
}
export interface SubscribeVoiceAssistantRequest extends PbMessage {
    setSubscribe(value: boolean): void;
    setFlags(value: number): void;
}
export interface VoiceAssistantResponseMsg extends PbMessage {
    setPort(value: number): void;
    setError(value: boolean): void;
}
export interface VoiceAssistantEventData extends PbMessage {
    setName(value: string): void;
    setValue(value: string): void;
}
export interface VoiceAssistantEventResponse extends PbMessage {
    setEventType(value: number): void;
    setDataList(value: VoiceAssistantEventData[]): void;
}
export interface VoiceAssistantAnnounceRequest extends PbMessage {
    setMediaId(value: string): void;
    setText(value: string): void;
    setPreannounceMediaId(value: string): void;
    setStartConversation(value: boolean): void;
}
export interface GetTimeResponse extends PbMessage {
    setEpochSeconds(value: number): void;
}
/** Selects which of the device's wake words are listening; the device persists this itself. */
export interface VoiceAssistantSetConfiguration extends PbMessage {
    setActiveWakeWordsList(value: string[]): void;
}

// Entity command messages. All address an entity by the `fixed32 key` from its announcement.
export interface SwitchCommandRequest extends PbMessage {
    setKey(value: number): void;
    setState(value: boolean): void;
}
export interface NumberCommandRequest extends PbMessage {
    setKey(value: number): void;
    setState(value: number): void;
}
export interface SelectCommandRequest extends PbMessage {
    setKey(value: number): void;
    setState(value: string): void;
}
export interface UpdateCommandRequest extends PbMessage {
    setKey(value: number): void;
    setCommand(value: number): void;
}
export interface MediaPlayerCommandRequest extends PbMessage {
    setKey(value: number): void;
    setHasCommand(value: boolean): void;
    setCommand(value: number): void;
    setHasVolume(value: boolean): void;
    setVolume(value: number): void;
}
/** Mirrors an assistant timer onto the device, which drives its own LED ring and gong. */
export interface VoiceAssistantTimerEventResponse extends PbMessage {
    setEventType(value: number): void;
    setTimerId(value: string): void;
    setName(value: string): void;
    setTotalSeconds(value: number): void;
    setSecondsLeft(value: number): void;
    setIsActive(value: boolean): void;
}

/** Messages we receive (device → client). */
export interface HelloResponse {
    getApiVersionMajor(): number;
    getApiVersionMinor(): number;
    getServerInfo(): string;
    getName(): string;
}
export interface AuthenticationResponse {
    getInvalidPassword(): boolean;
}
export interface DeviceInfoResponse {
    getName(): string;
    getModel(): string;
    getEsphomeVersion(): string;
    getMacAddress(): string;
}
export interface VoiceAssistantWakeWord {
    getId(): string;
    getWakeWord(): string;
    /** ISO-639-1 codes the model was trained on — only `okay_nabu` covers more than English. */
    getTrainedLanguagesList(): string[];
}
export interface VoiceAssistantConfigurationResponse {
    getAvailableWakeWordsList(): VoiceAssistantWakeWord[];
    getActiveWakeWordsList(): string[];
    /** How many wake words may listen at once (2 on the ThirdReality speaker). */
    getMaxActiveWakeWords(): number;
}
export interface VoiceAssistantRequestMsg {
    getStart(): boolean;
    getConversationId(): string;
    getWakeWordPhrase(): string;
}
export interface VoiceAssistantAudio {
    getData_asU8(): Uint8Array;
    getEnd(): boolean;
}
export interface VoiceAssistantAnnounceFinished {
    getSuccess(): boolean;
}

type Ctor<T> = new () => T;

interface ApiPb {
    HelloRequest: Ctor<HelloRequest>;
    AuthenticationRequest: Ctor<AuthenticationRequest>;
    DeviceInfoRequest: Ctor<PbMessage>;
    ListEntitiesRequest: Ctor<PbMessage>;
    SubscribeStatesRequest: Ctor<PbMessage>;
    SubscribeVoiceAssistantRequest: Ctor<SubscribeVoiceAssistantRequest>;
    VoiceAssistantConfigurationRequest: Ctor<PbMessage>;
    VoiceAssistantSetConfiguration: Ctor<VoiceAssistantSetConfiguration>;
    VoiceAssistantTimerEventResponse: Ctor<VoiceAssistantTimerEventResponse>;
    SwitchCommandRequest: Ctor<SwitchCommandRequest>;
    NumberCommandRequest: Ctor<NumberCommandRequest>;
    SelectCommandRequest: Ctor<SelectCommandRequest>;
    UpdateCommandRequest: Ctor<UpdateCommandRequest>;
    MediaPlayerCommandRequest: Ctor<MediaPlayerCommandRequest>;
    VoiceAssistantResponse: Ctor<VoiceAssistantResponseMsg>;
    VoiceAssistantEventResponse: Ctor<VoiceAssistantEventResponse>;
    VoiceAssistantEventData: Ctor<VoiceAssistantEventData>;
    VoiceAssistantAnnounceRequest: Ctor<VoiceAssistantAnnounceRequest>;
    PingRequest: Ctor<PbMessage>;
    PingResponse: Ctor<PbMessage>;
    GetTimeResponse: Ctor<GetTimeResponse>;
    DisconnectRequest: Ctor<PbMessage>;
    DisconnectResponse: Ctor<PbMessage>;
    [name: string]: Ctor<unknown> | undefined;
}

const API_PB_MODULE = '@2colors/esphome-native-api/lib/protoc/api_pb';

export const pb = require(API_PB_MODULE) as ApiPb;

// ── message registry, built from the shipped api.proto ──────────────────────────────────────────────

/** Deserialiser for one message id. */
interface Deserialiser {
    deserializeBinary(bytes: Uint8Array): unknown;
}

const idToName = new Map<number, string>();
const classById = new Map<number, Deserialiser>();
/** Message class → its wire id, so `encode` can find the id from an instance. */
const idByCtor = new Map<unknown, number>();

function buildRegistry(): void {
    const protoFile = path.join(path.dirname(require.resolve(API_PB_MODULE)), 'api.proto');
    const source = fs.readFileSync(protoFile, 'utf8');
    let current: string | null = null;

    for (const raw of source.split(/\r?\n/)) {
        const line = raw.trim();
        const message = /^message\s+(\w+)\s*\{/.exec(line);
        if (message) {
            current = message[1];
            continue;
        }
        if (line === '}') {
            current = null;
            continue;
        }
        const option = /^option\s*\(\s*id\s*\)\s*=\s*(\d+)\s*;/.exec(line);
        if (!option || !current) {
            continue;
        }
        const ctor = pb[current];
        if (!ctor) {
            continue; // in the .proto but not in the generated JS — nothing we can do with it
        }
        const id = Number(option[1]);
        idToName.set(id, current);
        classById.set(id, ctor as unknown as Deserialiser);
        idByCtor.set(ctor, id);
    }
}
buildRegistry();

/** Number of messages the registry knows (130 with the shipped api.proto) — used by the unit test. */
export const registrySize = idToName.size;

// ── varint helpers ──────────────────────────────────────────────────────────────────────────────────

function encodeVarint(value: number): number[] {
    const out: number[] = [];
    let rest = value >>> 0;
    do {
        let byte = rest & 0x7f;
        rest >>>= 7;
        if (rest) {
            byte |= 0x80;
        }
        out.push(byte);
    } while (rest);
    return out;
}

/** Read a varint at `offset`; null when the buffer holds only part of it (wait for more data). */
function readVarint(buf: Buffer, offset: number): { value: number; offset: number } | null {
    let result = 0;
    let shift = 0;
    let pos = offset;
    while (pos < buf.length) {
        const byte = buf[pos++];
        result |= (byte & 0x7f) << shift;
        if (!(byte & 0x80)) {
            return { value: result >>> 0, offset: pos };
        }
        shift += 7;
        if (shift > 28) {
            throw new Error('malformed varint');
        }
    }
    return null;
}

// ── framing ─────────────────────────────────────────────────────────────────────────────────────────

/** Serialise one protobuf message into a complete frame. */
export function encode(message: PbMessage): Buffer {
    const id = idByCtor.get((message as object).constructor);
    if (id === undefined) {
        throw new Error('message class is not registered in the ESPHome id table');
    }
    const payload = Buffer.from(message.serializeBinary());
    return Buffer.concat([Buffer.from([0, ...encodeVarint(payload.length), ...encodeVarint(id)]), payload]);
}

export interface DecodedFrame {
    id: number;
    /** null for a message id the registry doesn't know — the frame was skipped by its declared length. */
    name: string | null;
    /** The decoded message, or null when the id is unknown or the payload didn't parse. */
    message: unknown;
    /** Set when a known message failed to deserialise. */
    error: Error | null;
}

/**
 * Pull every complete frame out of `buffer`. Returns the frames plus the unconsumed tail; the input is
 * never mutated, so the caller just keeps assigning `rest` back to its receive buffer.
 */
export function decode(buffer: Buffer): { frames: DecodedFrame[]; rest: Buffer } {
    const frames: DecodedFrame[] = [];
    let offset = 0;

    while (offset < buffer.length) {
        if (buffer[offset] !== 0) {
            throw new Error(
                buffer[offset] === 1
                    ? 'device uses the encrypted (noise) ESPHome API — only plain text is supported'
                    : `bad frame preamble 0x${buffer[offset].toString(16)}`,
            );
        }
        const length = readVarint(buffer, offset + 1);
        if (!length) {
            break;
        }
        const id = readVarint(buffer, length.offset);
        if (!id) {
            break;
        }
        const end = id.offset + length.value;
        if (end > buffer.length) {
            break; // frame not fully received yet
        }

        const payload = buffer.subarray(id.offset, end);
        const name = idToName.get(id.value) ?? null;
        const ctor = classById.get(id.value);
        let message: unknown = null;
        let error: Error | null = null;
        if (ctor) {
            try {
                message = ctor.deserializeBinary(payload);
            } catch (e) {
                error = e as Error;
            }
        }
        frames.push({ id: id.value, name, message, error });
        offset = end;
    }

    return { frames, rest: buffer.subarray(offset) };
}
