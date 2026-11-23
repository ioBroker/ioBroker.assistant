/**
 * The shared commands of other adapters (`HELP.md` of this repository). Every instance with
 * `common.supportedMessages.help` answers the message `help` with `{help, commands: [{command, write, standard?}]}`;
 * a command that follows the catalog carries `standard: "<family>.<command>"` (e.g. `camera.snapshot`). The registry
 * asks all running instances and keeps `standard → [instances]`, so "zeige …", "ruf … an" or "spiel … auf …" work with
 * every adapter of a kind instead of one parser per adapter.
 */

/** One command of another instance that follows the catalog. */
export interface StandardCommand {
    /** `frigate.0` */
    instance: string;
    /** `frigate` */
    adapter: string;
    /** The name to send: the standard name itself or the adapter's own (`getSnapshot` for `camera.snapshot`) */
    command: string;
    /** `camera.snapshot` */
    standard: string;
    /** It changes something (the adapter's own `write` flag) */
    write: boolean;
}

/** `family.command`: a lower-case family and a camelCase command. */
export const STANDARD_RE = /^[a-z][a-z0-9]*\.[a-z][A-Za-z0-9]*$/;

/** How long the commands of an instance are trusted before `help` is asked again. */
export const REGISTRY_TTL_MS = 10 * 60_000;
/** The time an instance gets to answer `help`. */
export const HELP_TIMEOUT_MS = 5_000;
/** At most this many `help` messages at the same time (a Raspberry Pi with 40 adapters). */
const CONCURRENCY = 4;

/**
 * The catalog commands of one `help` answer. Commands without `standard`, with a malformed one or without a name are
 * left out; `standard` may also be a list, for a command that serves two families (`send` = `message.send` and
 * `speech.speak` of a messenger with voice).
 *
 * @param instance the instance that answered, e.g. `frigate.0`
 * @param answer its answer to `help`
 */
export function parseHelpCommands(instance: string, answer: unknown): StandardCommand[] {
    const commands = (answer as { commands?: unknown } | null)?.commands;
    if (!Array.isArray(commands)) {
        return [];
    }
    const adapter = instance.replace(/\.\d+$/, '');
    const out: StandardCommand[] = [];
    const seen = new Set<string>();
    for (const entry of commands) {
        const c = entry as { command?: unknown; write?: unknown; standard?: unknown } | null;
        const command = typeof c?.command === 'string' ? c.command.trim() : '';
        if (!command) {
            continue;
        }
        const standards = Array.isArray(c?.standard) ? c.standard : [c?.standard];
        for (const s of standards) {
            const standard = typeof s === 'string' ? s.trim() : '';
            if (!STANDARD_RE.test(standard) || seen.has(standard)) {
                continue;
            }
            seen.add(standard);
            out.push({ instance, adapter, command, standard, write: c?.write === true });
        }
    }
    return out;
}

/** The parts of the adapter the registry needs. */
export interface RegistryHost {
    /** Own namespace, e.g. `assistant.0`: never asked */
    namespace: string;
    getObjectViewAsync(
        design: 'system',
        search: 'instance',
        params: { startkey: string; endkey: string },
    ): Promise<{ rows: { id: string; value: ioBroker.InstanceObject | null }[] }>;
    getForeignStateAsync(id: string): Promise<ioBroker.State | null | undefined>;
    sendToAsync(
        instance: string,
        command: string,
        message: ioBroker.MessagePayload,
        options?: { timeout?: number },
    ): Promise<unknown>;
    log: { debug(msg: string): void; info(msg: string): void };
}

export interface RegistryOptions {
    ttlMs?: number;
    timeoutMs?: number;
}

/** What one instance said, kept per instance so a refresh can skip the ones that did not change. */
interface InstanceInfo {
    version: string;
    commands: StandardCommand[];
}

/**
 * `standard → [instances]` of all running instances. Filled at the first use and again after {@link REGISTRY_TTL_MS};
 * an instance that was stopped is asked when it runs again at the next refresh. Instances whose version did not
 * change are not asked again before their TTL.
 */
export class StandardRegistry {
    private readonly ttlMs: number;
    private readonly timeoutMs: number;
    private known = new Map<string, InstanceInfo>();
    private loadedAt = 0;
    private loading: Promise<void> | null = null;

    constructor(
        private readonly host: RegistryHost,
        opts: RegistryOptions = {},
    ) {
        this.ttlMs = opts.ttlMs ?? REGISTRY_TTL_MS;
        this.timeoutMs = opts.timeoutMs ?? HELP_TIMEOUT_MS;
    }

    /** Ask `help` of every running instance that supports it; concurrent calls share one run. */
    refresh(): Promise<void> {
        this.loading ??= this.load().finally(() => {
            this.loading = null;
        });
        return this.loading;
    }

    /** The next {@link find} asks the instances again. */
    invalidate(): void {
        this.loadedAt = 0;
    }

    /** All catalog commands known now, without asking anybody. */
    list(): StandardCommand[] {
        return [...this.known.values()].flatMap(i => i.commands);
    }

    /**
     * The instances that offer a standard command, in the order of their ids (`a.0` before `b.0`, `x.0` before `x.1`).
     *
     * @param standard e.g. `camera.snapshot`
     */
    async find(standard: string): Promise<StandardCommand[]> {
        if (!this.loadedAt || Date.now() - this.loadedAt > this.ttlMs) {
            await this.refresh();
        }
        return this.list().filter(c => c.standard === standard);
    }

    /** Whether an instance offers a standard command (from what is known now). */
    has(instance: string, standard: string): boolean {
        return !!this.known.get(instance)?.commands.some(c => c.standard === standard);
    }

    /** The command an instance offers for a standard, or null. */
    commandOf(instance: string, standard: string): StandardCommand | null {
        return this.known.get(instance)?.commands.find(c => c.standard === standard) || null;
    }

    private async load(): Promise<void> {
        const view = await this.host
            .getObjectViewAsync('system', 'instance', { startkey: 'system.adapter.', endkey: 'system.adapter.香' })
            .catch(() => ({ rows: [] }));
        const candidates: { instance: string; version: string }[] = [];
        for (const row of view.rows) {
            const obj = row.value;
            const instance = row.id.replace(/^system\.adapter\./, '');
            const help = (obj?.common as { supportedMessages?: { help?: unknown } } | undefined)?.supportedMessages
                ?.help;
            if (!obj || !help || instance === this.host.namespace) {
                continue;
            }
            candidates.push({ instance, version: String(obj.common?.version ?? '') });
        }
        const next = new Map<string, InstanceInfo>();
        const queue = [...candidates];
        const worker = async (): Promise<void> => {
            for (let c = queue.shift(); c; c = queue.shift()) {
                const info = await this.ask(c.instance, c.version);
                if (info) {
                    next.set(c.instance, info);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
        const before = this.list().length;
        this.known = new Map([...next.entries()].sort(([a], [b]) => compareInstances(a, b)));
        this.loadedAt = Date.now();
        const after = this.list();
        if (after.length !== before) {
            this.host.log.info(
                `Shared commands of other adapters: ${after.length ? after.map(c => `${c.instance} ${c.standard}`).join(', ') : 'none'}.`,
            );
        }
    }

    /** The commands of one instance: asked when it runs; a stopped one keeps nothing (it cannot answer anyway). */
    private async ask(instance: string, version: string): Promise<InstanceInfo | null> {
        const alive = await this.host.getForeignStateAsync(`system.adapter.${instance}.alive`).catch(() => null);
        if (!alive?.val) {
            return null;
        }
        const old = this.known.get(instance);
        if (old && old.version === version && this.loadedAt && Date.now() - this.loadedAt <= this.ttlMs) {
            return old;
        }
        try {
            const answer = await this.host.sendToAsync(instance, 'help', {}, { timeout: this.timeoutMs });
            return { version, commands: parseHelpCommands(instance, answer) };
        } catch (e) {
            this.host.log.debug(`${instance} did not answer "help": ${(e as Error).message}`);
            return old || null;
        }
    }
}

/** `a.0` before `a.1` before `a.10` before `b.0`. */
export function compareInstances(a: string, b: string): number {
    const [an, ai] = [a.replace(/\.\d+$/, ''), Number(a.match(/\.(\d+)$/)?.[1] ?? 0)];
    const [bn, bi] = [b.replace(/\.\d+$/, ''), Number(b.match(/\.(\d+)$/)?.[1] ?? 0)];
    return an === bn ? ai - bi : an < bn ? -1 : 1;
}

/** The error of a catalog answer (`{error, reason?}`, rule 4), or null when it succeeded. */
export function standardError(answer: unknown): { error: string; reason: string; candidates: string[] } | null {
    if (answer === undefined || answer === null) {
        return { error: 'no answer', reason: 'NO_ANSWER', candidates: [] };
    }
    if (typeof answer !== 'object') {
        return null;
    }
    const a = answer as { error?: unknown; reason?: unknown; candidates?: unknown };
    if (!a.error) {
        return null;
    }
    return {
        error: typeof a.error === 'string' ? a.error : JSON.stringify(a.error),
        reason: typeof a.reason === 'string' ? a.reason : '',
        candidates: Array.isArray(a.candidates) ? a.candidates.filter((c): c is string => typeof c === 'string') : [],
    };
}

/**
 * The things of a list answer (rule 5: `{<things>: [{id, name, room?, …}]}`), e.g. `cameras` of `camera.getCameras`.
 * Also takes the bare array and the `[{value, label}]` of admin selects, which some adapters answer.
 *
 * @param answer the answer
 * @param key `cameras`, `screens`, `players`, `recipients` …
 */
export function listOf(
    answer: unknown,
    key: string,
): { id: string; name: string; room?: string; raw: Record<string, unknown> }[] {
    const a = answer as Record<string, unknown> | null;
    const list = Array.isArray(answer) ? answer : Array.isArray(a?.[key]) ? (a[key] as unknown[]) : [];
    const out: { id: string; name: string; room?: string; raw: Record<string, unknown> }[] = [];
    for (const item of list) {
        if (typeof item === 'string') {
            out.push({ id: item, name: item, raw: { id: item } });
            continue;
        }
        const i = item as Record<string, unknown> | null;
        if (!i) {
            continue;
        }
        const id = textOf(i.id) || textOf(i.value) || textOf(i.name);
        const name = textOf(i.name) || textOf(i.label) || id;
        if (!id && !name) {
            continue;
        }
        out.push({
            id: id || name,
            name: name || id,
            ...(typeof i.room === 'string' && i.room ? { room: i.room } : {}),
            raw: i,
        });
    }
    return out;
}

/** A string or a number as text; anything else ''. */
function textOf(v: unknown): string {
    return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

/**
 * A picture of a catalog answer (rule 7) as a data URL: `{data, contentType}` with base64, or a data URL in `data`,
 * `image` or `url`. Null for anything else (a Buffer, a path on another host).
 */
export function pictureOf(answer: unknown): string | null {
    const a = answer as Record<string, unknown> | null;
    if (!a || typeof a !== 'object') {
        return typeof answer === 'string' && answer.startsWith('data:image/') ? answer : null;
    }
    for (const key of ['data', 'image', 'url']) {
        const v = a[key];
        if (typeof v === 'string' && v.startsWith('data:image/')) {
            return v;
        }
    }
    const data = a.data;
    const type = typeof a.contentType === 'string' ? a.contentType : typeof a.mimeType === 'string' ? a.mimeType : '';
    if (
        typeof data === 'string' &&
        data &&
        type.startsWith('image/') &&
        /^[A-Za-z0-9+/=\r\n]+$/.test(data.slice(0, 200))
    ) {
        return `data:${type};base64,${data}`;
    }
    return null;
}

/** Long base64 and data URLs of a message or an answer as `<image/jpeg, 180 KB>`, for the log and the trace. */
export function redactPictures(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') {
        if (value.length < 1000) {
            return value;
        }
        const m = value.match(/^data:([\w/+.-]+);base64,/);
        return `<${m ? m[1] : 'data'}, ${Math.round((value.length * 3) / 4 / 1024)} KB>`;
    }
    if (!value || typeof value !== 'object' || depth > 6) {
        return value;
    }
    if (Array.isArray(value)) {
        return value.length > 50 && value.every(v => typeof v === 'number')
            ? `<${value.length} bytes>`
            : value.map(v => redactPictures(v, depth + 1));
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactPictures(v, depth + 1)]));
}
