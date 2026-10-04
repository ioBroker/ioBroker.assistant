/**
 * The ESPHome entity layer: everything a voice satellite exposes *besides* the voice pipeline.
 *
 * A device announces its entities once, in response to `ListEntitiesRequest`, and then pushes a state
 * message whenever one changes. Each entity kind has its own pair of messages plus a command message to
 * write it back — `SwitchCommandRequest`, `NumberCommandRequest` and so on, all addressed by the
 * `fixed32 key` from the announcement.
 *
 * This is deliberately driven by {@link KINDS} rather than by the object ids of any one product: a
 * ThirdReality speaker offers microphone gain, noise suppression and two wake-word sensitivities, a Home
 * Assistant Voice PE offers a different set, and both work without a change here. Only entity kinds a
 * voice satellite can plausibly carry are handled; lights, covers and the rest of the ESPHome zoo are
 * ignored, because this adapter drives speakers, not a general ESPHome bridge.
 */
import { pb, type PbMessage } from './esphomeProto';

/** Entity kinds we understand. */
export type EntityKind =
    'switch' | 'number' | 'select' | 'event' | 'update' | 'mediaPlayer' | 'sensor' | 'binarySensor' | 'textSensor';

/** `EntityCategory` in api.proto — config/diagnostic entities are settings, not primary controls. */
export type EntityCategory = 'none' | 'config' | 'diagnostic';
const CATEGORIES: EntityCategory[] = ['none', 'config', 'diagnostic'];

/** One entity as announced by the device, plus its last known value. */
export interface EsphomeEntity {
    kind: EntityKind;
    /** Stable id within the device (`mic_volume`), used as the ioBroker state name. */
    objectId: string;
    /** Wire handle the command messages address. */
    key: number;
    /** Human-readable name as the device labels it. */
    name: string;
    category: EntityCategory;
    icon?: string;
    /** Whether a value can be written back (false for `event`, which is read-only). */
    writable: boolean;
    /** number: range and unit. */
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    /** sensor: how many decimals the device considers meaningful. */
    decimals?: number;
    /** select: allowed values. */
    options?: string[];
    /** event: the types the device can fire. */
    eventTypes?: string[];
    /** mediaPlayer: whether it accepts a pause command. */
    supportsPause?: boolean;
    /** Last value the device reported; undefined until the first state message. */
    value?: EntityValue;
}

/** A value as it travels to and from ioBroker. `update` reports an object, the rest are scalars. */
export type EntityValue = boolean | number | string | UpdateInfo | MediaPlayerValue;

export interface UpdateInfo {
    currentVersion: string;
    latestVersion: string;
    title: string;
    inProgress: boolean;
    progress: number;
    releaseUrl: string;
}

export interface MediaPlayerValue {
    state: 'none' | 'idle' | 'playing' | 'paused' | 'announcing' | 'off' | 'on';
    volume: number;
    muted: boolean;
}

const MEDIA_STATES = ['none', 'idle', 'playing', 'paused', 'announcing', 'off', 'on'] as const;

/** `MediaPlayerCommand` in api.proto, by the name we accept from ioBroker. */
export const MEDIA_COMMANDS: Record<string, number> = {
    play: 0,
    pause: 1,
    stop: 2,
    mute: 3,
    unmute: 4,
    toggle: 5,
    volume_up: 6,
    volume_down: 7,
    turn_on: 12,
    turn_off: 13,
};

/** `UpdateCommand` in api.proto. */
export const UPDATE_COMMANDS: Record<string, number> = { none: 0, install: 1, check: 2 };

/**
 * Minimal structural typing over the generated announcement classes. Every `ListEntities*Response`
 * shares the first four fields, which is what makes the table-driven approach below possible.
 */
interface ListEntityMsg {
    getObjectId(): string;
    getKey(): number;
    getName(): string;
    getEntityCategory(): number;
    getIcon?(): string;
    getDisabledByDefault?(): boolean;
}

/** How one entity kind is announced, reported and written. */
interface KindSpec {
    kind: EntityKind;
    /** `ListEntities…Response` message name. */
    listMessage: string;
    /** `…StateResponse` message name (absent for `event`, which pushes `EventResponse`). */
    stateMessage: string;
    writable: boolean;
    /** Pull the kind-specific announcement fields out. */
    describe?: (msg: unknown) => Partial<EsphomeEntity>;
    /** Read the value out of a state message. */
    readState: (msg: unknown) => EntityValue | undefined;
    /** Build the command message that writes `value`, or null when the value makes no sense. */
    command: (entity: EsphomeEntity, value: unknown) => PbMessage | null;
}

/** Clamp to the device's own range — it ignores anything outside and we would never notice. */
function clamp(entity: EsphomeEntity, value: number): number {
    const lo = entity.min ?? Number.NEGATIVE_INFINITY;
    const hi = entity.max ?? Number.POSITIVE_INFINITY;
    return Math.min(hi, Math.max(lo, value));
}

const KINDS: KindSpec[] = [
    // ── read-only measurements ────────────────────────────────────────────────────────────────────
    // A voice satellite is also a box in a room: it usually reports its own temperature, whether
    // something was detected, or a status text. Read-only, so they only ever produce states.
    {
        kind: 'sensor',
        listMessage: 'ListEntitiesSensorResponse',
        stateMessage: 'SensorStateResponse',
        writable: false,
        describe: m => {
            const sensor = m as { getUnitOfMeasurement(): string; getAccuracyDecimals(): number };
            return {
                unit: sensor.getUnitOfMeasurement() || undefined,
                // The device tells us how many decimals are meaningful; more would be noise.
                decimals: sensor.getAccuracyDecimals(),
            };
        },
        readState: m => {
            const state = m as { getState(): number; getMissingState(): boolean };
            // `missing_state` means the device has no reading yet — not that the value is 0.
            return state.getMissingState() ? undefined : state.getState();
        },
        command: () => null,
    },
    {
        kind: 'binarySensor',
        listMessage: 'ListEntitiesBinarySensorResponse',
        stateMessage: 'BinarySensorStateResponse',
        writable: false,
        readState: m => {
            const state = m as { getState(): boolean; getMissingState(): boolean };
            return state.getMissingState() ? undefined : state.getState();
        },
        command: () => null,
    },
    {
        kind: 'textSensor',
        listMessage: 'ListEntitiesTextSensorResponse',
        stateMessage: 'TextSensorStateResponse',
        writable: false,
        readState: m => {
            const state = m as { getState(): string; getMissingState(): boolean };
            return state.getMissingState() ? undefined : state.getState();
        },
        command: () => null,
    },
    {
        kind: 'switch',
        listMessage: 'ListEntitiesSwitchResponse',
        stateMessage: 'SwitchStateResponse',
        writable: true,
        readState: m => (m as { getState(): boolean }).getState(),
        command: (entity, value) => {
            const message = new pb.SwitchCommandRequest();
            message.setKey(entity.key);
            message.setState(value === true || value === 'true' || value === 1);
            return message;
        },
    },
    {
        kind: 'number',
        listMessage: 'ListEntitiesNumberResponse',
        stateMessage: 'NumberStateResponse',
        writable: true,
        describe: m => {
            const n = m as {
                getMinValue(): number;
                getMaxValue(): number;
                getStep(): number;
                getUnitOfMeasurement(): string;
            };
            return { min: n.getMinValue(), max: n.getMaxValue(), step: n.getStep(), unit: n.getUnitOfMeasurement() };
        },
        readState: m => {
            const n = m as { getState(): number; getMissingState(): boolean };
            return n.getMissingState() ? undefined : n.getState();
        },
        command: (entity, value) => {
            const num = Number(value);
            if (!Number.isFinite(num)) {
                return null;
            }
            const message = new pb.NumberCommandRequest();
            message.setKey(entity.key);
            message.setState(clamp(entity, num));
            return message;
        },
    },
    {
        kind: 'select',
        listMessage: 'ListEntitiesSelectResponse',
        stateMessage: 'SelectStateResponse',
        writable: true,
        describe: m => ({ options: (m as { getOptionsList(): string[] }).getOptionsList() }),
        readState: m => {
            const s = m as { getState(): string; getMissingState(): boolean };
            return s.getMissingState() ? undefined : s.getState();
        },
        command: (entity, value) => {
            // Match case-insensitively: the device only accepts one of its own options verbatim.
            const wanted = String(value).trim().toLowerCase();
            const option = entity.options?.find(o => o.toLowerCase() === wanted);
            if (!option) {
                return null;
            }
            const message = new pb.SelectCommandRequest();
            message.setKey(entity.key);
            message.setState(option);
            return message;
        },
    },
    {
        kind: 'event',
        listMessage: 'ListEntitiesEventResponse',
        stateMessage: 'EventResponse',
        writable: false,
        describe: m => ({ eventTypes: (m as { getEventTypesList(): string[] }).getEventTypesList() }),
        readState: m => (m as { getEventType(): string }).getEventType(),
        command: () => null,
    },
    {
        kind: 'update',
        listMessage: 'ListEntitiesUpdateResponse',
        stateMessage: 'UpdateStateResponse',
        writable: true,
        readState: m => {
            const u = m as {
                getMissingState(): boolean;
                getCurrentVersion(): string;
                getLatestVersion(): string;
                getTitle(): string;
                getInProgress(): boolean;
                getProgress(): number;
                getReleaseUrl(): string;
            };
            if (u.getMissingState()) {
                return undefined;
            }
            return {
                currentVersion: u.getCurrentVersion(),
                latestVersion: u.getLatestVersion(),
                title: u.getTitle(),
                inProgress: u.getInProgress(),
                progress: u.getProgress(),
                releaseUrl: u.getReleaseUrl(),
            };
        },
        command: (entity, value) => {
            const command = UPDATE_COMMANDS[String(value).trim().toLowerCase()];
            if (command === undefined || command === 0) {
                return null;
            }
            const message = new pb.UpdateCommandRequest();
            message.setKey(entity.key);
            message.setCommand(command);
            return message;
        },
    },
    {
        kind: 'mediaPlayer',
        listMessage: 'ListEntitiesMediaPlayerResponse',
        stateMessage: 'MediaPlayerStateResponse',
        writable: true,
        describe: m => ({ supportsPause: (m as { getSupportsPause(): boolean }).getSupportsPause() }),
        readState: m => {
            const p = m as { getState(): number; getVolume(): number; getMuted(): boolean };
            return { state: MEDIA_STATES[p.getState()] ?? 'none', volume: p.getVolume(), muted: p.getMuted() };
        },
        command: (entity, value) => {
            const message = new pb.MediaPlayerCommandRequest();
            message.setKey(entity.key);
            // A number is a volume (0…1), a string is one of the named commands.
            if (typeof value === 'number' || (typeof value === 'string' && /^[\d.]+$/.test(value.trim()))) {
                message.setHasVolume(true);
                message.setVolume(Math.min(1, Math.max(0, Number(value))));
                return message;
            }
            const command = MEDIA_COMMANDS[String(value).trim().toLowerCase()];
            if (command === undefined) {
                return null;
            }
            message.setHasCommand(true);
            message.setCommand(command);
            return message;
        },
    },
];

const BY_LIST_MESSAGE = new Map(KINDS.map(k => [k.listMessage, k]));
const BY_STATE_MESSAGE = new Map(KINDS.map(k => [k.stateMessage, k]));
const BY_KIND = new Map(KINDS.map(k => [k.kind, k]));

/** True when this message announces an entity kind we handle. */
export function isListEntityMessage(name: string): boolean {
    return BY_LIST_MESSAGE.has(name);
}

/** True when this message carries a state for an entity kind we handle. */
export function isEntityStateMessage(name: string): boolean {
    return BY_STATE_MESSAGE.has(name);
}

/**
 * The entities of one device. Announcements arrive once after `ListEntitiesRequest`; state messages
 * arrive continuously and are matched back by `key`.
 */
export class EntityRegistry {
    private readonly byKey = new Map<number, EsphomeEntity>();
    private readonly byObjectId = new Map<string, EsphomeEntity>();

    /** Every entity the device announced, in announcement order. */
    list(): EsphomeEntity[] {
        return [...this.byKey.values()];
    }

    get(objectId: string): EsphomeEntity | undefined {
        return this.byObjectId.get(objectId);
    }

    /** Forget everything — the device re-announces after every reconnect. */
    clear(): void {
        this.byKey.clear();
        this.byObjectId.clear();
    }

    /** Take a `ListEntities…Response`. Returns the entity, or null for a kind we ignore. */
    addFromAnnouncement(name: string, message: unknown): EsphomeEntity | null {
        const spec = BY_LIST_MESSAGE.get(name);
        if (!spec) {
            return null;
        }
        const base = message as ListEntityMsg;
        const entity: EsphomeEntity = {
            kind: spec.kind,
            objectId: base.getObjectId(),
            key: base.getKey(),
            name: base.getName(),
            category: CATEGORIES[base.getEntityCategory()] ?? 'none',
            icon: base.getIcon?.() || undefined,
            writable: spec.writable,
            ...spec.describe?.(message),
        };
        this.byKey.set(entity.key, entity);
        this.byObjectId.set(entity.objectId, entity);
        return entity;
    }

    /**
     * Take a `…StateResponse`. Returns the updated entity, or null when it belongs to an entity the
     * device never announced — which happens legitimately, because the device pushes the current state
     * of everything as soon as we subscribe, possibly before its announcements have arrived.
     */
    applyState(name: string, message: unknown): EsphomeEntity | null {
        const spec = BY_STATE_MESSAGE.get(name);
        if (!spec) {
            return null;
        }
        const entity = this.byKey.get((message as { getKey(): number }).getKey());
        if (!entity) {
            return null;
        }
        const value = spec.readState(message);
        if (value === undefined) {
            return null;
        }
        entity.value = value;
        return entity;
    }

    /**
     * Build the command message that writes `value` to `objectId`, or null when the entity is unknown,
     * read-only, or the value is not one it accepts.
     */
    command(objectId: string, value: unknown): PbMessage | null {
        const entity = this.byObjectId.get(objectId);
        if (!entity?.writable) {
            return null;
        }
        return BY_KIND.get(entity.kind)?.command(entity, value) ?? null;
    }
}
