/**
 * The voice satellites of the assistant as a web component: `<iob-assistant-satellites>` - the satellites tab of
 * the instance settings (`src-admin/src/SatellitesComponent.tsx`) without what only belongs there: the settings
 * dialog of a satellite and removing one.
 *
 * One module for every host - vis-2, devices, Aura, admin (`@iobroker/web-components`). Its manifest is a file of
 * its own (`assistant-satellites.json`, written by the build from `manifest.ts`), so a host loads this module only
 * when it shows the element. The host sets `socket` and `settings`, and if it has them `theme`, `editMode` and
 * `dialogs`.
 *
 * The satellites are the devices below `assistant.<n>.satellites.`, found with `getObjectViewSystem` (read again
 * every few minutes, so a new one shows up), with their states `status`, `room`, `host`, `alive` and `lastSeen`.
 * An announcement writes `satellites.<id>.tts` - or `tts.text` for all of them - as the tab does.
 *
 * React is not in the module: it comes from `lib/esm/react-19.js` beside `adapter/`, see `vite.config.ts`.
 */
import { useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { WebComponentSocket } from '@iobroker/web-components';
import { defineWebComponent, IobWebComponent } from '@iobroker/web-components/element';

import { getInstance, SATELLITES_TAG, type SatellitesSettings } from './constants';
import { toLocale } from './i18n';
import { getSatellitesWords, type SatellitesWords } from './satellitesWords';
import { Hint, Icon, ICONS } from './icons';
import { SATELLITES_STYLES } from './styles';

/** The states of a satellite the element shows */
const SATELLITE_STATES = ['status', 'room', 'host', 'alive', 'lastSeen'] as const;

/** How often "5 min ago" is computed again */
const TICK_MS = 30_000;

/** How often the satellites are looked for again, in ticks: a new one shows up within 5 minutes */
const RESCAN_TICKS = 10;

const STATUS_WORDS: Record<string, Parameters<SatellitesWords>[0]> = {
    idle: 'status_idle',
    listening: 'status_listening',
    processing: 'status_processing',
    speaking: 'status_speaking',
    offline: 'offline',
};

/** A satellite with its states */
interface Satellite {
    /** The ID below `satellites.` */
    id: string;
    /** The name of its object: the room, or the name of the device */
    name: string;
    status: string;
    room: string;
    host: string;
    alive: boolean;
    /** ms, 0 = never */
    lastSeen: number;
}

/** The IDs as one comparable text */
function toKey(ids: string[]): string {
    return [...new Set(ids)].sort().join('\n');
}

/**
 * "5 min ago" in the language of the system
 *
 * @param ts when, in ms
 * @param now now, in ms
 * @param locale BCP 47
 */
function formatAgo(ts: number, now: number, locale: string): string {
    if (!ts) {
        return '—';
    }
    const seconds = Math.round((ts - now) / 1000);
    const abs = Math.abs(seconds);
    let value = seconds;
    let unit: Intl.RelativeTimeFormatUnit = 'second';
    if (abs >= 86_400) {
        value = Math.round(seconds / 86_400);
        unit = 'day';
    } else if (abs >= 3600) {
        value = Math.round(seconds / 3600);
        unit = 'hour';
    } else if (abs >= 60) {
        value = Math.round(seconds / 60);
        unit = 'minute';
    }
    try {
        return new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' }).format(value, unit);
    } catch {
        return new Date(ts).toLocaleString();
    }
}

interface ListProps {
    satellites: Satellite[] | null;
    announce: boolean;
    showHost: boolean;
    editMode: boolean;
    now: number;
    locale: string;
    word: SatellitesWords;
    onAnnounce: (satellite: Satellite) => void;
    onAnnounceAll: (text: string) => void;
}

function SatelliteList(props: ListProps): JSX.Element {
    const { satellites, word, editMode } = props;
    const [text, setText] = useState('');
    const sendAll = (): void => {
        const value = text.trim();
        if (value && !editMode) {
            props.onAnnounceAll(value);
            setText('');
        }
    };

    return (
        <div className={`satellites${editMode ? ' edit' : ''}`}>
            <div className="list">
                {satellites === null ? null : satellites.length ? (
                    satellites.map(sat => {
                        const sub = [sat.room && sat.room !== sat.name ? sat.room : '', props.showHost ? sat.host : '']
                            .filter(Boolean)
                            .join(' · ');
                        const statusWord = STATUS_WORDS[sat.status];
                        return (
                            <div
                                key={sat.id}
                                className="sat"
                            >
                                <span
                                    className={`dot${sat.alive ? ' alive' : ''}`}
                                    title={word(sat.alive ? 'online' : 'offline')}
                                />
                                <div className="info">
                                    <span
                                        className="name"
                                        title={sat.id}
                                    >
                                        {sat.name}
                                    </span>
                                    {sub ? <span className="sub">{sub}</span> : null}
                                </div>
                                <span className={`status ${sat.status}`}>
                                    {statusWord ? word(statusWord) : sat.status}
                                </span>
                                <span
                                    className="seen"
                                    title={
                                        sat.lastSeen
                                            ? `${word('Last seen')}: ${new Date(sat.lastSeen).toLocaleString(props.locale)}`
                                            : word('Last seen')
                                    }
                                >
                                    {formatAgo(sat.lastSeen, props.now, props.locale)}
                                </span>
                                {props.announce ? (
                                    <button
                                        type="button"
                                        className="icon-btn primary"
                                        title={word('Send announcement')}
                                        aria-label={word('Send announcement')}
                                        disabled={editMode}
                                        onClick={() => props.onAnnounce(sat)}
                                    >
                                        <Icon path={ICONS.announce} />
                                    </button>
                                ) : null}
                            </div>
                        );
                    })
                ) : (
                    <div className="empty">{word('No satellites registered yet.')}</div>
                )}
            </div>
            {props.announce && satellites?.length ? (
                <div className="composer">
                    <input
                        className="field"
                        type="text"
                        value={text}
                        placeholder={word('Speak on all satellites')}
                        disabled={editMode}
                        onChange={e => setText(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                sendAll();
                            }
                        }}
                    />
                    <button
                        type="button"
                        className="icon-btn filled"
                        title={word('Speak on all satellites')}
                        aria-label={word('Speak on all satellites')}
                        disabled={editMode || !text.trim()}
                        onClick={sendAll}
                    >
                        <Icon path={ICONS.announce} />
                    </button>
                </div>
            ) : null}
        </div>
    );
}

class VoiceSatellitesElement extends IobWebComponent<SatellitesSettings> {
    readonly #root: Root;

    /** The satellites of `#satellitesFor`: ID -> name; null while they are read */
    #satellites: Map<string, string> | null = null;

    #satellitesFor = '';

    #satellitesSocket: WebComponentSocket | null = null;

    /** The states `getStateIds` named last - what the base class has subscribed */
    #subscribed = '';

    #ticker: ReturnType<typeof setInterval> | null = null;

    #ticks = 0;

    constructor() {
        super();
        const shadow = this.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = SATELLITES_STYLES;
        const mount = document.createElement('div');
        mount.className = 'mount';
        shadow.append(style, mount);
        this.#root = createRoot(mount);
    }

    override connectedCallback(): void {
        super.connectedCallback();
        this.#ticker ||= setInterval(() => this.#tick(), TICK_MS);
    }

    override disconnectedCallback(): void {
        super.disconnectedCallback();
        if (this.#ticker) {
            clearInterval(this.#ticker);
            this.#ticker = null;
        }
    }

    protected override getStateIds(settings: SatellitesSettings): string[] {
        const ids = this.#getWantedIds(settings);
        this.#subscribed = toKey(ids);
        return ids;
    }

    /** The states of the satellites found for the instance of these settings */
    #getWantedIds(settings: SatellitesSettings): string[] {
        const instance = getInstance(settings.instance);
        if (!instance || instance !== this.#satellitesFor || !this.#satellites) {
            return [];
        }
        return [...this.#satellites.keys()].flatMap(id =>
            SATELLITE_STATES.map(name => `${instance}.satellites.${id}.${name}`),
        );
    }

    #tick(): void {
        if (++this.#ticks % RESCAN_TICKS === 0) {
            // look for new satellites: read again with the next drawing
            this.#satellitesSocket = null;
        }
        if (this.isConnected) {
            this.render();
        }
    }

    /** Read the satellites of the instance once - again when the instance or the socket changes, or to rescan */
    #loadSatellites(instance: string): void {
        const socket = this.socket;
        if (!socket || (instance === this.#satellitesFor && socket === this.#satellitesSocket)) {
            return;
        }
        if (instance !== this.#satellitesFor) {
            this.#satellites = null;
        }
        this.#satellitesFor = instance;
        this.#satellitesSocket = socket;
        const prefix = `${instance}.satellites.`;
        socket
            .getObjectViewSystem('device', prefix, `${prefix}香`)
            .then(devices => {
                const lang = this.systemLang;
                const found = new Map<string, string>();
                for (const [id, obj] of Object.entries(devices || {})) {
                    const satId = id.slice(prefix.length);
                    // the satellites themselves, not what lies below them
                    if (!satId || satId.includes('.')) {
                        continue;
                    }
                    const name = obj?.common?.name;
                    const text = typeof name === 'string' ? name : name ? name[lang] || name.en || '' : '';
                    found.set(satId, text || satId);
                }
                return found;
            })
            .catch((error: unknown) => {
                console.warn(`<${this.localName}>: cannot read the satellites of ${instance}: ${String(error)}`);
                return this.#satellites || new Map<string, string>();
            })
            .then(found => {
                if (instance === this.#satellitesFor && socket === this.#satellitesSocket) {
                    this.#satellites = found;
                    this.#resubscribe();
                }
            })
            .catch(() => undefined);
    }

    /** Have the states subscribed that `getStateIds` names now: the base class asks again for new settings */
    #resubscribe(): void {
        const settings = this.settings;
        this.settings = settings;
    }

    #getSatellites(instance: string): Satellite[] | null {
        if (!this.#satellites || instance !== this.#satellitesFor) {
            return null;
        }
        const value = (id: string, name: string): ioBroker.StateValue | undefined =>
            this.states[`${instance}.satellites.${id}.${name}`]?.val;
        return [...this.#satellites.entries()]
            .map(([id, name]) => ({
                id,
                name,
                status: String(value(id, 'status') ?? 'idle'),
                room: String(value(id, 'room') ?? ''),
                host: String(value(id, 'host') ?? ''),
                alive: !!value(id, 'alive'),
                lastSeen: Number(value(id, 'lastSeen')) || 0,
            }))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.id.localeCompare(b.id));
    }

    /** Speak a text on one satellite: as the satellites tab, through its `tts` state */
    async #announce(instance: string, satellite: Satellite, word: SatellitesWords): Promise<void> {
        if (this.editMode) {
            return;
        }
        const result = await this.openDialog({
            title: `${word('Announcement')} · ${satellite.name}`,
            form: {
                type: 'panel',
                items: {
                    text: { type: 'text', label: word('whatToSay') },
                },
            },
            data: { text: '' },
            ok: word('Send announcement'),
        });
        const text = typeof result?.text === 'string' ? result.text.trim() : '';
        if (text) {
            await this.setState(`${instance}.satellites.${satellite.id}.tts`, text).catch(() => undefined);
        }
    }

    protected override render(): void {
        const instance = getInstance(this.settings.instance);
        const lang = this.systemLang;
        const word = getSatellitesWords(lang);
        if (!instance) {
            this.#root.render(
                <Hint
                    text={word('chooseInstance')}
                    icon={ICONS.speaker}
                    editMode={this.editMode}
                />,
            );
            return;
        }
        this.#loadSatellites(instance);
        if (this.socket && toKey(this.#getWantedIds(this.settings)) !== this.#subscribed) {
            // draws again once subscribed
            this.#resubscribe();
            return;
        }
        this.#root.render(
            <SatelliteList
                satellites={this.#getSatellites(instance)}
                announce={this.settings.announce !== false}
                showHost={!!this.settings.showHost}
                editMode={this.editMode}
                now={Date.now()}
                locale={toLocale(lang)}
                word={word}
                onAnnounce={satellite => void this.#announce(instance, satellite, word)}
                onAnnounceAll={text => void this.setState(`${instance}.tts.text`, text).catch(() => undefined)}
            />,
        );
    }
}

defineWebComponent(SATELLITES_TAG, VoiceSatellitesElement);
