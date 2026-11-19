import React from 'react';

import {
    Alert,
    Box,
    Button,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControl,
    FormControlLabel,
    InputLabel,
    MenuItem,
    Paper,
    Select,
    Switch,
    TextField,
    Tooltip,
    Typography,
} from '@mui/material';
import {
    Mic as VoiceIcon,
    Person as ChatIcon,
    Send as TelegramIcon,
    Settings as ScriptIcon,
} from '@mui/icons-material';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import { I18n } from '@iobroker/gui-components';

import { TIER_COLORS, type JournalEntry, type JournalTier } from './journal';

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

/** The steps of the diagram that open settings. */
type Step = 'sources' | 'stt' | 'local' | 'localLlm' | 'cloud' | 'tts';

type LocalMode = 'off' | 'rules' | 't2c';
type CloudMode = 'off' | 'cloud' | 'pi-agent';

/** LLM providers of the tab "AI" (without `none` and `pi-agent`, which are modes here). */
const PROVIDERS: { value: string; label: string }[] = [
    { value: 'system', label: 'System-wide AI settings (admin)' },
    { value: 'openai', label: 'OpenAI' },
    { value: 'anthropic', label: 'Anthropic (Claude)' },
    { value: 'gemini', label: 'Google Gemini' },
    { value: 'deepseek', label: 'DeepSeek' },
    { value: 'openrouter', label: 'OpenRouter' },
    { value: 'custom', label: 'OpenAI-compatible (custom)' },
];

/** Speech engines of the tab "Voice" (labels are its translated option labels). */
const STT_PROVIDERS: { value: string; label: string }[] = [
    { value: 'openai', label: 'OpenAI (Whisper)' },
    { value: 'openrouter', label: 'OpenRouter' },
    { value: 'azure', label: 'Azure Speech' },
    { value: 'aws', label: 'AWS Transcribe' },
    { value: 'vosk', label: 'Vosk (local)' },
    { value: 'parakeet', label: 'ioBroker.voice (local adapter)' },
];

const TTS_PROVIDERS: { value: string; label: string }[] = [
    { value: 'openai', label: 'OpenAI' },
    { value: 'openrouter', label: 'OpenRouter' },
    { value: 'azure', label: 'Azure Speech' },
    { value: 'aws', label: 'AWS Polly' },
    { value: 'piper', label: 'Piper (local)' },
];

/** The field of the voice and its label on the tab "Voice", per TTS provider. */
const VOICE_FIELDS: Record<string, { field: string; label: string }> = {
    openai: { field: 'ttsVoice', label: 'TTS voice' },
    openrouter: { field: 'openrouterVoice', label: 'OpenRouter voice (optional)' },
    azure: { field: 'azureVoice', label: 'Azure voice (optional)' },
    aws: { field: 'awsVoice', label: 'AWS Polly voice (optional)' },
    piper: { field: 'piperVoice', label: 'Piper voice (optional)' },
};

/** The model field of the provider, where it has one. */
const STT_MODEL_FIELDS: Record<string, { field: string; label: string }> = {
    openai: { field: 'sttModel', label: 'OpenAI STT model (optional)' },
    openrouter: { field: 'openrouterSttModel', label: 'OpenRouter STT model (optional)' },
    vosk: { field: 'voskModel', label: 'Vosk model (optional)' },
};

const TTS_MODEL_FIELDS: Record<string, { field: string; label: string }> = {
    openai: { field: 'ttsModel', label: 'OpenAI TTS model (optional)' },
    openrouter: { field: 'openrouterTtsModel', label: 'OpenRouter TTS model (optional)' },
};

/** The options of "Voice language" ('' = the system language). */
const LANGUAGES: { value: string; label: string }[] = [
    { value: 'de', label: 'Deutsch' },
    { value: 'en', label: 'English' },
    { value: 'ru', label: 'Русский' },
    { value: 'fr', label: 'Français' },
    { value: 'it', label: 'Italiano' },
    { value: 'es', label: 'Español' },
    { value: 'nl', label: 'Nederlands' },
    { value: 'pl', label: 'Polski' },
    { value: 'pt', label: 'Português' },
    { value: 'uk', label: 'Українська' },
    { value: 'zh-cn', label: '中文' },
];

const STEP_COLORS: Record<Step, string> = {
    sources: '#607d8b',
    stt: '#ef6c00',
    local: TIER_COLORS.nlu,
    localLlm: TIER_COLORS.localLlm,
    cloud: TIER_COLORS.cloud,
    tts: '#d81b60',
};

/** "system.adapter.voice.0" and "voice.0" are the same instance. */
function bareInstance(id: unknown): string {
    return String(id || '').replace(/^system\.adapter\./, '');
}

interface InstanceInfo {
    id: string;
    alive: boolean;
}

interface FlowState extends ConfigGenericState {
    open: Step | null;
    alive: boolean;
    t2cInstances: InstanceInfo[] | null;
    piInstances: InstanceInfo[] | null;
    /** instances of ioBroker.voice (speech recognition "parakeet") */
    voiceInstances: InstanceInfo[] | null;
    /** telegram instances whose "assistant instance" is this one */
    telegram: string[];
    models: { file: string; name: string }[] | null;
    /** answers per tier in the journal */
    counts: Partial<Record<JournalTier, number>> | null;
    /** how long speech recognition and speech output took on average in the journal */
    timing: { stt: { ms: number; n: number }; tts: { ms: number; n: number } } | null;
    /** voices of the TTS provider for the voice language, and for which provider/language/model they are */
    voices: string[] | null;
    voicesKey: string;
    installing: string;
    error: string;
}

/**
 * The tab "Flow": how a request goes through the assistant — where it comes from, who decides locally (off, the
 * built-in rules, smart-text2command), the local model and the cloud tier — as a chain of steps. A click on a step
 * opens its settings; they change the form like the other tabs (saving applies them).
 */
export default class FlowComponent extends ConfigGeneric<ConfigGenericProps, FlowState> {
    private unmounted = false;

    constructor(props: ConfigGenericProps) {
        super(props);
        this.state = {
            ...this.state,
            open: null,
            alive: false,
            t2cInstances: null,
            piInstances: null,
            voiceInstances: null,
            telegram: [],
            models: null,
            counts: null,
            timing: null,
            voices: null,
            voicesKey: '',
            installing: '',
            error: '',
        };
    }

    private get instanceId(): string {
        const ctx = this.props.oContext;
        return `${ctx.adapterName}.${ctx.instance}`;
    }

    private get form(): Record<string, any> {
        return (this.props.data || {}) as Record<string, any>;
    }

    /** Change fields of the form (saved with the button of the settings). */
    private set(patch: Record<string, unknown>): void {
        this.props.onChange({ ...this.form, ...patch });
    }

    async componentDidMount(): Promise<void> {
        super.componentDidMount();
        const socket = this.props.oContext.socket;
        try {
            const alive = await socket.getState(`system.adapter.${this.instanceId}.alive`);
            this.onAlive('', alive);
        } catch {
            /* not there yet */
        }
        await socket.subscribeState(`system.adapter.${this.instanceId}.alive`, this.onAlive);
        void this.loadInstances();
    }

    componentWillUnmount(): void {
        this.unmounted = true;
        this.props.oContext.socket.unsubscribeState(`system.adapter.${this.instanceId}.alive`, this.onAlive);
        super.componentWillUnmount?.();
    }

    private onAlive = (_id: string, state: ioBroker.State | null | undefined): void => {
        const alive = !!state?.val;
        if (alive !== this.state.alive) {
            this.setState({ alive }, () => alive && void this.loadFromAdapter());
        }
    };

    private async instancesOf(adapter: string): Promise<InstanceInfo[]> {
        const socket = this.props.oContext.socket;
        try {
            const objs = await socket.getAdapterInstances(adapter, true);
            const list: InstanceInfo[] = [];
            for (const obj of objs || []) {
                const id = obj._id.replace(/^system\.adapter\./, '');
                const alive = await socket.getState(`system.adapter.${id}.alive`).catch(() => null);
                list.push({ id, alive: !!alive?.val });
            }
            return list.sort((a, b) => a.id.localeCompare(b.id));
        } catch {
            return [];
        }
    }

    private async loadInstances(): Promise<void> {
        const [t2cInstances, piInstances, voiceInstances] = await Promise.all([
            this.instancesOf('smart-text2command'),
            this.instancesOf('pi-agent'),
            this.instancesOf('voice'),
        ]);
        let telegram: string[] = [];
        try {
            const objs = await this.props.oContext.socket.getAdapterInstances('telegram', true);
            telegram = (objs || [])
                .filter(
                    obj =>
                        String((obj.native as Record<string, unknown>)?.assistantInstance || '').replace(
                            /^system\.adapter\./,
                            '',
                        ) === this.instanceId,
                )
                .map(obj => obj._id.replace(/^system\.adapter\./, ''));
        } catch {
            /* no telegram */
        }
        if (!this.unmounted) {
            this.setState({ t2cInstances, piInstances, voiceInstances, telegram });
        }
    }

    /** Things only the running adapter knows: the downloaded local models and how often each step answered. */
    private async loadFromAdapter(): Promise<void> {
        const socket = this.props.oContext.socket;
        try {
            const list = (await socket.sendTo(this.instanceId, 'listLocalModels', {
                dir: this.form.localLlmModelDir || '',
                active: this.form.localLlmModel || '',
            })) as { models?: { file: string; name: string }[] } | undefined;
            if (!this.unmounted && list?.models) {
                this.setState({ models: list.models.map(m => ({ file: m.file, name: m.name || m.file })) });
            }
        } catch {
            /* an older adapter */
        }
        try {
            const res = (await socket.sendTo(this.instanceId, 'getJournal', {})) as
                { enabled?: boolean; entries?: JournalEntry[] } | undefined;
            if (!this.unmounted && res?.enabled) {
                const counts: Partial<Record<JournalTier, number>> = {};
                const timing = { stt: { ms: 0, n: 0 }, tts: { ms: 0, n: 0 } };
                for (const e of res.entries || []) {
                    if (e.tier) {
                        counts[e.tier] = (counts[e.tier] || 0) + 1;
                    }
                    if (e.sttMs) {
                        timing.stt.ms += e.sttMs;
                        timing.stt.n++;
                    }
                    if (e.ttsMs) {
                        timing.tts.ms += e.ttsMs;
                        timing.tts.n++;
                    }
                }
                this.setState({ counts, timing });
            }
        } catch {
            /* no journal */
        }
    }

    componentDidUpdate(): void {
        // The voice list follows the provider, the language and the model chosen in the dialog
        if (this.state.open === 'tts' && this.state.alive && this.state.voicesKey !== this.voicesKey) {
            void this.loadVoices();
        }
    }

    private get voicesKey(): string {
        const f = this.form;
        return [this.ttsProvider, f.voiceLanguage || '', f.openrouterTtsModel || ''].join('|');
    }

    /** The voices of the TTS provider; the adapter asks it with the saved keys (secrets never reach the browser). */
    private async loadVoices(): Promise<void> {
        const key = this.voicesKey;
        this.setState({ voicesKey: key, voices: null });
        const f = this.form;
        let voices: string[] = [];
        try {
            const message: Record<string, string> = { ttsProvider: this.ttsProvider, language: f.voiceLanguage || '' };
            if (f.openrouterTtsModel) {
                message.openrouterTtsModel = f.openrouterTtsModel;
            }
            const res = await this.props.oContext.socket.sendTo(this.instanceId, 'getVoices', message);
            voices = Array.isArray(res) ? (res as unknown[]).map(String) : [];
        } catch {
            /* no list: the field stays a text field */
        }
        if (!this.unmounted && this.state.voicesKey === key) {
            this.setState({ voices });
        }
    }

    // ---- What the form says ------------------------------------------------------------------------------

    private get sttProvider(): string {
        return this.form.sttProvider || 'openai';
    }

    private get ttsProvider(): string {
        return this.form.ttsProvider || 'openai';
    }

    private label(list: { value: string; label: string }[], value: string): string {
        const label = list.find(o => o.value === value)?.label;
        return label ? I18n.t(label) : value;
    }

    private get languageLabel(): string {
        const lang = this.form.voiceLanguage || '';
        return lang ? this.label(LANGUAGES, lang) : I18n.t('System language');
    }

    private get localMode(): LocalMode {
        if (!this.form.useLocalNlu) {
            return 'off';
        }
        return this.form.nluEngine === 'smart-text2command' ? 't2c' : 'rules';
    }

    private get cloudMode(): CloudMode {
        const provider = this.form.provider || 'openai';
        return provider === 'none' ? 'off' : provider === 'pi-agent' ? 'pi-agent' : 'cloud';
    }

    /** The local model is asked before the cloud (or is the last step without one), else it is the reserve. */
    private get localLlmFirst(): boolean {
        return this.cloudMode === 'off' || !!this.form.localLlmFirst;
    }

    private modelName(file: string): string {
        return this.state.models?.find(m => m.file === file)?.name || file;
    }

    // ---- Diagram ------------------------------------------------------------------------------------------

    private count(...tiers: JournalTier[]): React.JSX.Element | null {
        if (!this.state.counts) {
            return null;
        }
        const n = tiers.reduce((sum, tier) => sum + (this.state.counts?.[tier] || 0), 0);
        return (
            <Typography
                variant="caption"
                sx={{ display: 'block', mt: 1, opacity: 0.7 }}
            >
                {t('%s answers in the journal', n)}
            </Typography>
        );
    }

    private renderStep(
        step: Step,
        index: number,
        title: string,
        off: boolean,
        body: React.ReactNode,
        footer?: React.ReactNode,
        warning?: string,
        reserve = false,
    ): React.JSX.Element {
        const color = STEP_COLORS[step];
        return (
            <Paper
                key={step}
                variant="outlined"
                onClick={() => this.setState({ open: step, error: '' })}
                sx={{
                    flex: reserve ? '0 0 auto' : '1 1 auto',
                    minWidth: 0,
                    p: reserve ? 1 : 1.5,
                    cursor: 'pointer',
                    borderWidth: 2,
                    borderColor: off ? 'divider' : color,
                    borderStyle: off ? 'dashed' : 'solid',
                    opacity: off ? 0.6 : 1,
                    transition: 'box-shadow 0.2s',
                    '&:hover': { boxShadow: 4, opacity: 1 },
                }}
            >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                    <Box
                        sx={{
                            width: 24,
                            height: 24,
                            borderRadius: '50%',
                            backgroundColor: off ? 'text.disabled' : color,
                            color: '#fff',
                            fontSize: 13,
                            fontWeight: 'bold',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                        }}
                    >
                        {index}
                    </Box>
                    <Typography
                        lang={I18n.getLanguage()}
                        sx={{ fontWeight: 'bold', flexGrow: 1, minWidth: 0, hyphens: 'auto' }}
                    >
                        {title}
                    </Typography>
                </Box>
                {body}
                {warning ? (
                    <Alert
                        severity="warning"
                        sx={{ mt: 1, py: 0 }}
                    >
                        {warning}
                    </Alert>
                ) : null}
                {footer}
            </Paper>
        );
    }

    /** "→" between two steps (below each other on a narrow screen), with what goes on along it. */
    private renderArrow(label: string, dashed = false): React.JSX.Element {
        return (
            <Box
                sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    px: 0.5,
                    py: { xs: 0.5, md: 0 },
                    width: { xs: 'auto', md: label ? 88 : 40 },
                    flexShrink: 0,
                    opacity: dashed ? 0.6 : 0.85,
                }}
            >
                <Typography
                    sx={{ fontSize: 28, lineHeight: 1, display: { xs: 'none', md: 'block' } }}
                    style={dashed ? { letterSpacing: -2 } : undefined}
                >
                    {dashed ? '⇢' : '→'}
                </Typography>
                <Typography sx={{ fontSize: 28, lineHeight: 1, display: { xs: 'block', md: 'none' } }}>
                    {dashed ? '⇣' : '↓'}
                </Typography>
                <Typography
                    variant="caption"
                    lang={I18n.getLanguage()}
                    sx={{ textAlign: 'center', lineHeight: 1.2, hyphens: 'auto', maxWidth: '100%' }}
                >
                    {label}
                </Typography>
            </Box>
        );
    }

    /**
     * One cell of the diagram: the arrow that leads to the step, the step, and below it the step that stands in
     * when it fails (the local model behind the cloud). A new row starts with "→ step", so it still reads as the
     * continuation of the row above.
     */
    private renderUnit(
        key: string,
        card: React.JSX.Element,
        arrow?: { label: string },
        reserve?: { label: string; card: React.JSX.Element },
    ): React.JSX.Element {
        return (
            <Box
                key={key}
                sx={{
                    display: 'flex',
                    flexDirection: { xs: 'column', md: 'row' },
                    alignItems: 'stretch',
                    minWidth: 0,
                }}
            >
                {arrow ? this.renderArrow(arrow.label) : null}
                <Box sx={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minWidth: 0 }}>
                    {card}
                    {reserve ? (
                        <>
                            <Typography
                                variant="caption"
                                sx={{ textAlign: 'center', opacity: 0.7, my: 0.5 }}
                            >
                                ⇣ {reserve.label}
                            </Typography>
                            {reserve.card}
                        </>
                    ) : null}
                </Box>
            </Box>
        );
    }

    private line(text: string, strong?: string): React.JSX.Element {
        return (
            <Typography
                variant="body2"
                sx={{ mb: 0.5 }}
            >
                {text}
                {strong ? <b style={{ overflowWrap: 'anywhere' }}> {strong}</b> : null}
            </Typography>
        );
    }

    private renderSourcesStep(index: number): React.JSX.Element {
        const f = this.form;
        const transports = [
            f.esphomeEnabled ? 'ESPHome' : '',
            f.udpServerEnabled ? 'UDP' : '',
            f.wyomingEnabled ? 'Wyoming' : '',
            'ioBroker',
        ].filter(Boolean);
        const chip = (icon: React.JSX.Element, label: string, on: boolean, tip: string): React.JSX.Element => (
            <Tooltip
                title={tip}
                key={label}
            >
                <Chip
                    size="small"
                    icon={icon}
                    label={label}
                    variant={on ? 'filled' : 'outlined'}
                    sx={{ opacity: on ? 1 : 0.5 }}
                />
            </Tooltip>
        );
        return this.renderStep(
            'sources',
            index,
            t('Request comes from'),
            false,
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                {chip(
                    <VoiceIcon />,
                    t('Voice'),
                    !!f.voiceEnabled,
                    f.voiceEnabled ? transports.join(', ') : t('Voice is off'),
                )}
                {chip(
                    <TelegramIcon />,
                    'Telegram',
                    this.state.telegram.length > 0,
                    this.state.telegram.length ? this.state.telegram.join(', ') : t('No telegram instance sends here'),
                )}
                {chip(<ChatIcon />, t('Chat'), true, t('The tab Chat of these settings'))}
                {chip(<ScriptIcon />, 'sendTo / Scripts', true, `sendTo('${this.instanceId}', 'ask', {text})`)}
            </Box>,
        );
    }

    /** "1.2 s on average (34 in the journal)" for speech recognition or output. */
    private duration(kind: 'stt' | 'tts'): React.JSX.Element | null {
        const timing = this.state.timing?.[kind];
        if (!timing?.n) {
            return null;
        }
        return (
            <Typography
                variant="caption"
                sx={{ display: 'block', mt: 1, opacity: 0.7 }}
            >
                {t('%s s on average (%s in the journal)', (timing.ms / timing.n / 1000).toFixed(1), timing.n)}
            </Typography>
        );
    }

    private caption(text: string): React.JSX.Element {
        return (
            <Typography
                variant="caption"
                sx={{ display: 'block', mt: 0.5, opacity: 0.7 }}
            >
                {text}
            </Typography>
        );
    }

    private renderSttStep(index: number): React.JSX.Element {
        const f = this.form;
        const on = !!f.voiceEnabled;
        const provider = this.sttProvider;
        const model = STT_MODEL_FIELDS[provider] ? f[STT_MODEL_FIELDS[provider].field] : '';
        const wakeLanguages = Array.isArray(f.wakeWordLanguages) ? f.wakeWordLanguages.length : 0;
        const usesVoice = provider === 'parakeet' || f.sttFallback === 'parakeet';
        const voiceInstance = bareInstance(f.parakeetInstance);
        let warning = '';
        if (on && usesVoice && !voiceInstance) {
            warning = t('No ioBroker.voice instance chosen');
        } else if (
            on &&
            usesVoice &&
            this.state.voiceInstances &&
            !this.state.voiceInstances.find(i => i.id === voiceInstance)?.alive
        ) {
            warning = t('%s is not running', voiceInstance);
        }
        return this.renderStep(
            'stt',
            index,
            t('Speech recognition'),
            !on,
            on ? (
                <>
                    {this.line(t('Provider:'), this.label(STT_PROVIDERS, provider))}
                    {model ? this.line(t('Model:'), model) : null}
                    {provider === 'openai' && f.sttBaseUrl ? this.line(t('Server:'), f.sttBaseUrl) : null}
                    {f.sttFallback ? this.line(t('Reserve:'), this.label(STT_PROVIDERS, f.sttFallback)) : null}
                    {this.line(t('Language:'), this.languageLabel)}
                    {wakeLanguages ? this.line(`${I18n.t('Language per wake word')}:`, String(wakeLanguages)) : null}
                    {this.caption(t('Text requests skip this step.'))}
                </>
            ) : (
                this.line(t('Off: only text requests'))
            ),
            on ? this.duration('stt') : null,
            warning,
        );
    }

    private renderTtsStep(index: number): React.JSX.Element {
        const f = this.form;
        const on = !!f.voiceEnabled;
        const provider = this.ttsProvider;
        const voice = VOICE_FIELDS[provider] ? f[VOICE_FIELDS[provider].field] : '';
        const model = TTS_MODEL_FIELDS[provider] ? f[TTS_MODEL_FIELDS[provider].field] : '';
        const perLanguage = Array.isArray(f.ttsVoices) ? f.ttsVoices.length : 0;
        const maxChars = f.ttsMaxChars ?? 400;
        return this.renderStep(
            'tts',
            index,
            t('Speech output'),
            !on,
            on ? (
                <>
                    {this.line(t('Provider:'), this.label(TTS_PROVIDERS, provider))}
                    {this.line(t('Voice:'), voice || t('default voice'))}
                    {model ? this.line(t('Model:'), model) : null}
                    {f.ttsFallback ? this.line(t('Reserve:'), this.label(TTS_PROVIDERS, f.ttsFallback)) : null}
                    {perLanguage ? this.line(`${I18n.t('Voice per answer language')}:`, String(perLanguage)) : null}
                    {f.confirmWithTone ? this.line(t('Switch commands: a beep')) : null}
                    {this.line(
                        Number(maxChars) > 0
                            ? t('Longest answer: %s characters', maxChars)
                            : t('Long answers are not cut'),
                    )}
                    {this.caption(t('Only answers to speech; text requests get text back.'))}
                </>
            ) : (
                this.line(t('Off: answers as text'))
            ),
            on ? this.duration('tts') : null,
        );
    }

    private renderLocalStep(index: number): React.JSX.Element {
        const mode = this.localMode;
        const routines = Array.isArray(this.form.routines) ? this.form.routines.length : 0;
        const instance = bareInstance(this.form.smartT2cInstance);
        const running = this.state.t2cInstances?.find(i => i.id === instance)?.alive;
        let warning = '';
        if (mode === 't2c' && !instance) {
            warning = t('No smart-text2command instance chosen');
        } else if (mode === 't2c' && this.state.t2cInstances && !running) {
            warning = t('%s is not running', instance);
        }
        return this.renderStep(
            'local',
            index,
            t('Local decision'),
            mode === 'off',
            <>
                {routines ? this.line(t('First the routines:'), String(routines)) : null}
                {mode === 'off' ? this.line(t('Off: everything goes to the models')) : null}
                {mode === 'rules' ? this.line(t('Built-in rules:'), t('devices, timers, alarms, time, weather')) : null}
                {mode === 't2c' ? (
                    <>
                        {this.line(t('Devices:'), instance || 'smart-text2command')}
                        {this.line(t('Built-in rules:'), t('timers, alarms, time, weather'))}
                    </>
                ) : null}
            </>,
            this.count('routine', 'nlu', 'smartT2c'),
            warning,
        );
    }

    /** The local model; as the reserve of the cloud (`reserve`) a small card below it. */
    private renderLocalLlmStep(index: number, reserve = false): React.JSX.Element {
        const on = !!this.form.useLocalLlm;
        const cloudOff = this.cloudMode === 'off';
        const model = this.form.localLlmModel ? this.modelName(this.form.localLlmModel) : t('default model');
        return this.renderStep(
            'localLlm',
            index,
            t('Local LLM'),
            !on,
            on ? (
                <>
                    {this.line(t('Model:'), model)}
                    {reserve ? null : this.line(cloudOff ? t('The last step') : t('Asked before the cloud'))}
                    {this.line(t('Gives up after:'), `${this.form.localLlmTimeoutSec || 15} s`)}
                    {!reserve && !cloudOff
                        ? this.caption(t('Follow-up questions in a conversation go straight to the cloud.'))
                        : null}
                </>
            ) : (
                this.line(t('Off'))
            ),
            this.count('localLlm'),
            undefined,
            reserve,
        );
    }

    private renderCloudStep(index: number): React.JSX.Element {
        const mode = this.cloudMode;
        const provider = this.form.provider || 'openai';
        const label = PROVIDERS.find(p => p.value === provider)?.label || provider;
        const piAgent = bareInstance(this.form.piAgentInstance);
        let warning = '';
        if (mode === 'pi-agent' && !piAgent) {
            warning = t('No pi-agent instance chosen');
        } else if (
            mode === 'pi-agent' &&
            this.state.piInstances &&
            !this.state.piInstances.find(i => i.id === piAgent)?.alive
        ) {
            warning = t('%s is not running', piAgent);
        }
        return this.renderStep(
            'cloud',
            index,
            t('Cloud LLM'),
            mode === 'off',
            mode === 'off' ? (
                <>
                    {this.line(t('Off: answers only locally'))}
                    {this.form.useLocalLlm ? null : this.caption(t('What no step understands gets a fixed sentence.'))}
                </>
            ) : mode === 'pi-agent' ? (
                <>
                    {this.line('pi-agent:', piAgent || '—')}
                    {this.line(t('with its own model, tools and permissions'))}
                </>
            ) : (
                <>
                    {this.line(t('Provider:'), I18n.t(label))}
                    {provider !== 'system' ? this.line(t('Model:'), this.form.model || t('automatic')) : null}
                    {this.line(t('with the tools of this adapter'))}
                </>
            ),
            this.count('cloud'),
            warning,
        );
    }

    private renderDiagram(): React.JSX.Element {
        const cloudOff = this.cloudMode === 'off';
        const llmOn = !!this.form.useLocalLlm;
        const voice = !!this.form.voiceEnabled;
        let i = 1;
        const units: React.JSX.Element[] = [
            this.renderUnit('sources', this.renderSourcesStep(i++)),
            this.renderUnit('stt', this.renderSttStep(i++), { label: voice ? t('speech') : '' }),
            this.renderUnit('local', this.renderLocalStep(i++), { label: voice ? t('as text') : '' }),
        ];
        if (this.localLlmFirst) {
            units.push(
                this.renderUnit('localLlm', this.renderLocalLlmStep(i++), { label: t('not understood') }),
                this.renderUnit('cloud', this.renderCloudStep(i++), {
                    label: llmOn && !cloudOff ? t('handed on') : '',
                }),
            );
        } else {
            // With a cloud step the local model is no step of the chain: it only stands in when the cloud fails
            const cloud = this.renderCloudStep(i++);
            units.push(
                this.renderUnit(
                    'cloud',
                    cloud,
                    { label: t('not understood') },
                    { label: t('only if the cloud fails'), card: this.renderLocalLlmStep(i++, true) },
                ),
            );
        }
        units.push(this.renderUnit('tts', this.renderTtsStep(i++), { label: '' }));
        return (
            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' },
                    rowGap: 2,
                }}
            >
                {units}
            </Box>
        );
    }

    // ---- Settings of a step -------------------------------------------------------------------------------

    /** A choice of a few modes as a row of buttons. */
    private renderModes<T extends string>(
        value: T,
        options: { value: T; label: string }[],
        onChange: (v: T) => void,
    ): React.JSX.Element {
        return (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
                {options.map(o => (
                    <Button
                        key={o.value}
                        variant={o.value === value ? 'contained' : 'outlined'}
                        onClick={() => onChange(o.value)}
                    >
                        {o.label}
                    </Button>
                ))}
            </Box>
        );
    }

    private renderInstanceSelect(
        label: string,
        value: string,
        list: InstanceInfo[] | null,
        onChange: (id: string) => void,
    ): React.JSX.Element {
        if (!list) {
            return <CircularProgress size={20} />;
        }
        return (
            <FormControl
                variant="standard"
                fullWidth
                sx={{ mb: 2 }}
            >
                <InputLabel>{label}</InputLabel>
                <Select
                    value={list.some(i => i.id === value) ? value : ''}
                    onChange={e => onChange(String(e.target.value))}
                >
                    {list.map(i => (
                        <MenuItem
                            key={i.id}
                            value={i.id}
                        >
                            {i.id} {i.alive ? '' : `(${t('not running')})`}
                        </MenuItem>
                    ))}
                </Select>
            </FormControl>
        );
    }

    /** Install a helper adapter on this host and choose its instance (same as the buttons on the other tabs). */
    private async install(adapter: string, field: string): Promise<void> {
        this.setState({ installing: adapter, error: '' });
        try {
            const res = (await this.props.oContext.socket.sendTo(this.instanceId, 'installAdapter', { adapter })) as
                { native?: Record<string, string>; error?: string } | undefined;
            if (res?.error) {
                throw new Error(res.error);
            }
            if (res?.native?.[field]) {
                this.set({ [field]: res.native[field] });
            }
            await this.loadInstances();
        } catch (e) {
            this.setState({ error: (e as Error).message });
        }
        this.setState({ installing: '' });
    }

    private renderInstallButton(adapter: string, field: string, name = adapter): React.JSX.Element {
        return (
            <Button
                variant="outlined"
                sx={{ mb: 2 }}
                disabled={!this.state.alive || !!this.state.installing}
                startIcon={this.state.installing === adapter ? <CircularProgress size={16} /> : undefined}
                onClick={() => void this.install(adapter, field)}
            >
                {t('Install %s', name)}
            </Button>
        );
    }

    private renderSelect(
        label: string,
        value: string,
        options: { value: string; label: string }[],
        onChange: (value: string) => void,
        helperText?: string,
    ): React.JSX.Element {
        return (
            <FormControl
                variant="standard"
                fullWidth
                sx={{ mb: 2 }}
            >
                <InputLabel>{label}</InputLabel>
                <Select
                    value={options.some(o => o.value === value) ? value : ''}
                    onChange={e => onChange(String(e.target.value))}
                >
                    {options.map(o => (
                        <MenuItem
                            key={o.value}
                            value={o.value}
                        >
                            {o.label}
                        </MenuItem>
                    ))}
                </Select>
                {helperText ? (
                    <Typography
                        variant="caption"
                        sx={{ mt: 0.5, opacity: 0.7 }}
                    >
                        {helperText}
                    </Typography>
                ) : null}
            </FormControl>
        );
    }

    private renderText(label: string, field: string, helperText?: string): React.JSX.Element {
        return (
            <TextField
                key={field}
                variant="standard"
                fullWidth
                label={label}
                helperText={helperText}
                value={this.form[field] || ''}
                onChange={e => this.set({ [field]: e.target.value })}
                sx={{ mb: 2 }}
            />
        );
    }

    private renderVoiceSwitch(): React.JSX.Element {
        return (
            <FormControlLabel
                sx={{ mb: 1 }}
                control={
                    <Switch
                        checked={!!this.form.voiceEnabled}
                        onChange={e => this.set({ voiceEnabled: e.target.checked })}
                    />
                }
                label={t('Voice satellites (speech recognition and speech output)')}
            />
        );
    }

    /** A provider list with the translated labels, optionally with "None" first (for the reserve). */
    private providerOptions(
        list: { value: string; label: string }[],
        withNone = false,
    ): { value: string; label: string }[] {
        const options = list.map(o => ({ value: o.value, label: I18n.t(o.label) }));
        return withNone ? [{ value: '', label: I18n.t('None') }, ...options] : options;
    }

    private renderSttSettings(): React.JSX.Element {
        const f = this.form;
        if (!f.voiceEnabled) {
            return (
                <>
                    {this.renderVoiceSwitch()}
                    {this.info(t('Off: only text requests'))}
                </>
            );
        }
        const provider = this.sttProvider;
        const usesVoice = provider === 'parakeet' || f.sttFallback === 'parakeet';
        const model = STT_MODEL_FIELDS[provider];
        return (
            <>
                {this.renderVoiceSwitch()}
                {this.info(
                    t(
                        'Turns the speech of the satellites into text. It also hears voice messages from Telegram and the dialog mode of the chat. Keys and more options are on the tab Voice.',
                    ),
                )}
                {this.renderSelect(
                    I18n.t('Voice language'),
                    f.voiceLanguage || '',
                    [{ value: '', label: I18n.t('System language') }, ...LANGUAGES],
                    v => this.set({ voiceLanguage: v }),
                )}
                {this.renderSelect(
                    I18n.t('Speech-to-text provider'),
                    provider,
                    this.providerOptions(STT_PROVIDERS),
                    v => this.set({ sttProvider: v }),
                )}
                {model ? this.renderText(I18n.t(model.label), model.field, t('empty = automatic')) : null}
                {provider === 'openai'
                    ? this.renderText(
                          I18n.t('Speech recognition server (optional)'),
                          'sttBaseUrl',
                          I18n.t(
                              'OpenAI-compatible server instead of OpenAI, e.g. a local Whisper: http://192.168.1.10:8000/v1 (speaches, faster-whisper-server, LocalAI). Empty = OpenAI.',
                          ),
                      )
                    : null}
                {this.renderSelect(
                    I18n.t('Speech-to-text fallback'),
                    f.sttFallback || '',
                    this.providerOptions(
                        STT_PROVIDERS.filter(o => o.value !== provider),
                        true,
                    ),
                    v => this.set({ sttFallback: v }),
                    I18n.t(
                        'Used when the provider above fails (outage, expired key, empty quota) or returns no text for speech. A local engine keeps voice working without the internet.',
                    ),
                )}
                {usesVoice ? (
                    <>
                        {this.renderInstanceSelect(
                            I18n.t('ioBroker.voice instance'),
                            bareInstance(f.parakeetInstance),
                            this.state.voiceInstances,
                            id => this.set({ parakeetInstance: id }),
                        )}
                        {this.state.voiceInstances && !this.state.voiceInstances.length
                            ? this.renderInstallButton('voice', 'parakeetInstance', 'ioBroker.voice')
                            : null}
                    </>
                ) : null}
            </>
        );
    }

    private renderTtsSettings(): React.JSX.Element {
        const f = this.form;
        if (!f.voiceEnabled) {
            return (
                <>
                    {this.renderVoiceSwitch()}
                    {this.info(t('Off: answers as text'))}
                </>
            );
        }
        const provider = this.ttsProvider;
        const voiceField = VOICE_FIELDS[provider];
        const model = TTS_MODEL_FIELDS[provider];
        // Without the running instance there is no list: then the voice is a text field
        const voices = this.state.alive ? this.state.voices : [];
        const current = voiceField ? String(f[voiceField.field] || '') : '';
        return (
            <>
                {this.renderVoiceSwitch()}
                {this.info(
                    t(
                        'Speaks the answer on the satellite that asked, and the announcements. Keys and more options are on the tab Voice.',
                    ),
                )}
                {this.renderSelect(
                    I18n.t('Text-to-speech provider'),
                    provider,
                    this.providerOptions(TTS_PROVIDERS),
                    v => this.set({ ttsProvider: v }),
                )}
                {model ? this.renderText(I18n.t(model.label), model.field, t('empty = automatic')) : null}
                {voiceField && voices?.length
                    ? this.renderSelect(
                          I18n.t(voiceField.label),
                          current,
                          [
                              { value: '', label: t('default voice') },
                              ...(current && !voices.includes(current) ? [current] : []).concat(voices).map(v => ({
                                  value: v,
                                  label: v,
                              })),
                          ],
                          v => this.set({ [voiceField.field]: v }),
                          this.languageLabel,
                      )
                    : null}
                {voiceField && voices && !voices.length
                    ? this.renderText(I18n.t(voiceField.label), voiceField.field)
                    : null}
                {voiceField && !voices ? (
                    <CircularProgress
                        size={20}
                        sx={{ mb: 2 }}
                    />
                ) : null}
                {this.renderSelect(
                    I18n.t('Text-to-speech fallback'),
                    f.ttsFallback || '',
                    this.providerOptions(
                        TTS_PROVIDERS.filter(o => o.value !== provider),
                        true,
                    ),
                    v => this.set({ ttsFallback: v }),
                    I18n.t(
                        'Used when the provider above fails. Piper keeps the assistant speaking without the internet.',
                    ),
                )}
                <TextField
                    variant="standard"
                    type="number"
                    label={I18n.t('Longest spoken answer (characters)')}
                    value={f.ttsMaxChars ?? 400}
                    onChange={e => this.set({ ttsMaxChars: Math.max(0, Number(e.target.value) || 0) })}
                    slotProps={{ htmlInput: { min: 0, max: 10000 } }}
                    sx={{ mb: 2 }}
                />
                <FormControlLabel
                    sx={{ display: 'flex', mb: 1 }}
                    control={
                        <Switch
                            checked={!!f.confirmWithTone}
                            onChange={e => this.set({ confirmWithTone: e.target.checked })}
                        />
                    }
                    label={I18n.t('Confirm switch commands with a beep')}
                />
                {Array.isArray(f.ttsVoices) && f.ttsVoices.length
                    ? this.info(`${I18n.t('Voice per answer language')}: ${f.ttsVoices.length}`)
                    : null}
            </>
        );
    }

    private info(text: string): React.JSX.Element {
        return (
            <Typography
                variant="body2"
                sx={{ mb: 2, opacity: 0.8 }}
            >
                {text}
            </Typography>
        );
    }

    private renderSourcesSettings(): React.JSX.Element {
        const f = this.form;
        return (
            <>
                <FormControlLabel
                    control={
                        <Switch
                            checked={!!f.voiceEnabled}
                            onChange={e => this.set({ voiceEnabled: e.target.checked })}
                        />
                    }
                    label={t('Voice satellites (speech recognition and speech output)')}
                />
                {f.voiceEnabled ? (
                    <Box sx={{ pl: 4, display: 'flex', flexDirection: 'column' }}>
                        {[
                            ['esphomeEnabled', 'ESPHome'],
                            ['udpServerEnabled', 'UDP'],
                            ['wyomingEnabled', 'Wyoming'],
                        ].map(([field, label]) => (
                            <FormControlLabel
                                key={field}
                                control={
                                    <Switch
                                        size="small"
                                        checked={!!f[field]}
                                        onChange={e => this.set({ [field]: e.target.checked })}
                                    />
                                }
                                label={label}
                            />
                        ))}
                        {this.info(
                            t(
                                'Satellites of the adapter assistant-satellite always work. Details on the tabs Voice and Satellites.',
                            ),
                        )}
                    </Box>
                ) : null}
                <Typography sx={{ fontWeight: 'bold', mt: 1 }}>Telegram</Typography>
                {this.info(
                    this.state.telegram.length
                        ? t('Messages of %s come here.', this.state.telegram.join(', '))
                        : t(
                              'In the settings of the telegram adapter, choose %s as the assistant instance.',
                              this.instanceId,
                          ),
                )}
                <Typography sx={{ fontWeight: 'bold' }}>{t('Chat')}</Typography>
                {this.info(t('The tab Chat of these settings, also to try out every step.'))}
                <Typography sx={{ fontWeight: 'bold' }}>sendTo / Scripts</Typography>
                {this.info(
                    t(
                        'From a script: %s, or write the question into %s.',
                        `sendTo('${this.instanceId}', 'ask', { text: '…' })`,
                        `${this.instanceId}.text.request`,
                    ),
                )}
            </>
        );
    }

    private renderLocalSettings(): React.JSX.Element {
        const mode = this.localMode;
        const routines = Array.isArray(this.form.routines) ? this.form.routines.length : 0;
        return (
            <>
                {this.renderModes<LocalMode>(
                    mode,
                    [
                        { value: 'off', label: t('Off') },
                        { value: 'rules', label: t('Built-in rules') },
                        { value: 't2c', label: 'smart-text2command' },
                    ],
                    v =>
                        this.set(
                            v === 'off'
                                ? { useLocalNlu: false }
                                : {
                                      useLocalNlu: true,
                                      nluEngine: v === 't2c' ? 'smart-text2command' : 'rules',
                                  },
                        ),
                )}
                {mode === 'off'
                    ? this.info(t('Every request goes to the models. Only the routines are still checked first.'))
                    : null}
                {mode === 'rules'
                    ? this.info(
                          t(
                              'Fixed rules understand switching, dimming and status of devices, timers, alarms, the time and the weather — in a few milliseconds, offline. What they do not understand goes on.',
                          ),
                      )
                    : null}
                {mode === 't2c' ? (
                    <>
                        {this.info(
                            t(
                                'The adapter smart-text2command learns your phrasing from examples, runs only the actions you approved there and asks back when the room or the device is unclear. It understands German and English. Timers, alarms, the time and the weather stay with the built-in rules; what neither understands goes on.',
                            ),
                        )}
                        {this.renderInstanceSelect(
                            t('smart-text2command instance'),
                            bareInstance(this.form.smartT2cInstance),
                            this.state.t2cInstances,
                            id => this.set({ smartT2cInstance: id }),
                        )}
                        {this.state.t2cInstances && !this.state.t2cInstances.length
                            ? this.renderInstallButton('smart-text2command', 'smartT2cInstance')
                            : null}
                    </>
                ) : null}
                {this.info(
                    routines
                        ? t('Before this, %s routines are checked (tab Commands).', routines)
                        : t('Routines (fixed phrases with their own actions) are set up on the tab Commands.'),
                )}
            </>
        );
    }

    private renderLocalLlmSettings(): React.JSX.Element {
        const f = this.form;
        const models = this.state.models;
        return (
            <>
                <FormControlLabel
                    sx={{ mb: 1 }}
                    control={
                        <Switch
                            checked={!!f.useLocalLlm}
                            onChange={e => this.set({ useLocalLlm: e.target.checked })}
                        />
                    }
                    label={t('Use a local LLM')}
                />
                {f.useLocalLlm ? (
                    <>
                        {models ? (
                            <FormControl
                                variant="standard"
                                fullWidth
                                sx={{ mb: 2 }}
                            >
                                <InputLabel>{t('Model')}</InputLabel>
                                <Select
                                    value={models.some(m => m.file === f.localLlmModel) ? f.localLlmModel : ''}
                                    onChange={e => this.set({ localLlmModel: String(e.target.value) })}
                                >
                                    <MenuItem value="">{t('default model')}</MenuItem>
                                    {models.map(m => (
                                        <MenuItem
                                            key={m.file}
                                            value={m.file}
                                        >
                                            {m.name}
                                        </MenuItem>
                                    ))}
                                </Select>
                            </FormControl>
                        ) : (
                            this.info(t('The list of models needs the running instance.'))
                        )}
                        <FormControlLabel
                            control={
                                <Switch
                                    checked={this.localLlmFirst}
                                    disabled={this.cloudMode === 'off'}
                                    onChange={e => this.set({ localLlmFirst: e.target.checked })}
                                />
                            }
                            label={t('Ask before the cloud')}
                        />
                        {this.info(
                            this.cloudMode === 'off'
                                ? t('Without a cloud step the local model is the last step.')
                                : this.localLlmFirst
                                  ? t(
                                        'Every request the local decision does not understand goes to it first. Saves cloud calls, but on a Raspberry Pi it adds 10–25 seconds.',
                                    )
                                  : t('It only answers when the cloud fails (offline, quota).'),
                        )}
                        <TextField
                            variant="standard"
                            type="number"
                            label={t('Gives up after (s)')}
                            value={f.localLlmTimeoutSec ?? 15}
                            onChange={e => this.set({ localLlmTimeoutSec: Number(e.target.value) || 15 })}
                            slotProps={{ htmlInput: { min: 1, max: 300 } }}
                            sx={{ mb: 2 }}
                        />
                        {this.info(t('Download and compare models on the tab Local models.'))}
                    </>
                ) : null}
            </>
        );
    }

    private renderCloudSettings(): React.JSX.Element {
        const mode = this.cloudMode;
        const provider = this.form.provider || 'openai';
        return (
            <>
                {this.renderModes<CloudMode>(
                    mode,
                    [
                        { value: 'off', label: t('Off') },
                        { value: 'cloud', label: t('AI provider') },
                        { value: 'pi-agent', label: 'pi-agent' },
                    ],
                    v =>
                        this.set({
                            provider:
                                v === 'off'
                                    ? 'none'
                                    : v === 'pi-agent'
                                      ? 'pi-agent'
                                      : PROVIDERS.some(p => p.value === provider)
                                        ? provider
                                        : 'system',
                        }),
                )}
                {mode === 'off'
                    ? this.info(
                          t('Only the local steps answer; a request they do not understand gets a fixed sentence.'),
                      )
                    : null}
                {mode === 'cloud' ? (
                    <>
                        <FormControl
                            variant="standard"
                            fullWidth
                            sx={{ mb: 2 }}
                        >
                            <InputLabel>{t('Provider')}</InputLabel>
                            <Select
                                value={provider}
                                onChange={e => this.set({ provider: String(e.target.value) })}
                            >
                                {PROVIDERS.map(p => (
                                    <MenuItem
                                        key={p.value}
                                        value={p.value}
                                    >
                                        {I18n.t(p.label)}
                                    </MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                        {provider !== 'system' ? (
                            <TextField
                                variant="standard"
                                fullWidth
                                label={t('Model')}
                                helperText={t('empty = automatic')}
                                value={this.form.model || ''}
                                onChange={e => this.set({ model: e.target.value })}
                                sx={{ mb: 2 }}
                            />
                        ) : null}
                        {this.info(
                            provider === 'system'
                                ? t('Provider, model and key come from the system settings of admin (tab AI there).')
                                : t('The API key and the other details are on the tab AI.'),
                        )}
                    </>
                ) : null}
                {mode === 'pi-agent' ? (
                    <>
                        {this.info(
                            t(
                                'The adapter pi-agent answers with its own model, tools and write permissions; every request source gets a conversation of its own there.',
                            ),
                        )}
                        {this.renderInstanceSelect(
                            t('pi-agent instance'),
                            bareInstance(this.form.piAgentInstance),
                            this.state.piInstances,
                            id => this.set({ piAgentInstance: id }),
                        )}
                        {this.state.piInstances && !this.state.piInstances.length
                            ? this.renderInstallButton('pi-agent', 'piAgentInstance')
                            : null}
                    </>
                ) : null}
            </>
        );
    }

    private renderDialog(): React.JSX.Element | null {
        const step = this.state.open;
        if (!step) {
            return null;
        }
        const titles: Record<Step, string> = {
            sources: t('Request comes from'),
            stt: t('Speech recognition'),
            local: t('Local decision'),
            localLlm: t('Local LLM'),
            cloud: t('Cloud LLM'),
            tts: t('Speech output'),
        };
        return (
            <Dialog
                open
                fullWidth
                maxWidth="sm"
                onClose={() => this.setState({ open: null })}
            >
                <DialogTitle sx={{ borderLeft: `6px solid ${STEP_COLORS[step]}` }}>{titles[step]}</DialogTitle>
                <DialogContent>
                    {this.state.error ? (
                        <Alert
                            severity="error"
                            sx={{ mb: 2 }}
                        >
                            {this.state.error}
                        </Alert>
                    ) : null}
                    {step === 'sources' ? this.renderSourcesSettings() : null}
                    {step === 'stt' ? this.renderSttSettings() : null}
                    {step === 'local' ? this.renderLocalSettings() : null}
                    {step === 'localLlm' ? this.renderLocalLlmSettings() : null}
                    {step === 'cloud' ? this.renderCloudSettings() : null}
                    {step === 'tts' ? this.renderTtsSettings() : null}
                    <Typography
                        variant="caption"
                        sx={{ display: 'block', opacity: 0.7 }}
                    >
                        {t('Changes take effect when the settings are saved.')}
                    </Typography>
                </DialogContent>
                <DialogActions>
                    <Button
                        variant="contained"
                        onClick={() => this.setState({ open: null })}
                    >
                        {t('Close')}
                    </Button>
                </DialogActions>
            </Dialog>
        );
    }

    renderItem(): React.JSX.Element {
        return (
            <Box sx={{ width: '100%' }}>
                <Typography sx={{ mb: 2 }}>
                    {t(
                        'How a request goes through the assistant. Every step answers what it understands, the rest goes on to the next one. Click a step to set it up.',
                    )}
                </Typography>
                {this.renderDiagram()}
                <Typography
                    variant="body2"
                    sx={{ mt: 3, opacity: 0.8 }}
                >
                    {t(
                        'Before every step: a stop word silences a ringing timer, the answer to an open question goes to whoever asked, and "dialog mode on/off" switches the dialog of a satellite. A request about a script or with a picture goes straight to the cloud step.',
                    )}
                </Typography>
                {this.renderDialog()}
            </Box>
        );
    }
}
