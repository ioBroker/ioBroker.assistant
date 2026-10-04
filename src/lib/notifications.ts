/**
 * System notifications → one spoken sentence.
 *
 * ioBroker's notifications are written for a log viewer, not for a speaker: they carry origin prefixes
 * (`system.host.pi: admin.0: …`), timestamps in `M/D/YYYY` form, version numbers and sometimes empty
 * objects. Read out verbatim they are unlistenable, so the text is cleaned up here and (unless the caller
 * asks for `direct`) reworded by the LLM with a tone that matches the severity.
 *
 * The three severities are ioBroker's own (`info` < `notify` < `alert`, see `ioBroker.NotificationCategory`),
 * so a notification routed here by the notification-manager keeps its meaning; `direct` is ours and means
 * "speak exactly this".
 *
 * Ported from the Python original (`C:\iot\Hannah`, `core/main.py:1553` `process_notification`), whose
 * prompt hints are kept: they were written against real ioBroker notification texts.
 */

export type Severity = 'alert' | 'notify' | 'info' | 'direct';

const SEVERITIES: Severity[] = ['alert', 'notify', 'info', 'direct'];

/** A translated ioBroker field: either a plain string or a per-language map. */
export type MaybeTranslated = string | Record<string, string> | undefined;

/** Read a severity from arbitrary input, falling back to `notify` (ioBroker's middle priority). */
export function parseSeverity(value: unknown, fallback: Severity = 'notify'): Severity {
    if (typeof value !== 'string') {
        return fallback;
    }
    const v = value.trim().toLowerCase();
    return (SEVERITIES as string[]).includes(v) ? (v as Severity) : fallback;
}

/**
 * How a severity should sound. Instruction for the model (English, while the spoken output stays in the
 * user's language); `direct` returns '' because nothing is reworded in that case.
 */
export function toneFor(severity: Severity): string {
    switch (severity) {
        case 'alert':
            return 'Be clear and direct, and make it obvious that this matters.';
        case 'info':
            return 'Mention it in passing, as an aside.';
        case 'direct':
            return '';
        default:
            return 'Keep it casual and direct, like a flatmate briefly letting you know.';
    }
}

/** True for the severity that is urgent enough to be played even on a satellite set to Do-Not-Disturb. */
export function bypassesDnd(severity: Severity): boolean {
    return severity === 'alert';
}

/** Matches the origin prefixes ioBroker prepends, e.g. `system.host.pi:` or `admin.0:`. */
const ORIGIN_PREFIX = /^(?:\s*(?:system\.host\.[\w.-]+|[\w-]+\.\d+)\s*:\s*)+/;

/**
 * Make a notification text speakable: drop the origin prefixes from every line, fold the lines into one
 * and collapse the whitespace. Nothing else is interpreted — the meaning is the LLM's job, and for
 * `direct` the caller explicitly wants their own wording.
 *
 * A number or boolean is accepted (a payload field may hold one), but anything structured yields '':
 * stringifying an object would have the satellite announce "[object Object]".
 */
export function cleanupNotificationText(text: unknown): string {
    const raw =
        typeof text === 'string' ? text : typeof text === 'number' || typeof text === 'boolean' ? String(text) : '';
    const lines = raw
        .split(/[\r\n]+/)
        .map(line => line.replace(ORIGIN_PREFIX, '').trim())
        .filter(Boolean);
    return lines.join(' ').replace(/\s+/g, ' ').trim();
}

/** Pick a language from a translated field (preferred language, then English, then the first one). */
export function translated(value: MaybeTranslated, language = 'en'): string {
    if (!value) {
        return '';
    }
    if (typeof value === 'string') {
        return value.trim();
    }
    const map = value;
    return String(map[language] || map.en || Object.values(map)[0] || '').trim();
}

/** What a notification boils down to for the spoken channel. */
export interface FlatNotification {
    text: string;
    severity: Severity;
    /** Category name, for the log and the `notify.last` state. */
    category: string;
}

/** How many of a category's messages are worth speaking — the newest ones; the rest is log material. */
const MAX_MESSAGES = 3;

/**
 * Flatten a notification-manager payload (`sendNotification` message) into text, severity and category.
 *
 * Deliberately defensive: the payload shape belongs to the notification-manager, not to a published type
 * we can compile against, so every field is optional here and anything unexpected degrades to a plain
 * description instead of throwing. An empty `text` means "nothing worth speaking".
 */
export function flattenNotification(message: unknown, language = 'en'): FlatNotification {
    const msg = (message ?? {}) as {
        category?: {
            name?: MaybeTranslated;
            description?: MaybeTranslated;
            severity?: unknown;
            instances?: Record<string, { messages?: { message?: string; ts?: number }[] }>;
        };
        host?: string;
    };
    const category = msg.category ?? {};
    const name = translated(category.name, language);
    const description = translated(category.description, language);
    const severity = parseSeverity(category.severity);

    const details: string[] = [];
    for (const [instance, info] of Object.entries(category.instances ?? {})) {
        const messages = (info?.messages ?? [])
            .slice(-MAX_MESSAGES)
            .map(m => cleanupNotificationText(m?.message))
            .filter(Boolean);
        if (messages.length) {
            details.push(`${instance}: ${messages.join(' ')}`);
        }
    }

    // The description is boilerplate that repeats the category — only useful when there is nothing else.
    const body = details.length ? details.join(' — ') : description;
    const text = cleanupNotificationText([name, body].filter(Boolean).join(': '));
    return { text, severity, category: name || description };
}
