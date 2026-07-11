/**
 * Alarms — reminders at a fixed wall-clock time ("weck mich um 7 Uhr"), optionally recurring on chosen
 * weekdays. Sibling of {@link TimerManager} (countdown timers): same ioBroker-first philosophy, but the
 * fire time is an absolute clock time instead of a relative duration, and an alarm can repeat.
 *
 * Like the timer engine this never writes any state on a periodic schedule: each alarm fires from its own
 * `setTimeout` at `nextFireAt`, and the states carry only that absolute timestamp — a vis/script derives
 * the countdown itself. One-shot alarms (no weekdays) are removed after firing; recurring ones are
 * rescheduled to their next matching weekday.
 */

/** One alarm. Plain data so it round-trips through JSON for persistence. */
export interface AlarmInfo {
    /** Short unique id (also the `alarms.items.<id>` state-object segment). */
    id: string;
    label: string;
    room: string;
    /** Origin of the request (satellite device name / 'chat' / '') — used to target the announcement. */
    source: string;
    /** Hour 0–23. */
    hour: number;
    /** Minute 0–59. */
    minute: number;
    /** Weekdays it repeats on (0 = Sunday … 6 = Saturday). Empty = one-shot at the next occurrence. */
    weekdays: number[];
    /** When disabled, the alarm is kept but does not fire (nextFireAt = 0). */
    enabled: boolean;
    createdAt: number;
    /** Epoch ms of the next fire (0 when disabled / none). */
    nextFireAt: number;
}

export interface AddAlarmOptions {
    label?: string;
    room?: string;
    source?: string;
    hour: number;
    minute: number;
    weekdays?: number[];
}

export interface AlarmManagerOptions {
    /** Called when an alarm fires (with a snapshot; recurring alarms stay active, one-shots are removed). */
    onFire: (alarm: AlarmInfo) => void;
    /** Called whenever the list changes (add/cancel/enable/fire/restore) with the new sorted list. */
    onChange: (alarms: AlarmInfo[]) => void;
    log?: Pick<ioBroker.Log, 'debug' | 'info' | 'warn'>;
    /** Injectable clock (tests). Defaults to `Date.now`. */
    now?: () => number;
    /** Don't arm real `setTimeout`s — the caller drives {@link AlarmManager.tick} (tests). */
    manualTick?: boolean;
}

/** Largest delay `setTimeout` accepts (~24.8 days); a farther alarm is re-armed in chunks. */
const MAX_TIMEOUT = 2 ** 31 - 1;

/**
 * Compute the next epoch-ms an alarm at `hour:minute` fires strictly after `fromMs`, honouring `weekdays`
 * (empty = any day). Uses the host's local time. Returns 0 if nothing matches within a week (never happens
 * for valid input).
 */
export function computeNextFire(hour: number, minute: number, weekdays: number[], fromMs: number): number {
    const base = new Date(fromMs);
    for (let addDays = 0; addDays <= 7; addDays++) {
        const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + addDays, hour, minute, 0, 0);
        if (d.getTime() <= fromMs) {
            continue; // must be strictly in the future
        }
        if (weekdays.length && !weekdays.includes(d.getDay())) {
            continue;
        }
        return d.getTime();
    }
    return 0;
}

/** In-memory alarm scheduler; each alarm fires from its own `setTimeout` (no polling, no periodic writes). */
export class AlarmManager {
    private readonly alarms = new Map<string, AlarmInfo>();
    private readonly handles = new Map<string, ReturnType<typeof setTimeout>>();
    private seq = 0;
    private readonly now: () => number;

    constructor(private readonly opts: AlarmManagerOptions) {
        this.now = opts.now || Date.now;
    }

    /** Add an alarm, schedule it and notify. Returns the created {@link AlarmInfo}. */
    add(o: AddAlarmOptions): AlarmInfo {
        const now = this.now();
        const weekdays = [...new Set((o.weekdays || []).filter(d => d >= 0 && d <= 6))].sort();
        const hour = Math.max(0, Math.min(23, Math.round(o.hour)));
        const minute = Math.max(0, Math.min(59, Math.round(o.minute)));
        const info: AlarmInfo = {
            id: this.genId(now),
            label: (o.label || '').trim(),
            room: (o.room || '').trim(),
            source: o.source || '',
            hour,
            minute,
            weekdays,
            enabled: true,
            createdAt: now,
            nextFireAt: computeNextFire(hour, minute, weekdays, now),
        };
        this.alarms.set(info.id, info);
        this.opts.log?.debug(
            `alarm added: ${info.id} "${info.label}" at ${hour}:${String(minute).padStart(2, '0')} [${weekdays.join(',') || 'once'}]`,
        );
        this.arm(info);
        this.emitChange();
        return info;
    }

    /** Enable/disable an alarm without deleting it. Returns true if it existed. */
    setEnabled(id: string, enabled: boolean): boolean {
        const a = this.alarms.get(id);
        if (!a) {
            return false;
        }
        a.enabled = enabled;
        this.clearHandle(id);
        if (enabled) {
            a.nextFireAt = computeNextFire(a.hour, a.minute, a.weekdays, this.now());
            this.arm(a);
        } else {
            a.nextFireAt = 0;
        }
        this.emitChange();
        return true;
    }

    /** Cancel/delete one alarm by id. Returns true if it existed. */
    cancel(id: string): boolean {
        this.clearHandle(id);
        if (!this.alarms.delete(id)) {
            return false;
        }
        this.emitChange();
        return true;
    }

    /** Cancel all alarms (optionally only those in a room). Returns the number cancelled. */
    cancelAll(room?: string): number {
        const victims = this.list().filter(a => !room || a.room === room);
        for (const a of victims) {
            this.clearHandle(a.id);
            this.alarms.delete(a.id);
        }
        if (victims.length) {
            this.emitChange();
        }
        return victims.length;
    }

    /** The alarms, soonest-to-fire first (disabled ones — nextFireAt 0 — sort last). */
    list(): AlarmInfo[] {
        return [...this.alarms.values()].sort((a, b) => {
            const an = a.nextFireAt || Infinity;
            const bn = b.nextFireAt || Infinity;
            return an - bn;
        });
    }

    get(id: string): AlarmInfo | undefined {
        return this.alarms.get(id);
    }

    /**
     * Restore persisted alarms after a restart. Disabled alarms are kept as-is; enabled ones recompute
     * their next fire from now. A one-shot whose time passed while the adapter was down is dropped.
     * Returns how many were restored / dropped.
     */
    restore(list: AlarmInfo[]): { restored: number; dropped: number } {
        const now = this.now();
        let restored = 0;
        let dropped = 0;
        for (const a of list) {
            if (!a || typeof a.id !== 'string' || typeof a.hour !== 'number' || typeof a.minute !== 'number') {
                continue;
            }
            const weekdays = Array.isArray(a.weekdays) ? a.weekdays : [];
            const info: AlarmInfo = {
                id: a.id,
                label: a.label || '',
                room: a.room || '',
                source: a.source || '',
                hour: a.hour,
                minute: a.minute,
                weekdays,
                enabled: a.enabled !== false,
                createdAt: a.createdAt || now,
                nextFireAt: 0,
            };
            if (!info.enabled) {
                this.alarms.set(info.id, info); // keep, but don't arm
                restored++;
                continue;
            }
            if (!weekdays.length && typeof a.nextFireAt === 'number' && a.nextFireAt <= now) {
                dropped++; // a one-shot we missed during downtime
                continue;
            }
            info.nextFireAt = computeNextFire(info.hour, info.minute, weekdays, now);
            this.alarms.set(info.id, info);
            this.arm(info);
            restored++;
        }
        this.emitChange();
        return { restored, dropped };
    }

    /**
     * Fire every enabled alarm whose `nextFireAt` has passed — public so tests can drive it with a mocked
     * clock (production fires each alarm from its own `setTimeout`, so this is a no-op there).
     */
    tick(): void {
        const now = this.now();
        const due = this.list().filter(a => a.enabled && a.nextFireAt && a.nextFireAt <= now);
        for (const a of due) {
            this.fire(a.id, false);
        }
        if (due.length) {
            this.emitChange();
        }
    }

    /** Clear all pending timeouts and drop the in-memory alarms (no callbacks). Call on unload. */
    dispose(): void {
        for (const h of this.handles.values()) {
            clearTimeout(h);
        }
        this.handles.clear();
        this.alarms.clear();
    }

    /** Fire one alarm: one-shots are removed, recurring ones are rescheduled to their next weekday. */
    private fire(id: string, emit: boolean): void {
        const a = this.alarms.get(id);
        if (!a) {
            return;
        }
        this.clearHandle(id);
        const snapshot: AlarmInfo = { ...a, weekdays: [...a.weekdays] };
        if (a.weekdays.length) {
            // Recompute from just after this fire so we don't immediately re-fire the same minute.
            a.nextFireAt = computeNextFire(a.hour, a.minute, a.weekdays, this.now() + 1000);
            this.arm(a);
        } else {
            this.alarms.delete(id);
        }
        try {
            this.opts.onFire(snapshot);
        } catch (e) {
            this.opts.log?.warn(`alarm onFire failed: ${(e as Error).message}`);
        }
        if (emit) {
            this.emitChange();
        }
    }

    /** Arm the `setTimeout` for an alarm (chunked for fire times beyond the setTimeout limit). */
    private arm(info: AlarmInfo): void {
        if (this.opts.manualTick || !info.enabled || !info.nextFireAt) {
            return;
        }
        this.clearHandle(info.id);
        const delay = Math.max(0, info.nextFireAt - this.now());
        const handle = setTimeout(
            () => {
                const a = this.alarms.get(info.id);
                if (a && a.nextFireAt - this.now() > 0) {
                    this.arm(a); // was only a chunk of a long wait
                } else {
                    this.fire(info.id, true);
                }
            },
            Math.min(delay, MAX_TIMEOUT),
        );
        (handle as { unref?: () => void }).unref?.();
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
        return `a${now.toString(36)}${(this.seq++).toString(36)}`;
    }

    private emitChange(): void {
        try {
            this.opts.onChange(this.list());
        } catch (e) {
            this.opts.log?.warn(`alarm onChange failed: ${(e as Error).message}`);
        }
    }
}

/** Weekday names → short localized labels for the spoken reply / states (0 = Sunday). */
const WEEKDAY_NAMES: Record<'de' | 'en' | 'ru', string[]> = {
    de: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
    en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    ru: ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'],
};

/** "07:30" from hour/minute. */
export function formatClock(hour: number, minute: number): string {
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Human, spoken-friendly recurrence text: "" (once), "täglich", "wochentags", or a weekday list. */
export function formatWeekdays(weekdays: number[], lang: string): string {
    const l = lang === 'ru' ? 'ru' : lang === 'de' ? 'de' : 'en';
    const days = [...new Set(weekdays)].sort();
    if (!days.length) {
        return '';
    }
    if (days.length === 7) {
        return l === 'ru' ? 'ежедневно' : l === 'de' ? 'täglich' : 'daily';
    }
    if (days.length === 5 && [1, 2, 3, 4, 5].every(d => days.includes(d))) {
        return l === 'ru' ? 'по будням' : l === 'de' ? 'wochentags' : 'on weekdays';
    }
    if (days.length === 2 && days.includes(0) && days.includes(6)) {
        return l === 'ru' ? 'по выходным' : l === 'de' ? 'am Wochenende' : 'on weekends';
    }
    return days.map(d => WEEKDAY_NAMES[l][d]).join(', ');
}
