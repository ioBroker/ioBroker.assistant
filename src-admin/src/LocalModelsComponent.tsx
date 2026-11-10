import React from 'react';

import {
    Alert,
    Box,
    Button,
    Card,
    CardActions,
    CardContent,
    Chip,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    LinearProgress,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableRow,
    TextField,
    Tooltip,
    Typography,
} from '@mui/material';
import {
    CheckCircle as ActiveIcon,
    Close as CancelIcon,
    Delete as DeleteIcon,
    Download as DownloadIcon,
    RestartAlt as ResetIcon,
    Speed as BenchmarkIcon,
} from '@mui/icons-material';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import { I18n } from '@iobroker/gui-components';

// Register this component's translations into the shared admin I18n (custom components don't auto-load them).
const translations: Record<string, Record<string, string>> = {};
const i18nModules = import.meta.glob('./i18n/*.json', { eager: true }) as Record<
    string,
    { default: Record<string, string> }
>;
for (const [p, mod] of Object.entries(i18nModules)) {
    const lang = p.split('/').pop()?.replace('.json', '') || 'en';
    translations[lang] = mod.default;
}
I18n.extendTranslations(translations);

const t = (key: string, ...args: (string | number)[]): string => I18n.t(`custom_assistant_${key}`, ...args);

// ---- Shapes of the backend answer (`listLocalModels`, see src/lib/llmModels.ts) ----------------------------

interface Stats {
    asked: number;
    answered: number;
    handoffs: number;
    busy: number;
    timeouts: number;
    errors: number;
    tokens: number;
    loads: number;
    lastLoadMs: number;
    lastUsed: number;
    failureRate: number | null;
    tokensPerSec: number | null;
    avgFirstTokenMs: number | null;
    avgAnswerMs: number | null;
    benchmark?: Benchmark;
}

interface Benchmark {
    at: number;
    languages: string[];
    cases: number;
    correct: number;
    missedHandoffs: number;
    needlessHandoffs: number;
    wrongAnswers: number;
    timeouts: number;
    errors: number;
    tokensPerSec: number;
    avgFirstTokenMs: number;
    avgMs: number;
    details: { lang: string; question: string; expect: string; answer: string; ok: boolean; ms: number }[];
}

interface ModelInfo {
    file: string;
    name: string;
    sizeBytes: number;
    url?: string;
    presetId?: string;
    addedAt?: number;
    stats: Stats;
}

interface Preset {
    id: string;
    name: string;
    file: string;
    url: string;
    sizeBytes: number;
    params: string;
    languages: string[];
    speed: 'very fast' | 'fast' | 'medium' | 'slow';
    thinking?: boolean;
    description: Record<string, string>;
}

interface DownloadInfo {
    file: string;
    url: string;
    received: number;
    total: number;
    error?: string;
}

interface ListAnswer {
    dir: string;
    active: string;
    loaded: string;
    engineInstalled: boolean;
    models: ModelInfo[];
    totalBytes: number;
    disk: { free: number; total: number } | null;
    downloads: DownloadInfo[];
    presets: Preset[];
    benchmarkRunning: boolean;
    language: string;
    error?: string;
}

interface LocalModelsState extends ConfigGenericState {
    list: ListAnswer | null;
    alive: boolean;
    error: string;
    url: string;
    busy: string;
    status: string;
    progress: number;
    confirmDelete: string;
    details: ModelInfo | null;
}

function formatBytes(n: number): string {
    if (n >= 1024 ** 3) {
        return `${(n / 1024 ** 3).toFixed(2)} GB`;
    }
    if (n >= 1024 ** 2) {
        return `${Math.round(n / 1024 ** 2)} MB`;
    }
    return `${Math.round(n / 1024)} KB`;
}

function formatMs(ms: number | null | undefined): string {
    if (ms === null || ms === undefined) {
        return '-';
    }
    return ms >= 10_000
        ? `${Math.round(ms / 1000)} s`
        : ms >= 1000
          ? `${(ms / 1000).toFixed(1)} s`
          : `${Math.round(ms)} ms`;
}

function languageName(code: string): string {
    if (code === 'multi') {
        return t('many languages');
    }
    try {
        return new Intl.DisplayNames([I18n.getLanguage()], { type: 'language' }).of(code) || code;
    } catch {
        return code;
    }
}

/**
 * "Local models" tab: the GGUF files in the model directory with size and statistics, downloads (presets or
 * own link), deleting, picking the active model (written into the form; saving restarts the instance and
 * loads it) and a benchmark of the loaded model on this host.
 */
export default class LocalModelsComponent extends ConfigGeneric<ConfigGenericProps, LocalModelsState> {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private aliveId = '';
    private statusId = '';
    private progressId = '';
    private unmounted = false;

    constructor(props: ConfigGenericProps) {
        super(props);
        this.state = {
            ...this.state,
            list: null,
            alive: false,
            error: '',
            url: '',
            busy: '',
            status: '',
            progress: 0,
            confirmDelete: '',
            details: null,
        };
    }

    private get instanceId(): string {
        const ctx = this.props.oContext;
        return `${ctx.adapterName}.${ctx.instance}`;
    }

    private get form(): Record<string, any> {
        return (this.props.data || {}) as Record<string, any>;
    }

    async componentDidMount(): Promise<void> {
        super.componentDidMount();
        const socket = this.props.oContext.socket;
        this.aliveId = `system.adapter.${this.instanceId}.alive`;
        this.statusId = `${this.instanceId}.localLlm.status`;
        this.progressId = `${this.instanceId}.localLlm.progress`;
        try {
            const alive = await socket.getState(this.aliveId);
            const status = await socket.getState(this.statusId);
            const progress = await socket.getState(this.progressId);
            this.setState({
                alive: !!alive?.val,
                status: (status?.val as string) || '',
                progress: Number(progress?.val) || 0,
            });
        } catch {
            /* states may not exist yet */
        }
        await socket.subscribeState(this.aliveId, this.onAlive);
        await socket.subscribeState(this.statusId, this.onStatus);
        await socket.subscribeState(this.progressId, this.onProgress);
        void this.refresh();
    }

    componentWillUnmount(): void {
        this.unmounted = true;
        if (this.timer) {
            clearTimeout(this.timer);
        }
        const socket = this.props.oContext.socket;
        socket.unsubscribeState(this.aliveId, this.onAlive);
        socket.unsubscribeState(this.statusId, this.onStatus);
        socket.unsubscribeState(this.progressId, this.onProgress);
        super.componentWillUnmount?.();
    }

    componentDidUpdate(prev: ConfigGenericProps): void {
        // the directory field changed in the form → list that directory
        const before = (prev.data as Record<string, any>)?.localLlmModelDir;
        if (before !== this.form.localLlmModelDir) {
            void this.refresh();
        }
    }

    private onAlive = (_id: string, state: ioBroker.State | null | undefined): void => {
        const alive = !!state?.val;
        if (alive !== this.state.alive) {
            this.setState({ alive }, () => void this.refresh());
        }
    };

    private onStatus = (_id: string, state: ioBroker.State | null | undefined): void => {
        this.setState({ status: (state?.val as string) || '' });
    };

    private onProgress = (_id: string, state: ioBroker.State | null | undefined): void => {
        this.setState({ progress: Number(state?.val) || 0 });
    };

    private async send<T = any>(command: string, message: Record<string, unknown> = {}): Promise<T> {
        const res = (await this.props.oContext.socket.sendTo(this.instanceId, command, {
            dir: this.form.localLlmModelDir || '',
            active: this.form.localLlmModel || '',
            ...message,
        })) as any;
        if (res?.error) {
            throw new Error(res.error);
        }
        return res as T;
    }

    /** Loads the list; polls every second while something runs, otherwise every 10 s. */
    private async refresh(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.unmounted) {
            return;
        }
        if (!this.state.alive) {
            this.setState({ list: null });
            return;
        }
        try {
            const list = await this.send<ListAnswer>('listLocalModels');
            if (this.unmounted) {
                return;
            }
            this.setState({ list, error: '' });
            const running = list.downloads.some(d => !d.error) || list.benchmarkRunning;
            this.timer = setTimeout(() => void this.refresh(), running ? 1000 : 10_000);
        } catch (e) {
            this.setState({ error: (e as Error).message });
            this.timer = setTimeout(() => void this.refresh(), 10_000);
        }
    }

    private async run(key: string, command: string, message: Record<string, unknown> = {}): Promise<void> {
        this.setState({ busy: key, error: '' });
        try {
            await this.send(command, message);
        } catch (e) {
            this.setState({ error: (e as Error).message });
        }
        this.setState({ busy: '' });
        await this.refresh();
    }

    /** Puts the model into the form field "Active model"; saving restarts the instance with it. */
    private useModel(file: string): void {
        this.props.onChange({ ...this.form, localLlmModel: file });
    }

    // ---- Rendering -------------------------------------------------------------------------------------

    private renderHeader(list: ListAnswer): React.JSX.Element {
        const chosen = this.form.localLlmModel || list.active;
        const pendingSwitch = list.loaded && chosen && list.loaded !== chosen;
        const used = list.disk ? list.disk.total - list.disk.free : 0;
        return (
            <Box sx={{ mb: 2 }}>
                {!list.engineInstalled ? (
                    <Alert
                        severity="warning"
                        sx={{ mb: 1 }}
                    >
                        {t('The engine is not installed yet. Install it on the main tab ("Install local model").')}
                    </Alert>
                ) : null}
                {pendingSwitch ? (
                    <Alert
                        severity="info"
                        sx={{ mb: 1 }}
                    >
                        {t('Save the settings to load the selected model. The instance restarts.')}
                    </Alert>
                ) : null}
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center' }}>
                    <Typography variant="body2">
                        {t('Folder')}: <code>{list.dir}</code>
                    </Typography>
                    <Typography variant="body2">
                        {t('Models')}: {list.models.length}, {formatBytes(list.totalBytes)}
                    </Typography>
                    {list.disk ? (
                        <Tooltip title={`${formatBytes(used)} / ${formatBytes(list.disk.total)}`}>
                            <Box sx={{ minWidth: 220 }}>
                                <Typography variant="body2">
                                    {t('Free on the disk')}: {formatBytes(list.disk.free)}
                                </Typography>
                                <LinearProgress
                                    variant="determinate"
                                    value={list.disk.total ? (100 * used) / list.disk.total : 0}
                                    color={list.disk.free < 2 * 1024 ** 3 ? 'warning' : 'primary'}
                                />
                            </Box>
                        </Tooltip>
                    ) : null}
                    {this.state.status ? (
                        <Chip
                            size="small"
                            variant="outlined"
                            color={
                                this.state.status === 'ready'
                                    ? 'success'
                                    : this.state.status === 'error'
                                      ? 'error'
                                      : 'default'
                            }
                            label={`${t('Loaded model')}: ${I18n.t(`custom_assistant_llm_${this.state.status}`)}${
                                ['downloading', 'benchmark'].includes(this.state.status)
                                    ? ` ${Math.round(this.state.progress)}%`
                                    : ''
                            }`}
                        />
                    ) : null}
                </Box>
            </Box>
        );
    }

    private renderBenchmark(m: ModelInfo): React.JSX.Element | string {
        const b = m.stats.benchmark;
        if (!b) {
            return '-';
        }
        const errors = b.cases - b.correct;
        return (
            <Tooltip title={t('Details')}>
                <Chip
                    size="small"
                    clickable
                    onClick={() => this.setState({ details: m })}
                    color={errors === 0 ? 'success' : errors <= b.cases / 4 ? 'warning' : 'error'}
                    label={`${b.correct}/${b.cases} · ${b.tokensPerSec} t/s`}
                />
            </Tooltip>
        );
    }

    private renderModels(list: ListAnswer): React.JSX.Element {
        const chosen = this.form.localLlmModel || list.active;
        if (!list.models.length) {
            return (
                <Typography
                    variant="body2"
                    sx={{ my: 1 }}
                >
                    {t('No models in this folder yet. Download one below.')}
                </Typography>
            );
        }
        return (
            <Box sx={{ overflowX: 'auto' }}>
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            <TableCell>{t('Model')}</TableCell>
                            <TableCell align="right">{t('Size')}</TableCell>
                            <TableCell align="right">
                                <Tooltip
                                    title={t('Questions asked / answered by the model / handed over to the next tier')}
                                >
                                    <span>{t('Asked / answered / handed over')}</span>
                                </Tooltip>
                            </TableCell>
                            <TableCell align="right">
                                <Tooltip title={t('Timeouts and errors among the questions asked')}>
                                    <span>{t('Failures')}</span>
                                </Tooltip>
                            </TableCell>
                            <TableCell align="right">{t('Tokens/s')}</TableCell>
                            <TableCell align="right">
                                <Tooltip title={t('Time until the first word: reading the question')}>
                                    <span>{t('First token')}</span>
                                </Tooltip>
                            </TableCell>
                            <TableCell align="right">{t('Answer time')}</TableCell>
                            <TableCell align="right">{t('Load time')}</TableCell>
                            <TableCell>{t('Benchmark')}</TableCell>
                            <TableCell />
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {list.models.map(m => {
                            const s = m.stats;
                            const isChosen = m.file === chosen;
                            const isLoaded = m.file === list.loaded;
                            return (
                                <TableRow
                                    key={m.file}
                                    selected={isChosen}
                                >
                                    <TableCell>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                            {isChosen ? (
                                                <ActiveIcon
                                                    fontSize="small"
                                                    color="success"
                                                />
                                            ) : null}
                                            <Tooltip title={m.url || m.file}>
                                                <span>{m.name}</span>
                                            </Tooltip>
                                        </Box>
                                        {s.lastUsed ? (
                                            <Typography
                                                variant="caption"
                                                sx={{ opacity: 0.7 }}
                                            >
                                                {t('last used')} {new Date(s.lastUsed).toLocaleString()}
                                            </Typography>
                                        ) : null}
                                    </TableCell>
                                    <TableCell align="right">{formatBytes(m.sizeBytes)}</TableCell>
                                    <TableCell align="right">
                                        {s.asked} / {s.answered} / {s.handoffs}
                                    </TableCell>
                                    <TableCell align="right">
                                        {s.failureRate === null
                                            ? '-'
                                            : `${Math.round(s.failureRate * 100)} % (${s.timeouts + s.errors})`}
                                    </TableCell>
                                    <TableCell align="right">
                                        {s.tokensPerSec === null ? '-' : s.tokensPerSec.toFixed(1)}
                                    </TableCell>
                                    <TableCell align="right">{formatMs(s.avgFirstTokenMs)}</TableCell>
                                    <TableCell align="right">{formatMs(s.avgAnswerMs)}</TableCell>
                                    <TableCell align="right">{s.loads ? formatMs(s.lastLoadMs) : '-'}</TableCell>
                                    <TableCell>{this.renderBenchmark(m)}</TableCell>
                                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                                        {!isChosen ? (
                                            <Button
                                                size="small"
                                                onClick={() => this.useModel(m.file)}
                                            >
                                                {t('Use')}
                                            </Button>
                                        ) : null}
                                        {isLoaded ? (
                                            <Tooltip
                                                title={t(
                                                    'Asks the loaded model test questions in the language of the assistant and in English: home questions must be handed over, general ones answered correctly',
                                                )}
                                            >
                                                <span>
                                                    <IconButton
                                                        size="small"
                                                        disabled={!!this.state.busy || list.benchmarkRunning}
                                                        onClick={() =>
                                                            void this.run(`bench:${m.file}`, 'benchmarkLocalModel')
                                                        }
                                                    >
                                                        <BenchmarkIcon fontSize="small" />
                                                    </IconButton>
                                                </span>
                                            </Tooltip>
                                        ) : null}
                                        <Tooltip title={t('Reset statistics')}>
                                            <IconButton
                                                size="small"
                                                onClick={() =>
                                                    void this.run(`reset:${m.file}`, 'resetLocalModelStats', {
                                                        file: m.file,
                                                    })
                                                }
                                            >
                                                <ResetIcon fontSize="small" />
                                            </IconButton>
                                        </Tooltip>
                                        <Tooltip
                                            title={
                                                isChosen || isLoaded
                                                    ? t('The active model cannot be deleted')
                                                    : t('Delete')
                                            }
                                        >
                                            <span>
                                                <IconButton
                                                    size="small"
                                                    disabled={isChosen || isLoaded}
                                                    onClick={() => this.setState({ confirmDelete: m.file })}
                                                >
                                                    <DeleteIcon fontSize="small" />
                                                </IconButton>
                                            </span>
                                        </Tooltip>
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </Box>
        );
    }

    private renderDownloads(list: ListAnswer): React.JSX.Element | null {
        if (!list.downloads.length) {
            return null;
        }
        return (
            <Box sx={{ my: 2 }}>
                {list.downloads.map(d => (
                    <Box
                        key={d.file}
                        sx={{ mb: 1 }}
                    >
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <Typography
                                variant="body2"
                                sx={{ flexGrow: 1 }}
                            >
                                {d.file}:{' '}
                                {d.error
                                    ? `${t('failed')}: ${d.error}`
                                    : `${formatBytes(d.received)}${d.total ? ` / ${formatBytes(d.total)}` : ''}`}
                            </Typography>
                            {!d.error ? (
                                <Tooltip title={t('Cancel')}>
                                    <IconButton
                                        size="small"
                                        onClick={() =>
                                            void this.run(`cancel:${d.file}`, 'cancelLocalModelDownload', {
                                                file: d.file,
                                            })
                                        }
                                    >
                                        <CancelIcon fontSize="small" />
                                    </IconButton>
                                </Tooltip>
                            ) : null}
                        </Box>
                        {!d.error ? (
                            <LinearProgress
                                variant={d.total ? 'determinate' : 'indeterminate'}
                                value={d.total ? (100 * d.received) / d.total : undefined}
                            />
                        ) : null}
                    </Box>
                ))}
            </Box>
        );
    }

    private renderPresets(list: ListAnswer): React.JSX.Element {
        const lang = I18n.getLanguage();
        const voice = (list.language || 'en').split('-')[0];
        const have = new Set(list.models.map(m => m.file));
        const loading = new Set(list.downloads.filter(d => !d.error).map(d => d.file));
        return (
            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                    gap: 1.5,
                    my: 1,
                }}
            >
                {list.presets.map(p => {
                    const speaks = p.languages.includes('multi') || p.languages.includes(voice);
                    const tooBig = list.disk ? p.sizeBytes + 200 * 1024 ** 2 > list.disk.free : false;
                    return (
                        <Card
                            key={p.id}
                            variant="outlined"
                            sx={{ display: 'flex', flexDirection: 'column' }}
                        >
                            <CardContent sx={{ flexGrow: 1, pb: 1 }}>
                                <Typography variant="subtitle2">{p.name}</Typography>
                                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, my: 0.5 }}>
                                    <Chip
                                        size="small"
                                        label={`${p.params} ${t('parameters')}`}
                                    />
                                    <Chip
                                        size="small"
                                        label={formatBytes(p.sizeBytes)}
                                    />
                                    <Tooltip
                                        title={t(
                                            'Estimate from the model size, not measured. Use the benchmark for real numbers.',
                                        )}
                                    >
                                        <Chip
                                            size="small"
                                            variant="outlined"
                                            label={`${t('speed')}: ${t(p.speed)}`}
                                        />
                                    </Tooltip>
                                </Box>
                                <Typography
                                    variant="body2"
                                    sx={{ mb: 0.5 }}
                                >
                                    {p.description[lang] || p.description.en}
                                </Typography>
                                <Typography
                                    variant="caption"
                                    color={speaks ? 'text.secondary' : 'warning.main'}
                                >
                                    {t('Languages')}: {p.languages.map(languageName).join(', ')}
                                    {speaks ? '' : `. ${t('not the language of the assistant')}`}
                                </Typography>
                            </CardContent>
                            <CardActions>
                                <Button
                                    size="small"
                                    startIcon={<DownloadIcon />}
                                    disabled={have.has(p.file) || loading.has(p.file) || tooBig || !!this.state.busy}
                                    onClick={() => void this.run(`add:${p.id}`, 'addLocalModel', { preset: p.id })}
                                >
                                    {have.has(p.file)
                                        ? t('downloaded')
                                        : loading.has(p.file)
                                          ? t('downloading')
                                          : tooBig
                                            ? t('not enough space')
                                            : t('Download')}
                                </Button>
                            </CardActions>
                        </Card>
                    );
                })}
            </Box>
        );
    }

    private renderOwnLink(): React.JSX.Element {
        return (
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', my: 1 }}>
                <TextField
                    variant="standard"
                    fullWidth
                    label={t('Own model: link to a .gguf file')}
                    helperText={t('Hugging Face links are fine, also hf:org/repo/file.gguf')}
                    value={this.state.url}
                    onChange={e => this.setState({ url: e.target.value })}
                />
                <Button
                    variant="outlined"
                    startIcon={<DownloadIcon />}
                    disabled={!this.state.url.trim() || !!this.state.busy}
                    onClick={() =>
                        void this.run('add:url', 'addLocalModel', { url: this.state.url.trim() }).then(() =>
                            this.setState({ url: this.state.error ? this.state.url : '' }),
                        )
                    }
                    sx={{ mt: 1.5, whiteSpace: 'nowrap' }}
                >
                    {t('Download')}
                </Button>
            </Box>
        );
    }

    private renderDetails(): React.JSX.Element | null {
        const m = this.state.details;
        const b = m?.stats.benchmark;
        if (!m || !b) {
            return null;
        }
        return (
            <Dialog
                open
                fullWidth
                maxWidth="md"
                onClose={() => this.setState({ details: null })}
            >
                <DialogTitle>
                    {t('Benchmark')}: {m.name}
                </DialogTitle>
                <DialogContent>
                    <Typography
                        variant="body2"
                        sx={{ mb: 1 }}
                    >
                        {new Date(b.at).toLocaleString()} · {b.correct}/{b.cases} {t('correct')} ·{' '}
                        {t('missed hand-overs')}: {b.missedHandoffs} · {t('needless hand-overs')}: {b.needlessHandoffs}{' '}
                        · {t('wrong answers')}: {b.wrongAnswers} · {t('timeouts')}: {b.timeouts} · {b.tokensPerSec} t/s
                        · {t('First token')} {formatMs(b.avgFirstTokenMs)} · {t('Answer time')} {formatMs(b.avgMs)}
                    </Typography>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell />
                                <TableCell>{t('Question')}</TableCell>
                                <TableCell>{t('Expected')}</TableCell>
                                <TableCell>{t('Answer')}</TableCell>
                                <TableCell align="right">{t('Time')}</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {b.details.map((d, i) => (
                                <TableRow key={i}>
                                    <TableCell>{d.ok ? '✓' : '✗'}</TableCell>
                                    <TableCell>
                                        [{d.lang}] {d.question}
                                    </TableCell>
                                    <TableCell>{d.expect === 'handoff' ? t('hand over') : d.expect}</TableCell>
                                    <TableCell sx={{ maxWidth: 360, wordBreak: 'break-word' }}>{d.answer}</TableCell>
                                    <TableCell align="right">{formatMs(d.ms)}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => this.setState({ details: null })}>{t('Close')}</Button>
                </DialogActions>
            </Dialog>
        );
    }

    private renderConfirmDelete(): React.JSX.Element | null {
        const file = this.state.confirmDelete;
        if (!file) {
            return null;
        }
        return (
            <Dialog
                open
                onClose={() => this.setState({ confirmDelete: '' })}
            >
                <DialogTitle>{t('Delete model?')}</DialogTitle>
                <DialogContent>
                    <Typography>{t('The file %s is deleted from the disk. Its statistics stay.', file)}</Typography>
                </DialogContent>
                <DialogActions>
                    <Button
                        color="error"
                        variant="contained"
                        onClick={() => {
                            this.setState({ confirmDelete: '' });
                            void this.run(`delete:${file}`, 'deleteLocalModel', { file });
                        }}
                    >
                        {t('Delete')}
                    </Button>
                    <Button onClick={() => this.setState({ confirmDelete: '' })}>{t('Cancel')}</Button>
                </DialogActions>
            </Dialog>
        );
    }

    renderItem(): React.JSX.Element {
        if (!this.state.alive) {
            return <Alert severity="info">{t('Start the instance to manage the local models.')}</Alert>;
        }
        const list = this.state.list;
        if (!list) {
            return this.state.error ? <Alert severity="error">{this.state.error}</Alert> : <LinearProgress />;
        }
        return (
            <Box sx={{ width: '100%' }}>
                {this.state.error ? (
                    <Alert
                        severity="error"
                        sx={{ mb: 1 }}
                        onClose={() => this.setState({ error: '' })}
                    >
                        {this.state.error}
                    </Alert>
                ) : null}
                {this.renderHeader(list)}
                {this.renderModels(list)}
                {this.renderDownloads(list)}
                <Typography
                    variant="h6"
                    sx={{ mt: 3 }}
                >
                    {t('Add a model')}
                </Typography>
                {this.renderPresets(list)}
                {this.renderOwnLink()}
                {this.renderDetails()}
                {this.renderConfirmDelete()}
            </Box>
        );
    }
}
