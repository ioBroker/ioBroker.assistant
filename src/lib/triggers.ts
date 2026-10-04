/**
 * Proactive triggers — the assistant speaking first instead of answering.
 *
 * A trigger watches ioBroker states and/or the clock and, when its condition holds, says something, writes
 * a state, or **asks a question and acts on the answer** ("The fryer has been on for 5 hours. Shall I
 * switch it off?" → `askUser` → classify the reply → switch it off). The question is what sets this apart
 * from a script or a scene: those can switch, but they cannot have a conversation about it.
 *
 * Semantics are ported from the Python original (`C:\iot\Hannah`, `core/hannah/trigger_engine.py`), whose
 * corner cases were earned the hard way and are kept deliberately:
 *   - a state trigger fires on the **transition into** the condition, never on a repeated identical value;
 *   - `also` with an unknown state blocks (we cannot confirm it), `unless` with an unknown state does not
 *     (we cannot confirm the block either, and a lock that fires by accident is worse than one that waits);
 *   - the cooldown is consumed when the trigger *starts*, so a delayed trigger cannot re-arm while waiting.
 *
 * Unlike the original there is **no poll loop**: like {@link AlarmManager}, every time trigger fires from
 * its own `setTimeout` at an absolute timestamp, so an idle system does no work at all. Execution itself is
 * the host's job ({@link TriggerEngineOptions.execute}) — this module owns only *whether* and *when*.
 */
import { computeNextFire } from './alarms';

/** Values a condition can compare against — what an ioBroker state can hold. */
export type TriggerValue = string | number | boolean | null;

/** Explicitly combined group of conditions (a plain list is AND). */
export interface TriggerConditionGroup {
    op: 'and' | 'or';
    conditions: TriggerCondition[];
}

/**
 * One condition. Either state-based (`state` plus an optional `value`/`above`/`below` filter — without a
 * filter any change matches) or time-based (`time` plus optional `days`).
 */
export interface TriggerCondition {
    /** State id to watch (state condition). */
    state?: string;
    /** Exact value to match. */
    value?: TriggerValue;
    /** Numeric threshold: value must be greater. */
    above?: number;
    /** Numeric threshold: value must be smaller. */
    below?: number;
    /** Wall-clock time `HH:MM` (time condition). */
    time?: string;
    /** Weekdays the time condition fires on (0 = Sunday … 6 = Saturday). Empty = every day. */
    days?: number[];
    /** Must hold as well. A list is AND; `{op:'or'}` makes it OR. Unknown state → does not hold. */
    also?: TriggerCondition | TriggerCondition[] | TriggerConditionGroup;
    /** Must NOT hold (a lock). A list is AND. Unknown state → does not block. */
    unless?: TriggerCondition | TriggerCondition[];
}

/** What a trigger does when it fires. */
export interface TriggerAction {
    /** Announcement text. */
    say?: string;
    /** Where to say it: a satellite state id / room, empty = all satellites. */
    room?: string;
    /** State to write. */
    setState?: { id: string; value: TriggerValue };
}

/** One rule for the answer to a trigger's question; the first matching rule wins. */
export interface TriggerResponseRule {
    /** Category the answer must express ("agreement", "Zustimmung", …). Empty = fallback rule. */
    match?: string;
    say?: string;
    setState?: { id: string; value: TriggerValue };
}

/** A trigger definition — plain data, so it round-trips through the config and JSON states. */
export interface TriggerDef {
    /** Unique id; also the `triggers.items.<id>` state-object segment. */
    id: string;
    /** Optional human name for logs and the states. */
    name?: string;
    /** Default enabled flag (the live one can be overridden through the state). */
    enabled?: boolean;
    /** Condition, or a list of alternatives (OR — any one is enough). */
    when: TriggerCondition | TriggerCondition[];
    /** Wait this long after the condition held before acting ("5h", "30m", "90s", or seconds). */
    delay?: string | number;
    /** Abort the pending delay when this holds. */
    cancelWhen?: TriggerCondition | TriggerCondition[];
    /** Minimum gap between two firings in seconds (default 3600; 0 = no cooldown). */
    cooldownSec?: number;
    /** Shorthand for a single `say` action. */
    say?: string;
    /** Target room/satellite for `say` and for the question. */
    room?: string;
    /** Ask this instead of announcing, and evaluate the answer against {@link onResponse}. */
    ask?: string;
    /** Rules for the answer to `ask`. */
    onResponse?: TriggerResponseRule[];
    /** Actions to run; replaces `say` when non-empty. */
    actions?: TriggerAction[];
    /** Have the LLM reword the text before it is spoken, so it doesn't sound canned. */
    rephrase?: boolean;
}

/** Live status of one trigger, mirrored into the states. */
export interface TriggerStatus {
    id: string;
    name: string;
    enabled: boolean;
    /** Epoch ms of the last firing (0 = never since start). */
    lastFired: number;
    /** Epoch ms of the next scheduled firing (time triggers only, 0 otherwise). */
    nextFireAt: number;
    /** Epoch ms at which a pending delay will run (0 = nothing pending). */
    pendingUntil: number;
}

export interface TriggerEngineOptions {
    /** Read a state the conditions reference. `undefined`/`null` = unknown (see the `also`/`unless` rules). */
    getState: (id: string) => Promise<TriggerValue | undefined>;
    /** Run a trigger: announce, write states, or ask and evaluate the answer. */
    execute: (trigger: TriggerDef) => void | Promise<void>;
    /** Called whenever the live status changes, for the state mirror. */
    onChange?: (status: TriggerStatus[]) => void;
    log?: Pick<ioBroker.Log, 'debug' | 'info' | 'warn' | 'error'>;
    /** Injectable clock (tests). Defaults to `Date.now`. */
    now?: () => number;
    /** Don't arm real timers — the caller drives {@link TriggerEngine.tick} (tests). */
    manualTick?: boolean;
}

/** Default minimum gap between two firings of the same trigger. */
export const DEFAULT_COOLDOWN_SEC = 3600;

/** Largest delay `setTimeout` accepts (~24.8 days); a longer wait is re-armed in chunks. */
const MAX_TIMEOUT = 2 ** 31 - 1;

/** Normalise a condition field that may hold one condition or several. */
function asList(c: TriggerCondition | TriggerCondition[] | undefined): TriggerCondition[] {
    if (!c) {
        return [];
    }
    return Array.isArray(c) ? c.filter(Boolean) : [c];
}

/** True when the value is a condition group (`{op, conditions}`) rather than a plain condition. */
function isGroup(c: TriggerCondition | TriggerConditionGroup): c is TriggerConditionGroup {
    return Array.isArray((c as TriggerConditionGroup).conditions);
}

/**
 * Parse a delay: `"5h"`, `"30m"`, `"90s"`, `"2d"`, or a plain number of seconds. Returns 0 when there is
 * nothing to wait for and -1 when the text makes no sense (so the caller can complain instead of firing).
 */
export function parseDelay(delay: string | number | undefined): number {
    if (delay === undefined || delay === null || delay === '') {
        return 0;
    }
    if (typeof delay === 'number') {
        return Number.isFinite(delay) && delay > 0 ? Math.round(delay) : 0;
    }
    const m = /^\s*(\d+(?:[.,]\d+)?)\s*([smhd]?)\s*$/i.exec(delay);
    if (!m) {
        return -1;
    }
    const n = parseFloat(m[1].replace(',', '.'));
    const unit = (m[2] || 's').toLowerCase();
    const factor = unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
    return Math.round(n * factor);
}

/** `HH:MM` → `{hour, minute}`, or null if it isn't a time. */
export function parseTimeOfDay(time: string | undefined): { hour: number; minute: number } | null {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(time || '');
    if (!m) {
        return null;
    }
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/** The actions a trigger runs: its own list, or the `say`/`room` shorthand folded into one. */
export function effectiveActions(def: TriggerDef): TriggerAction[] {
    const list = (def.actions || []).filter(a => a && (a.say || a.setState));
    if (list.length) {
        return list.map(a => ({ ...a, room: a.room ?? def.room }));
    }
    return def.say ? [{ say: def.say, room: def.room }] : [];
}

/** Every state id a trigger references, across `when`, `also`, `unless` and `cancelWhen`. */
export function referencedStates(def: TriggerDef): string[] {
    const ids = new Set<string>();
    const walk = (c: TriggerCondition | TriggerConditionGroup | TriggerCondition[] | undefined): void => {
        if (!c) {
            return;
        }
        if (Array.isArray(c)) {
            c.forEach(walk);
            return;
        }
        if (isGroup(c)) {
            c.conditions?.forEach(walk);
            return;
        }
        if (c.state) {
            ids.add(c.state);
        }
        walk(c.also);
        walk(c.unless);
    };
    walk(asList(def.when));
    walk(asList(def.cancelWhen));
    return [...ids];
}

/**
 * Does `value` satisfy the condition's value filter? `value` wins over `above`/`below`; without any filter
 * every value matches (the caller has already established that it *changed*).
 */
export function valueMatches(cond: TriggerCondition, value: TriggerValue | undefined): boolean {
    if (value === undefined) {
        return false;
    }
    if (cond.value !== undefined) {
        // Compare loosely on purpose: a state can hold 'true'/1 where the config says true.
        return normalize(value) === normalize(cond.value);
    }
    if (cond.above !== undefined) {
        const n = Number(value);
        return Number.isFinite(n) && n > Number(cond.above);
    }
    if (cond.below !== undefined) {
        const n = Number(value);
        return Number.isFinite(n) && n < Number(cond.below);
    }
    return true;
}

/** Fold a value to a comparable primitive: booleans and numeric strings compare across types. */
function normalize(v: TriggerValue): string | number | boolean | null {
    if (typeof v === 'string') {
        const s = v.trim();
        if (/^(true|false)$/i.test(s)) {
            return s.toLowerCase() === 'true';
        }
        if (s !== '' && Number.isFinite(Number(s))) {
            return Number(s);
        }
        return s;
    }
    return v;
}

interface RuntimeTrigger {
    def: TriggerDef;
    enabled: boolean;
    lastFired: number;
    nextFireAt: number;
    /** The time condition `nextFireAt` came from, so its `also`/`unless` can be checked when it fires. */
    nextCond: TriggerCondition | null;
}

/** Trigger scheduler/evaluator. Owns *whether* and *when*; the host owns *what happens*. */
export class TriggerEngine {
    private readonly triggers = new Map<string, RuntimeTrigger>();
    /** Last seen value per state, for transition detection. */
    private readonly prev = new Map<string, TriggerValue>();
    private readonly timeHandles = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly delays = new Map<string, { handle: ReturnType<typeof setTimeout> | null; until: number }>();
    private readonly now: () => number;

    constructor(private readonly opts: TriggerEngineOptions) {
        this.now = opts.now || Date.now;
    }

    /**
     * Replace the trigger set (on start and whenever the configuration changes). Runtime state of a
     * trigger that is still there survives — its cooldown and its live enabled flag — because a config
     * reload must not turn into a free pass to fire again immediately.
     */
    load(defs: TriggerDef[]): void {
        const keep = new Map(this.triggers);
        for (const id of this.triggers.keys()) {
            this.clearTime(id);
        }
        this.triggers.clear();
        for (const def of defs || []) {
            const problem = validate(def);
            if (problem) {
                this.opts.log?.warn(`trigger ${def?.id ? `'${def.id}'` : '(no id)'} ignored: ${problem}`);
                continue;
            }
            if (this.triggers.has(def.id)) {
                this.opts.log?.warn(`trigger '${def.id}' ignored: duplicate id`);
                continue;
            }
            const before = keep.get(def.id);
            this.triggers.set(def.id, {
                def,
                enabled: before ? before.enabled : def.enabled !== false,
                lastFired: before?.lastFired || 0,
                nextFireAt: 0,
                nextCond: null,
            });
        }
        // Drop pending delays of triggers that no longer exist.
        for (const id of [...this.delays.keys()]) {
            if (!this.triggers.has(id)) {
                this.clearDelay(id);
            }
        }
        for (const t of this.triggers.values()) {
            this.armTime(t);
        }
        this.opts.log?.debug(`triggers loaded: ${this.triggers.size}`);
        this.emitChange();
    }

    /** Restore live enabled flags (and last-fired times) persisted across a restart. */
    restore(status: Pick<TriggerStatus, 'id' | 'enabled' | 'lastFired'>[]): void {
        for (const s of status || []) {
            const t = this.triggers.get(s?.id);
            if (!t) {
                continue;
            }
            t.lastFired = Number(s.lastFired) || 0;
            if (s.enabled === false) {
                t.enabled = false;
                this.clearTime(s.id);
                t.nextFireAt = 0;
                t.nextCond = null;
            }
        }
        this.emitChange();
    }

    /**
     * Read every watched state once and remember its value, so the **first** report after a restart is not
     * mistaken for a transition. Without this, a device that re-sends its unchanged value periodically
     * would fire its trigger shortly after every adapter start. A state that cannot be read stays unknown,
     * so its first real value still counts.
     */
    async prime(): Promise<void> {
        for (const id of this.stateIds()) {
            await this.read(id);
        }
    }

    /** All state ids the current triggers reference — exactly what the host has to subscribe to. */
    stateIds(): string[] {
        const ids = new Set<string>();
        for (const t of this.triggers.values()) {
            referencedStates(t.def).forEach(id => ids.add(id));
        }
        return [...ids];
    }

    list(): TriggerStatus[] {
        return [...this.triggers.values()]
            .map(t => ({
                id: t.def.id,
                name: t.def.name || '',
                enabled: t.enabled,
                lastFired: t.lastFired,
                nextFireAt: t.nextFireAt,
                pendingUntil: this.delays.get(t.def.id)?.until || 0,
            }))
            .sort((a, b) => a.id.localeCompare(b.id));
    }

    get(id: string): TriggerDef | undefined {
        return this.triggers.get(id)?.def;
    }

    /** Enable/disable a trigger at runtime (keeps it loaded). Returns true if it existed. */
    setEnabled(id: string, enabled: boolean): boolean {
        const t = this.triggers.get(id);
        if (!t) {
            return false;
        }
        t.enabled = enabled;
        if (enabled) {
            this.armTime(t);
        } else {
            this.clearTime(id);
            this.clearDelay(id);
            t.nextFireAt = 0;
            t.nextCond = null;
        }
        this.emitChange();
        return true;
    }

    /**
     * Feed a state change in. Checks `cancelWhen` first (a pending delay may have to be aborted) and then
     * every `when` alternative that watches this state. Values identical to the last one are ignored — a
     * trigger reacts to a transition, not to a device repeating itself.
     */
    async onStateChange(id: string, value: TriggerValue): Promise<void> {
        const prev = this.prev.get(id);
        const known = this.prev.has(id);
        this.prev.set(id, value);
        if (known && normalize(prev as TriggerValue) === normalize(value)) {
            return;
        }
        for (const t of [...this.triggers.values()]) {
            if (!t.enabled) {
                continue;
            }
            for (const cond of asList(t.def.cancelWhen)) {
                if (cond.state === id && valueMatches(cond, value) && this.clearDelay(t.def.id)) {
                    this.opts.log?.info(`trigger '${t.def.id}': pending delay cancelled (cancelWhen matched)`);
                    this.emitChange();
                }
            }
            for (const cond of asList(t.def.when)) {
                if (cond.state !== id || !valueMatches(cond, value)) {
                    continue;
                }
                if (!(await this.extraConditionsHold(cond, t.def.id))) {
                    break;
                }
                await this.start(t, 'state');
                break;
            }
        }
    }

    /**
     * Fire a trigger by hand (the `fire` button / sendTo). Skips the cooldown and the delay: someone asked
     * for it to happen now. Returns false if the id is unknown.
     */
    async fireNow(id: string): Promise<boolean> {
        const t = this.triggers.get(id);
        if (!t) {
            return false;
        }
        t.lastFired = this.now();
        this.emitChange();
        await this.run(t, 'manual');
        return true;
    }

    /**
     * Fire every time trigger that is due — public so tests can drive it with a mocked clock; in
     * production each trigger fires from its own `setTimeout`, so this does nothing there.
     */
    async tick(): Promise<void> {
        const now = this.now();
        for (const t of [...this.triggers.values()]) {
            if (t.enabled && t.nextFireAt && t.nextFireAt <= now) {
                await this.fireTime(t);
            }
        }
        for (const [id, delay] of [...this.delays.entries()]) {
            if (delay.until && delay.until <= now) {
                const t = this.triggers.get(id);
                this.clearDelay(id);
                if (t) {
                    await this.run(t, 'delay');
                }
            }
        }
    }

    /** Clear all timers and drop everything (no callbacks). Call on unload. */
    dispose(): void {
        for (const id of [...this.triggers.keys()]) {
            this.clearTime(id);
        }
        for (const id of [...this.delays.keys()]) {
            this.clearDelay(id);
        }
        this.triggers.clear();
        this.prev.clear();
    }

    /** `also` holds and `unless` does not — the half of a condition that needs other states. */
    private async extraConditionsHold(cond: TriggerCondition, id: string): Promise<boolean> {
        if (!(await this.alsoHolds(cond.also))) {
            this.opts.log?.debug(`trigger '${id}': 'also' condition not met`);
            return false;
        }
        if (await this.unlessBlocks(cond.unless)) {
            this.opts.log?.debug(`trigger '${id}': blocked by 'unless'`);
            return false;
        }
        return true;
    }

    private async alsoHolds(also: TriggerCondition['also']): Promise<boolean> {
        if (!also) {
            return true;
        }
        if (Array.isArray(also)) {
            for (const c of also) {
                if (!(await this.alsoHolds(c))) {
                    return false;
                }
            }
            return true;
        }
        if (isGroup(also)) {
            const list = also.conditions || [];
            if (also.op === 'or') {
                for (const c of list) {
                    if (await this.alsoHolds(c)) {
                        return true;
                    }
                }
                return false;
            }
            for (const c of list) {
                if (!(await this.alsoHolds(c))) {
                    return false;
                }
            }
            return true;
        }
        if (!also.state) {
            return true;
        }
        // Unknown state blocks: we must not claim a condition holds when we cannot read it.
        return valueMatches(also, await this.read(also.state));
    }

    private async unlessBlocks(unless: TriggerCondition['unless']): Promise<boolean> {
        for (const c of asList(unless)) {
            if (!c.state) {
                continue;
            }
            const value = await this.read(c.state);
            // Unknown state does NOT block — see the module header.
            if (value !== undefined && valueMatches(c, value)) {
                return true;
            }
        }
        return false;
    }

    private async read(id: string): Promise<TriggerValue | undefined> {
        try {
            const value = await this.opts.getState(id);
            if (value !== undefined && value !== null) {
                this.prev.set(id, value);
            }
            return value === null ? undefined : value;
        } catch (e) {
            this.opts.log?.debug(`trigger: cannot read '${id}': ${(e as Error).message}`);
            return undefined;
        }
    }

    /**
     * A condition held: take the cooldown, then either run now or start the delay. The cooldown is taken
     * here rather than at execution time so a condition flapping during a long delay cannot queue up.
     */
    private async start(t: RuntimeTrigger, origin: string): Promise<void> {
        const now = this.now();
        const cooldown = (t.def.cooldownSec ?? DEFAULT_COOLDOWN_SEC) * 1000;
        if (cooldown > 0 && t.lastFired && now - t.lastFired < cooldown) {
            const left = Math.round((cooldown - (now - t.lastFired)) / 1000);
            this.opts.log?.debug(`trigger '${t.def.id}' in cooldown (${left}s left) — skipped`);
            return;
        }
        t.lastFired = now;
        const delaySec = parseDelay(t.def.delay);
        if (delaySec < 0) {
            this.opts.log?.warn(`trigger '${t.def.id}': invalid delay '${String(t.def.delay)}' — firing now`);
        }
        if (delaySec > 0) {
            if (this.delays.has(t.def.id)) {
                this.opts.log?.debug(`trigger '${t.def.id}': delay already running — skipped`);
                return;
            }
            const until = now + delaySec * 1000;
            this.opts.log?.info(`trigger '${t.def.id}' armed by ${origin}: waiting ${delaySec}s`);
            const handle = this.opts.manualTick
                ? null
                : setTimeout(
                      () => {
                          this.clearDelay(t.def.id);
                          void this.run(t, 'delay');
                      },
                      Math.min(delaySec * 1000, MAX_TIMEOUT),
                  );
            (handle as { unref?: () => void } | null)?.unref?.();
            this.delays.set(t.def.id, { handle, until });
            this.emitChange();
            return;
        }
        this.emitChange();
        await this.run(t, origin);
    }

    /** Hand a trigger to the host and keep going if it throws — one bad trigger must not stop the rest. */
    private async run(t: RuntimeTrigger, origin: string): Promise<void> {
        this.opts.log?.info(`trigger '${t.def.id}' fired (${origin})`);
        try {
            await this.opts.execute(t.def);
        } catch (e) {
            this.opts.log?.error(`trigger '${t.def.id}' failed: ${(e as Error).message}`);
        }
        this.emitChange();
    }

    /** A time trigger came due: re-check its extra conditions, fire, and schedule the next occurrence. */
    private async fireTime(t: RuntimeTrigger): Promise<void> {
        const cond = t.nextCond;
        this.clearTime(t.def.id);
        t.nextFireAt = 0;
        t.nextCond = null;
        const allowed = !cond || (await this.extraConditionsHold(cond, t.def.id));
        this.armTime(t); // re-arm first: an execution error must not stop tomorrow's run
        if (allowed) {
            await this.start(t, 'time');
        }
    }

    /** Schedule the earliest upcoming time condition of a trigger (no-op if it has none). */
    private armTime(t: RuntimeTrigger): void {
        this.clearTime(t.def.id);
        t.nextFireAt = 0;
        t.nextCond = null;
        if (!t.enabled) {
            return;
        }
        const now = this.now();
        for (const cond of asList(t.def.when)) {
            const clock = parseTimeOfDay(cond.time);
            if (!clock) {
                continue;
            }
            const days = (cond.days || []).filter(d => d >= 0 && d <= 6);
            const at = computeNextFire(clock.hour, clock.minute, days, now);
            if (at && (!t.nextFireAt || at < t.nextFireAt)) {
                t.nextFireAt = at;
                t.nextCond = cond;
            }
        }
        if (!t.nextFireAt || this.opts.manualTick) {
            return;
        }
        const handle = setTimeout(
            () => {
                const current = this.triggers.get(t.def.id);
                if (!current) {
                    return;
                }
                if (current.nextFireAt - this.now() > 0) {
                    this.armTime(current); // was only a chunk of a long wait
                } else {
                    void this.fireTime(current);
                }
            },
            Math.min(Math.max(0, t.nextFireAt - now), MAX_TIMEOUT),
        );
        (handle as { unref?: () => void }).unref?.();
        this.timeHandles.set(t.def.id, handle);
    }

    private clearTime(id: string): void {
        const h = this.timeHandles.get(id);
        if (h) {
            clearTimeout(h);
            this.timeHandles.delete(id);
        }
    }

    private clearDelay(id: string): boolean {
        const d = this.delays.get(id);
        if (!d) {
            return false;
        }
        if (d.handle) {
            clearTimeout(d.handle);
        }
        this.delays.delete(id);
        return true;
    }

    private emitChange(): void {
        try {
            this.opts.onChange?.(this.list());
        } catch (e) {
            this.opts.log?.warn(`trigger onChange failed: ${(e as Error).message}`);
        }
    }
}

/** One row of the settings table: the structured fields may arrive as JSON text. */
export type TriggerRow = Omit<TriggerDef, 'when' | 'onResponse' | 'actions'> & {
    when?: TriggerDef['when'] | string;
    onResponse?: TriggerDef['onResponse'] | string;
    actions?: TriggerDef['actions'] | string;
};

/**
 * Turn settings-table rows into definitions: the JSON-typed columns are parsed here so a typo surfaces as
 * one clear warning per field instead of breaking the trigger later, and empty cells fall back to the
 * defaults rather than to zero. A row written by a script may pass the structured form straight through.
 */
export function parseTriggerRows(
    rows: TriggerRow[] | undefined,
    opts: { rephraseDefault?: boolean; warn?: (message: string) => void } = {},
): TriggerDef[] {
    const out: TriggerDef[] = [];
    for (const row of rows || []) {
        const id = String(row?.id ?? '').trim();
        if (!id) {
            continue; // an empty row in the table is not an error, it is just empty
        }
        const parse = (field: string, raw: unknown): unknown => {
            if (raw === undefined || raw === null || raw === '') {
                return undefined;
            }
            if (typeof raw !== 'string') {
                return raw;
            }
            try {
                return JSON.parse(raw);
            } catch (e) {
                opts.warn?.(`trigger '${id}': ${field} is not valid JSON (${(e as Error).message}) — ignored`);
                return undefined;
            }
        };
        const cooldown = Number(row.cooldownSec);
        out.push({
            id,
            name: String(row.name ?? '').trim(),
            enabled: row.enabled,
            when: parse('when', row.when) as TriggerDef['when'],
            room: String(row.room ?? '').trim(),
            say: String(row.say ?? '').trim(),
            ask: String(row.ask ?? '').trim(),
            onResponse: parse('onResponse', row.onResponse) as TriggerDef['onResponse'],
            actions: parse('actions', row.actions) as TriggerDef['actions'],
            delay: row.delay,
            cooldownSec:
                row.cooldownSec === undefined ||
                row.cooldownSec === null ||
                (row.cooldownSec as unknown) === '' ||
                !Number.isFinite(cooldown)
                    ? undefined
                    : cooldown,
            rephrase: row.rephrase ?? opts.rephraseDefault === true,
        });
    }
    return out;
}

/** Why a definition cannot be used, or '' when it is fine. */
export function validate(def: TriggerDef | undefined): string {
    if (!def || typeof def !== 'object') {
        return 'not an object';
    }
    if (!def.id || typeof def.id !== 'string') {
        return 'missing id';
    }
    const when = asList(def.when);
    if (!when.length) {
        return 'missing "when" condition';
    }
    for (const cond of when) {
        if (cond.time !== undefined && !parseTimeOfDay(cond.time)) {
            return `invalid time '${String(cond.time)}' (expected HH:MM)`;
        }
        if (!cond.state && cond.time === undefined) {
            return 'a "when" condition needs either a state or a time';
        }
    }
    if (parseDelay(def.delay) < 0) {
        return `invalid delay '${String(def.delay)}' (expected 90s, 30m, 5h, 2d or seconds)`;
    }
    if (!def.ask && !effectiveActions(def).length) {
        return 'nothing to do (no say, actions or ask)';
    }
    if (def.ask && !(def.onResponse || []).length) {
        return 'an "ask" trigger needs onResponse rules';
    }
    return '';
}
