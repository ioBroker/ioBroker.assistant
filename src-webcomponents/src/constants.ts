/**
 * The web components of the assistant. Each one is built on its own (`vite build --mode <name>`, see
 * `vite.config.ts`), so that each is ONE module file: a host imports exactly one URL per component.
 */

/** Name of a component: the mode of its build and the base name of its files */
export type ComponentName = 'assistant-chat' | 'assistant-satellites';

export const COMPONENT_NAMES: ComponentName[] = ['assistant-chat', 'assistant-satellites'];

/** Tag of `<iob-assistant-chat>`: talk to the assistant - typed, or spoken into the microphone of the browser */
export const CHAT_TAG = 'iob-assistant-chat';

/** Tag of `<iob-assistant-satellites>`: the voice satellites of an instance, live, with announcements */
export const SATELLITES_TAG = 'iob-assistant-satellites';

/** The built module, next to its manifest */
export function getModuleFile(name: ComponentName): string {
    return `${name}.js`;
}

/** The manifest the build writes next to the module; `common.webComponents` names this one */
export function getManifestFile(name: ComponentName): string {
    return `${name}.json`;
}

/** Where the build puts the module in the admin folder; the React import is relative to it */
export function getModulePath(name: ComponentName): string {
    return `webcomponents/${getModuleFile(name)}`;
}

/** The values of the settings of `<iob-assistant-chat>`; a setting without a value is missing */
export type ChatSettings = {
    /** e.g. `assistant.0` */
    instance?: string;
    /** Every request of the journal (satellites, Telegram, scripts), not only those of the chat */
    allRequests?: boolean;
    /** Under every answer: who answered it (rule-based NLU, local or cloud model), how long it took, what it wrote */
    details?: boolean;
    /** Read the answers to what is asked here aloud (the toggle in the element starts with this) */
    speak?: boolean;
};

/** The values of the settings of `<iob-assistant-satellites>`; a setting without a value is missing */
export type SatellitesSettings = {
    /** e.g. `assistant.0` */
    instance?: string;
    /** Announcements on one satellite or on all of them */
    announce?: boolean;
    /** The host a satellite runs on (its address) */
    showHost?: boolean;
};

/**
 * The instance of a setting (`assistant.0`), or '' if it names none. JSON-Config gives `assistant.0`; a host may
 * give the ID of the instance object as well.
 *
 * @param instance the value of the setting
 */
export function getInstance(instance: string | undefined): string {
    const id = (instance || '').trim().replace(/^system\.adapter\./, '');
    return /^assistant\.\d+$/.test(id) ? id : '';
}

/**
 * The source the chat asks as: `ask` without `source` is `chat` - the conversation of the chat in the instance
 * settings, which the assistant remembers per source. The element sends no `source`, so it continues that one.
 */
export const CHAT_SOURCE = 'chat';
