/**
 * Countdown timers / reminders — the model-free, self-contained timer engine (roadmap #2).
 *
 * Unlike the Python assistant "Hannah" (which keeps timers only in SQLite and signals satellites over
 * gRPC/MQTT, creating no ioBroker objects), this manager is deliberately ioBroker-first: it holds the
 * active timers in memory and fires each one with its own `setTimeout`, while `main.ts` mirrors every
 * timer into `assistant.0.timers.*` states so they can be visualised or reacted to from JavaScript.
 *
 * States are written only on change events (add/cancel/fire/restore) — never on a periodic tick. The
 * live countdown is derived from the absolute `fireAt` timestamp by the consumer (vis widget / script),
 * so nothing hammers the states/history every second.
 *
 * The manager itself is transport-agnostic and testable: it schedules, cancels and restores timers and
 * emits callbacks (`onFire`, `onChange`); the adapter owns the ioBroker representation and the spoken
 * announcement.
 */

/** One active countdown timer. Plain data so it round-trips through JSON for persistence. */
export interface TimerInfo {
    /** Short unique id (also the `timers.items.<id>` state-object segment). */
    id: string;
    /** Optional label ("die Nudeln"); '' when the user only gave a duration. */
    label: string;
    /** Room the command came from / was scoped to ('' when unknown). */
    room: string;
    /** Origin of the request (satellite device name / 'chat' / '') — used to target the announcement. */
    source: string;
    /** Epoch ms the timer was created. */
    createdAt: number;
    /** Original duration in seconds. */
    duration: number;
    /** Epoch ms the timer fires at. */
    fireAt: number;
}

/** Options for creating a new timer. */
export interface AddTimerOptions {
    label?: string;
    room?: string;
    source?: string;
    /** Duration in seconds (> 0). */
    duration: number;
}

export interface TimerManagerOptions {
    /** Called once per timer when it expires (already removed from the active list). */
    onFire: (timer: TimerInfo) => void;
    /** Called whenever the active list changes (add/cancel/fire/restore) with the new sorted list. */
    onChange: (timers: TimerInfo[]) => void;
    log?: Pick<ioBroker.Log, 'debug' | 'info' | 'warn'>;
    /** Injectable clock (tests). Defaults to `Date.now`. */
    now?: () => number;
    /** Don't arm real `setTimeout`s — the caller drives {@link TimerManager.tick} (tests). */
    manualTick?: boolean;
}

/** Largest delay `setTimeout` accepts (~24.8 days); longer timers are re-armed in chunks. */
const MAX_TIMEOUT = 2 ** 31 - 1;

/**
 * In-memory countdown timer scheduler. Each timer fires from its own `setTimeout` (no polling loop), and
 * the manager never touches any state on a periodic schedule — only on add/cancel/fire/restore.
 */
export class TimerManager {
    private readonly timers = new Map<string, TimerInfo>();
    private readonly handles = new Map<string, ReturnType<typeof setTimeout>>();
    private seq = 0;
    private readonly now: () => number;

    constructor(private readonly opts: TimerManagerOptions) {
        this.now = opts.now || Date.now;
    }

    /** Add a timer, schedule it and notify. Returns the created {@link TimerInfo}. */
    add(o: AddTimerOptions): TimerInfo {
        const now = this.now();
        const duration = Math.max(1, Math.round(o.duration));
        const info: TimerInfo = {
            id: this.genId(now),
            label: (o.label || '').trim(),
            room: (o.room || '').trim(),
            source: o.source || '',
            createdAt: now,
            duration,
            fireAt: now + duration * 1000,
        };
        this.timers.set(info.id, info);
        this.opts.log?.debug(`timer added: ${info.id} "${info.label}" in ${duration}s`);
        this.arm(info);
        this.emitChange();
        return info;
    }

    /** Cancel one timer by id. Returns true if it existed. */
    cancel(id: string): boolean {
        this.clearHandle(id);
        if (!this.timers.delete(id)) {
            return false;
        }
        this.emitChange();
        return true;
    }

    /** Cancel all active timers (optionally only those in a room). Returns the number cancelled. */
    cancelAll(room?: string): number {
        const victims = this.list().filter(t => !room || t.room === room);
        for (const t of victims) {
            this.clearHandle(t.id);
            this.timers.delete(t.id);
        }
        if (victims.length) {
            this.emitChange();
        }
        return victims.length;
    }

    /** The active timers, soonest-to-fire first. */
    list(): TimerInfo[] {
        return [...this.timers.values()].sort((a, b) => a.fireAt - b.fireAt);
    }

    get(id: string): TimerInfo | undefined {
        return this.timers.get(id);
    }

    /**
     * Restore persisted timers after a restart: timers still in the future are rescheduled, ones that
     * already expired while the adapter was down are dropped (announcing them late would be surprising).
     * Returns how many were restored / dropped.
     */
    restore(list: TimerInfo[]): { restored: number; dropped: number } {
        const now = this.now();
        let restored = 0;
        let dropped = 0;
        for (const t of list) {
            if (!t || typeof t.fireAt !== 'number' || typeof t.id !== 'string') {
                continue;
            }
            if (t.fireAt > now) {
                const info: TimerInfo = {
                    id: t.id,
                    label: t.label || '',
                    room: t.room || '',
                    source: t.source || '',
                    createdAt: t.createdAt || now,
                    duration: t.duration || Math.round((t.fireAt - now) / 1000),
                    fireAt: t.fireAt,
                };
                this.timers.set(info.id, info);
                this.arm(info);
                restored++;
            } else {
                dropped++;
            }
        }
        this.emitChange();
        return { restored, dropped };
    }

    /**
     * Fire every timer whose `fireAt` has passed — public so tests can drive expiry with a mocked clock
     * (production fires each timer from its own `setTimeout`, so this is a no-op there).
     */
    tick(): void {
        const now = this.now();
        const due = this.list().filter(t => t.fireAt <= now);
        for (const t of due) {
            this.fire(t.id, false);
        }
        if (due.length) {
            this.emitChange();
        }
    }

    /** Clear all pending timeouts and drop the in-memory timers (no callbacks). Call on unload. */
    dispose(): void {
        for (const h of this.handles.values()) {
            clearTimeout(h);
        }
        this.handles.clear();
        this.timers.clear();
    }

    /** Fire one timer: remove it, then invoke `onFire`. `emit` controls whether to notify immediately. */
    private fire(id: string, emit: boolean): void {
        const info = this.timers.get(id);
        if (!info) {
            return;
        }
        this.clearHandle(id);
        this.timers.delete(id);
        try {
            this.opts.onFire(info);
        } catch (e) {
            this.opts.log?.warn(`timer onFire failed: ${(e as Error).message}`);
        }
        if (emit) {
            this.emitChange();
        }
    }

    /** Arm the `setTimeout` for a timer (chunked for delays beyond the setTimeout limit). */
    private arm(info: TimerInfo): void {
        if (this.opts.manualTick) {
            return;
        }
        this.clearHandle(info.id);
        const delay = Math.max(0, info.fireAt - this.now());
        const handle = setTimeout(
            () => {
                // Re-arm if this was only a chunk of a very long delay; otherwise fire.
                if (this.timers.has(info.id) && info.fireAt - this.now() > 0) {
                    this.arm(info);
                } else {
                    this.fire(info.id, true);
                }
            },
            Math.min(delay, MAX_TIMEOUT),
        );
        (handle as { unref?: () => void }).unref?.(); // don't keep the process alive for a timer
        this.handles.set(info.id, handle);
    }

    private clearHandle(id: string): void {
        const h = this.handles.get(id);
        if (h) {
            clearTimeout(h);
            this.handles.delete(id);
        }
    }

    private genId(now: number): string {
        return `t${now.toString(36)}${(this.seq++).toString(36)}`;
    }

    private emitChange(): void {
        try {
            this.opts.onChange(this.list());
        } catch (e) {
            this.opts.log?.warn(`timer onChange failed: ${(e as Error).message}`);
        }
    }
}

/** Simple Russian plural selector (1 → one, 2–4 → few, else many; with the 11–14 exception). */
function ruPlural(n: number, one: string, few: string, many: string): string {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) {
        return one;
    }
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) {
        return few;
    }
    return many;
}

/**
 * Human-readable, spoken-friendly duration ("1 Stunde 30 Minuten", "5 minutes", "2 минуты"). Seconds are
 * only shown when there is no hour part (so a 90-minute timer reads "1 Stunde 30 Minuten", not with a
 * dangling "0 Sekunden"). Falls back to English for languages other than de/en/ru.
 */
export function formatDuration(totalSec: number, lang: string): string {
    const l = lang === 'ru' ? 'ru' : lang === 'de' ? 'de' : 'en';
    let sec = Math.max(0, Math.round(totalSec));
    const h = Math.floor(sec / 3600);
    sec -= h * 3600;
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;

    const parts: string[] = [];
    const add = (n: number, ru: [string, string, string], de: [string, string], en: [string, string]): void => {
        if (l === 'ru') {
            parts.push(`${n} ${ruPlural(n, ru[0], ru[1], ru[2])}`);
        } else if (l === 'de') {
            parts.push(`${n} ${n === 1 ? de[0] : de[1]}`);
        } else {
            parts.push(`${n} ${n === 1 ? en[0] : en[1]}`);
        }
    };

    if (h) {
        add(h, ['час', 'часа', 'часов'], ['Stunde', 'Stunden'], ['hour', 'hours']);
    }
    if (m) {
        add(m, ['минута', 'минуты', 'минут'], ['Minute', 'Minuten'], ['minute', 'minutes']);
    }
    // Show seconds when there is no hour part, or when nothing else was added (e.g. a 10-second timer).
    if ((s && !h) || !parts.length) {
        add(s, ['секунда', 'секунды', 'секунд'], ['Sekunde', 'Sekunden'], ['second', 'seconds']);
    }
    return parts.join(' ');
}
