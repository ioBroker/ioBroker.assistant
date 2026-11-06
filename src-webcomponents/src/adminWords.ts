/**
 * The words of the elements that the chat and the satellites tab of the instance settings have in every language
 * (`src-admin/src/i18n/`, keys `custom_assistant_<word>`). The build of a component picks its words out of those
 * files (`vite.config.ts`, fails if one is missing in a language), the element reads them with `createWords()`
 * (`i18n.ts`). A file of its own: the build imports it, and `i18n.ts` needs the picked words to load.
 */
import type { ComponentName } from './constants.ts';

/** The words of `<iob-assistant-chat>`, without the prefix `custom_assistant_` */
export const CHAT_ADMIN_WORDS = [
    'Type a message…',
    'Listening…',
    'Thinking…',
    'Speak',
    'Stop listening',
    'Read answers aloud',
    'Stop reading answers aloud',
    'No messages yet. Type a question below.',
    'Start the assistant instance to chat.',
    'States written',
    'Dialog: listening…',
    'Dialog: hearing you…',
    'Dialog: thinking…',
    'Dialog: speaking…',
    'End the dialog',
    'Dialog: everything you say becomes a question',
    'The microphone could not be opened:',
] as const;

/** The words of `<iob-assistant-satellites>`, without the prefix `custom_assistant_` */
export const SATELLITES_ADMIN_WORDS = [
    'Last seen',
    'Announcement',
    'Send announcement',
    'Speak on all satellites',
    'No satellites registered yet.',
] as const;

/** The words the build picks for each component */
export const ADMIN_WORDS: Record<ComponentName, readonly string[]> = {
    'assistant-chat': CHAT_ADMIN_WORDS,
    'assistant-satellites': SATELLITES_ADMIN_WORDS,
};
