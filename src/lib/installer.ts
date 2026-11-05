/**
 * Installs a helper adapter (pi-agent, ai-parakeet) and creates an instance of it, from a button in the settings.
 *
 * The host does it, as for the admin: `sendToHost(host, 'cmdExec', { id, data: 'add pi-agent' })` runs
 * `iobroker add pi-agent` there and reports back to this instance with the messages `cmdStdout`, `cmdStderr` and
 * `cmdExit` (the last one twice, because it gets lost sometimes) — {@link AdapterInstaller.handleMessage} takes them.
 *
 * `add` installs from the repository the system uses and creates an instance. An adapter that is not in that
 * repository (pi-agent is only in "latest") comes from npm with `url iobroker.<name>`, then `add` once more.
 */

export interface InstallerAdapter {
    sendToHost(host: string, command: string, message: ioBroker.MessagePayload): void;
    getForeignObjectAsync(id: string): Promise<ioBroker.Object | null | undefined>;
    getObjectViewAsync(
        design: 'system',
        search: 'instance',
        params: { startkey: string; endkey: string },
    ): Promise<{ rows: { id: string; value: ioBroker.Object }[] }>;
    log: ioBroker.Logger;
}

export interface CommandResult {
    /** Exit code of the command, null when it was killed. */
    code: number | null;
    /** Its last output lines. */
    output: string[];
}

interface Running {
    resolve: (result: CommandResult) => void;
    output: string[];
    timer: NodeJS.Timeout;
}

/** An npm install on a Raspberry Pi takes a while; a command that runs longer goes on on the host. */
export const COMMAND_TIMEOUT_MS = 15 * 60_000;
const KEEP_LINES = 30;
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export class AdapterInstaller {
    private readonly running = new Map<string, Running>();
    private busy = '';
    private seq = 0;

    constructor(
        private readonly adapter: InstallerAdapter,
        /** Host to install on: the one of this instance. */
        private readonly host: string,
        private readonly timeoutMs = COMMAND_TIMEOUT_MS,
    ) {}

    /** A `cmdStdout`/`cmdStderr`/`cmdExit` message of the host; false when it is none of ours. */
    handleMessage(command: string, message: unknown): boolean {
        if (command !== 'cmdStdout' && command !== 'cmdStderr' && command !== 'cmdExit') {
            return false;
        }
        const { id, data } = (message || {}) as { id?: unknown; data?: unknown };
        const run = typeof id === 'string' ? this.running.get(id) : undefined;
        if (!run) {
            return true; // the second cmdExit, or a command of an earlier run
        }
        if (command === 'cmdExit') {
            this.running.delete(id as string);
            clearTimeout(run.timer);
            run.resolve({ code: typeof data === 'number' ? data : null, output: run.output });
            return true;
        }
        const text = typeof data === 'string' ? data : data === undefined || data === null ? '' : JSON.stringify(data);
        for (const line of text.split(/\r?\n/)) {
            if (line.trim()) {
                run.output.push(line.trim());
                this.adapter.log.debug(`${this.host}: ${line.trim()}`);
            }
        }
        run.output.splice(0, Math.max(0, run.output.length - KEEP_LINES));
        return true;
    }

    /** Run `iobroker <cmd>` on the host. */
    run(cmd: string): Promise<CommandResult> {
        const id = `assistant-${Date.now()}-${++this.seq}`;
        this.adapter.log.info(`${this.host}: iobroker ${cmd}`);
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.running.delete(id);
                resolve({
                    code: null,
                    output: [
                        `iobroker ${cmd} still runs on ${this.host} after ${Math.ceil(this.timeoutMs / 60_000)} min — see the log of the host`,
                    ],
                });
            }, this.timeoutMs);
            this.running.set(id, { resolve, output: [], timer });
            this.adapter.sendToHost(this.host, 'cmdExec', { id, data: cmd });
        });
    }

    /** An instance of the adapter: an enabled one first, on this host first. `pi-agent.0`, or null. */
    async findInstance(name: string): Promise<string | null> {
        const prefix = `system.adapter.${name}.`;
        const view = await this.adapter.getObjectViewAsync('system', 'instance', {
            startkey: prefix,
            endkey: `${prefix}香`,
        });
        const rank = (obj: ioBroker.Object): number =>
            (obj.common?.enabled ? 0 : 2) + ((obj.common as { host?: string })?.host === this.host ? 0 : 1);
        const rows = (view?.rows || [])
            .filter(row => row.value && /^\d+$/.test(row.id.slice(prefix.length)))
            .sort((a, b) => rank(a.value) - rank(b.value) || a.id.localeCompare(b.id, undefined, { numeric: true }));
        return rows.length ? rows[0].id.slice('system.adapter.'.length) : null;
    }

    /** Install the adapter if needed and create an instance if there is none. */
    async ensure(name: string): Promise<{ instance: string; installed: boolean }> {
        if (!NAME_RE.test(name)) {
            throw new Error(`Invalid adapter name "${name}"`);
        }
        const existing = await this.findInstance(name);
        if (existing) {
            return { instance: existing, installed: false };
        }
        if (this.busy) {
            throw new Error(`${this.busy} is being installed right now`);
        }
        this.busy = name;
        try {
            const installed = async (): Promise<boolean> =>
                !!(await this.adapter.getForeignObjectAsync(`system.adapter.${name}`));
            let add = await this.runToEnd(`add ${name}`);
            if (!(await this.findInstance(name))) {
                if (!(await installed())) {
                    // not in the repository the system uses: the newest version from npm
                    const npm = await this.runToEnd(`url iobroker.${name}`);
                    if (!(await installed())) {
                        throw new Error(
                            `${name} could not be installed — neither from the repository (${lastError(add)}) nor from npm (${lastError(npm)})`,
                        );
                    }
                }
                add = await this.runToEnd(`add ${name}`);
            }
            const instance = await this.findInstance(name);
            if (!instance) {
                throw new Error(`${name} is installed, but no instance was created: ${lastError(add)}`);
            }
            this.adapter.log.info(`${instance} installed on ${this.host}`);
            return { instance, installed: true };
        } finally {
            this.busy = '';
        }
    }

    /** {@link run}, but a command that did not end (timeout, adapter stops) ends the installation: it still runs. */
    private async runToEnd(cmd: string): Promise<CommandResult> {
        const result = await this.run(cmd);
        if (result.code === null) {
            throw new Error(result.output[result.output.length - 1] || `iobroker ${cmd} did not end`);
        }
        return result;
    }

    /** Ends waiting commands (the adapter stops); they go on on the host. */
    stop(): void {
        for (const [id, run] of this.running) {
            clearTimeout(run.timer);
            run.resolve({ code: null, output: ['the adapter stopped'] });
            this.running.delete(id);
        }
    }
}

/** The line that says why a command failed: an error line, else the last one. */
function lastError(result: CommandResult): string {
    const lines = result.output;
    const error = [...lines].reverse().find(line => /error|unknown|not found|cannot|failed/i.test(line));
    const line = error || lines[lines.length - 1] || '';
    return `exit code ${result.code ?? '–'}${line ? `: ${line.slice(0, 300)}` : ''}`;
}
