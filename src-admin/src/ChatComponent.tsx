import React from 'react';

import {
    Box,
    Button,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    MenuItem,
    Paper,
    Select,
    TextField,
    Tooltip,
    Typography,
} from '@mui/material';
import {
    Send as SendIcon,
    DeleteSweep as ClearIcon,
    Refresh as RefreshIcon,
    Mic as MicIcon,
    VolumeUp as VolumeOnIcon,
    VolumeOff as VolumeOffIcon,
    PlayArrow as PlayIcon,
    Info as DetailsOnIcon,
    InfoOutlined as DetailsOffIcon,
} from '@mui/icons-material';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import { I18n } from '@iobroker/gui-components';

// Register this component's translations into the shared admin I18n so the `custom_assistant_*`
// keys resolve (instance-config custom components don't auto-load admin/custom/i18n).
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

/** Local notice or an error that never reached the journal (e.g. "agent not ready"). */
interface ChatMessage {
    role: 'user' | 'assistant' | 'error' | 'info';
    text: string;
    /** ms timestamp for display. */
    ts: number;
}

/** One request as recorded by the adapter's journal (mirrors `src/lib/journal.ts`). */
interface JournalEntry {
    id: string;
    ts: number;
    done: boolean;
    ms?: number;
    source: string;
    transport: 'chat' | 'script' | 'state' | 'telegram' | 'esphome' | 'udp' | 'native' | 'wyoming';
    satellite?: string;
    room?: string;
    wakeWord?: string;
    sttMs?: number;
    question: string;
    answer?: string;
    error?: string;
    tier?: 'stop' | 'askReply' | 'routine' | 'nlu' | 'localLlm' | 'cloud' | 'none';
    detail?: string;
    tools: { name: string; args: Record<string, unknown>; ms: number; result?: string; error?: string }[];
    read: string[];
    written: { id: string; value: unknown }[];
    followUp?: boolean;
}

interface ChatState extends ConfigGenericState {
    /** Local-only messages: info notices, errors without a journal entry, and everything when the journal is off. */
    messages: ChatMessage[];
    /** Journal entries by id (live via `journal.last`). */
    entries: Record<string, JournalEntry>;
    /** null = not asked yet; false = recording disabled (journalHours 0) → plain test chat. */
    journalEnabled: boolean | null;
    /** Show tier/tools/state ids under every exchange. */
    showDetails: boolean;
    /** '' = all sources, else a {@link sourceKey}. */
    filter: string;
    confirmClear: boolean;
    input: string;
    /** True while an `ask` round-trip is in flight. */
    sending: boolean;
    alive: boolean;
    /** Mic is actively listening (Web Speech API). */
    listening: boolean;
    /** Auto-read assistant answers aloud (speechSynthesis). */
    speak: boolean;
    /** Key of the message currently being fetched/played via the backend TTS ('' = none). */
    ttsPlaying: string;
    /** Backend TTS is usable (a voice key is configured) — hides the play button when false. */
    ttsAvailable: boolean;
}

/** Minimal shape of the browser SpeechRecognition instance we use (no DOM lib types for it). */
interface SpeechRecognitionLike {
    lang: string;
    interimResults: boolean;
    continuous: boolean;
    onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
    onerror: ((e: unknown) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
}

const TRANSPORT_LABELS: Record<JournalEntry['transport'], string> = {
    chat: 'Chat',
    script: 'custom_assistant_Script',
    state: 'custom_assistant_State',
    telegram: 'Telegram',
    esphome: 'ESPHome',
    udp: 'UDP',
    native: 'ioBroker',
    wyoming: 'Wyoming',
};

const TIER_LABELS: Record<NonNullable<JournalEntry['tier']>, string> = {
    stop: 'custom_assistant_Stop word',
    askReply: 'custom_assistant_Reply to a question',
    routine: 'custom_assistant_Routine',
    nlu: 'custom_assistant_Rule-based NLU',
    localLlm: 'custom_assistant_Local LLM',
    cloud: 'custom_assistant_Cloud LLM',
    none: 'custom_assistant_Not understood',
};

const TIER_COLORS: Record<NonNullable<JournalEntry['tier']>, string> = {
    stop: '#78909c',
    askReply: '#78909c',
    routine: '#00897b',
    nlu: '#43a047',
    localLlm: '#8e24aa',
    cloud: '#1e88e5',
    none: '#e53935',
};

/** Who asked: the satellite for voice, else the source ("telegram:Max", "chat", a script name). */
function sourceKey(e: JournalEntry): string {
    return e.satellite || e.source || e.transport;
}

function formatValue(v: unknown): string {
    return typeof v === 'string' ? `"${v}"` : JSON.stringify(v);
}

function formatMs(ms: number | undefined): string {
    if (ms === undefined) {
        return '';
    }
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The chat tab: a live view of every request the assistant answered in the last hours — from this chat,
 * satellites, Telegram and scripts — with the wake word, which tier answered (rule-based NLU, routine,
 * local model, cloud model), the tool calls and the state ids read and written. The composer below sends
 * test prompts via the `ask` sendTo command; their exchange arrives through the journal like any other.
 * With the journal switched off (journalHours 0) it falls back to a plain local test chat.
 */
export default class ChatComponent extends ConfigGeneric<ConfigGenericProps, ChatState> {
    private scrollRef = React.createRef<HTMLDivElement>();
    private aliveSubId = '';
    private journalSubId = '';
    private recognition: SpeechRecognitionLike | null = null;

    constructor(props: ConfigGenericProps) {
        super(props);
        let showDetails = true;
        try {
            showDetails = window.localStorage.getItem('assistant.chat.details') !== '0';
        } catch {
            /* storage blocked */
        }
        this.state = {
            ...this.state,
            messages: [],
            entries: {},
            journalEnabled: null,
            showDetails,
            filter: '',
            confirmClear: false,
            input: '',
            sending: false,
            alive: false,
            listening: false,
            speak: false,
            ttsPlaying: '',
            ttsAvailable: false,
        };
    }

    /** Ask the backend whether TTS is usable (a voice key exists); hides the play button when not. */
    private async checkTtsAvailable(): Promise<void> {
        try {
            const res = (await this.props.oContext.socket.sendTo(this.instanceId, 'ttsAvailable', {})) as
                | { available?: boolean }
                | undefined;
            this.setState({ ttsAvailable: !!res?.available });
        } catch {
            this.setState({ ttsAvailable: false });
        }
    }

    /** Load the recorded history (all of it on first load, then only what is newer). */
    private async loadJournal(): Promise<void> {
        try {
            const res = (await this.props.oContext.socket.sendTo(this.instanceId, 'getJournal', {})) as
                | { enabled?: boolean; entries?: JournalEntry[] }
                | undefined;
            if (!res || res.enabled === undefined) {
                // An older adapter version without a journal.
                this.setState({ journalEnabled: false });
                return;
            }
            const entries: Record<string, JournalEntry> = {};
            for (const e of res.entries || []) {
                entries[e.id] = e;
            }
            this.setState(prev => ({ journalEnabled: !!res.enabled, entries: { ...entries, ...prev.entries } }));
            this.scrollToBottom();
        } catch {
            this.setState({ journalEnabled: false });
        }
    }

    /** Browser speech-to-text is available (Chrome/Edge) — and only in a secure context (https/localhost). */
    private get speechSupported(): boolean {
        const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
        return (!!w.SpeechRecognition || !!w.webkitSpeechRecognition) && window.isSecureContext;
    }

    /** Browser text-to-speech is available (works over plain http too). */
    private get ttsSupported(): boolean {
        return typeof window !== 'undefined' && 'speechSynthesis' in window;
    }

    /** Admin UI language → a BCP-47 tag for the speech APIs (e.g. 'de' → 'de-DE'). */
    private speechLang(): string {
        const map: Record<string, string> = {
            de: 'de-DE',
            en: 'en-US',
            ru: 'ru-RU',
            pt: 'pt-PT',
            nl: 'nl-NL',
            fr: 'fr-FR',
            it: 'it-IT',
            es: 'es-ES',
            pl: 'pl-PL',
            uk: 'uk-UA',
            'zh-cn': 'zh-CN',
        };
        const l = I18n.getLanguage();
        return map[l] || 'en-US';
    }

    private get instanceId(): string {
        const ctx = this.props.oContext;
        return `${ctx.adapterName}.${ctx.instance}`;
    }

    async componentDidMount(): Promise<void> {
        super.componentDidMount();
        this.aliveSubId = `system.adapter.${this.instanceId}.alive`;
        this.journalSubId = `${this.instanceId}.journal.last`;

        let alive = false;
        try {
            const st = await this.props.oContext.socket.getState(this.aliveSubId);
            alive = !!st?.val;
        } catch {
            alive = false;
        }
        this.setState({ alive });
        if (alive) {
            void this.checkTtsAvailable();
            void this.loadJournal();
        }

        // Live-track the instance's alive flag so the composer enables/disables without a reload.
        this.props.oContext.socket.subscribeState(this.aliveSubId, this.onAliveChange);
        // Every started and every finished request lands here — that is what makes the view live.
        this.props.oContext.socket.subscribeState(this.journalSubId, this.onJournalChange);
    }

    componentWillUnmount(): void {
        if (this.aliveSubId) {
            this.props.oContext.socket.unsubscribeState(this.aliveSubId, this.onAliveChange);
        }
        if (this.journalSubId) {
            this.props.oContext.socket.unsubscribeState(this.journalSubId, this.onJournalChange);
        }
        try {
            this.recognition?.stop();
        } catch {
            /* ignore */
        }
        if (this.ttsSupported) {
            window.speechSynthesis.cancel();
        }
        super.componentWillUnmount?.();
    }

    private onJournalChange = (_id: string, state: ioBroker.State | null | undefined): void => {
        if (!state?.val || typeof state.val !== 'string') {
            return;
        }
        let entry: JournalEntry;
        try {
            entry = JSON.parse(state.val) as JournalEntry;
        } catch {
            return;
        }
        if (!entry?.id) {
            return;
        }
        const stick = this.isNearBottom();
        this.setState(prev => ({ entries: { ...prev.entries, [entry.id]: entry } }));
        if (stick) {
            this.scrollToBottom();
        }
    };

    /** Start/stop browser speech recognition; the final transcript is sent as a message. */
    private toggleListening(): void {
        if (this.state.listening) {
            this.recognition?.stop();
            return;
        }
        const w = window as unknown as {
            SpeechRecognition?: new () => SpeechRecognitionLike;
            webkitSpeechRecognition?: new () => SpeechRecognitionLike;
        };
        const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
        if (!Ctor) {
            return;
        }
        const rec = new Ctor();
        rec.lang = this.speechLang();
        rec.interimResults = false;
        rec.continuous = false;
        rec.onresult = (e): void => {
            const transcript = e.results?.[0]?.[0]?.transcript || '';
            if (transcript) {
                this.setState({ input: transcript }, () => void this.send());
            }
        };
        rec.onerror = (): void => this.setState({ listening: false });
        rec.onend = (): void => this.setState({ listening: false });
        this.recognition = rec;
        this.setState({ listening: true });
        try {
            rec.start();
        } catch {
            this.setState({ listening: false });
        }
    }

    /** Speak a text aloud via the browser (cancels any ongoing utterance first). */
    private speak(text: string): void {
        if (!this.ttsSupported || !text) {
            return;
        }
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = this.speechLang();
        window.speechSynthesis.speak(u);
    }

    /** Play a text via the backend TTS engine (same voice the satellites use) — returns a WAV to play. */
    private async playViaBackend(key: string, text: string): Promise<void> {
        if (!this.ready || !text) {
            return;
        }
        this.setState({ ttsPlaying: key });
        try {
            const res = (await this.props.oContext.socket.sendTo(this.instanceId, 'tts', { text })) as
                | { audio?: string; mime?: string; error?: string }
                | undefined;
            if (res?.audio) {
                const audio = new Audio(`data:${res.mime || 'audio/wav'};base64,${res.audio}`);
                audio.onended = () => this.setState({ ttsPlaying: '' });
                audio.onerror = () => this.setState({ ttsPlaying: '' });
                await audio.play();
            } else {
                this.setState({ ttsPlaying: '' });
            }
        } catch {
            this.setState({ ttsPlaying: '' });
        }
    }

    private onAliveChange = (_id: string, state: ioBroker.State | null | undefined): void => {
        const alive = !!state?.val;
        const wasAlive = this.state.alive;
        this.setState({ alive });
        if (alive && !wasAlive) {
            void this.checkTtsAvailable(); // re-probe (a voice key may have just been saved)
            void this.loadJournal(); // the retention may have changed with the restart
        }
    };

    private isNearBottom(): boolean {
        const el = this.scrollRef.current;
        return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }

    private scrollToBottom(): void {
        // Defer to after the DOM has rendered the new message.
        setTimeout(() => {
            const el = this.scrollRef.current;
            if (el) {
                el.scrollTop = el.scrollHeight;
            }
        }, 0);
    }

    /** The chat may only talk to a running instance that reflects the *saved* config. */
    private get ready(): boolean {
        return this.state.alive && !this.props.changed;
    }

    private addMessage(msg: ChatMessage): void {
        this.setState(prev => ({ messages: [...prev.messages, msg] }));
        this.scrollToBottom();
    }

    private async send(): Promise<void> {
        const text = this.state.input.trim();
        if (!text || this.state.sending || !this.ready) {
            return;
        }
        const journal = !!this.state.journalEnabled;
        this.setState({ input: '', sending: true });
        if (!journal) {
            this.addMessage({ role: 'user', text, ts: Date.now() });
        }
        // Whatever filter is set, the user wants to see their own message.
        if (this.state.filter && this.state.filter !== 'chat') {
            this.setState({ filter: '' });
        }
        this.scrollToBottom();

        try {
            const res = (await this.props.oContext.socket.sendTo(this.instanceId, 'ask', { text })) as
                | { answer?: string; error?: string; journaled?: boolean }
                | undefined;
            // A journaled exchange shows up through `journal.last`; add only what the journal does not have.
            if (res?.error !== undefined) {
                if (!res.journaled) {
                    this.addMessage({ role: 'error', text: res.error, ts: Date.now() });
                }
            } else if (!res?.journaled) {
                this.addMessage({ role: 'assistant', text: res?.answer ?? '', ts: Date.now() });
            }
            if (this.state.speak && res?.answer) {
                this.speak(res.answer);
            }
        } catch (e) {
            this.addMessage({ role: 'error', text: (e as Error).message, ts: Date.now() });
        }
        this.setState({ sending: false });
    }

    /** Tell the backend to drop its cached device/room/function listings (e.g. after adding a device). */
    private async refreshCache(): Promise<void> {
        if (!this.ready) {
            return;
        }
        try {
            await this.props.oContext.socket.sendTo(this.instanceId, 'clearCache', {});
            this.addMessage({ role: 'info', text: I18n.t('custom_assistant_Device cache cleared.'), ts: Date.now() });
        } catch {
            /* ignore */
        }
    }

    private async clearHistory(): Promise<void> {
        this.setState({ confirmClear: false, messages: [], entries: {} });
        if (this.state.journalEnabled && this.state.alive) {
            try {
                await this.props.oContext.socket.sendTo(this.instanceId, 'clearJournal', {});
            } catch {
                /* ignore */
            }
        }
    }

    private onKeyDown = (e: React.KeyboardEvent): void => {
        // Enter sends, Shift+Enter inserts a newline.
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void this.send();
        }
    };

    private toggleDetails(): void {
        const showDetails = !this.state.showDetails;
        this.setState({ showDetails });
        try {
            window.localStorage.setItem('assistant.chat.details', showDetails ? '1' : '0');
        } catch {
            /* storage blocked */
        }
    }

    // ── rendering ───────────────────────────────────────────────────────────────────────────────────

    private bubbleColors(role: ChatMessage['role']): { bg: string; color: string } {
        const dark = this.props.oContext.themeType === 'dark';
        if (role === 'user') {
            return { bg: dark ? '#1e88e5' : '#2196f3', color: '#fff' };
        }
        if (role === 'error') {
            return { bg: dark ? '#5d1f1f' : '#f8d7da', color: dark ? '#ffb4b4' : '#842029' };
        }
        return { bg: dark ? '#3a3a3a' : '#eceff1', color: dark ? '#eee' : '#111' };
    }

    /** One chat bubble. `header` goes above the text (source chips), `footer` next to the time. */
    private renderBubble(
        key: string,
        role: ChatMessage['role'],
        text: React.ReactNode,
        ts: number,
        opts: { header?: React.ReactNode; footer?: React.ReactNode; playText?: string } = {},
    ): React.JSX.Element {
        const isUser = role === 'user';
        const { bg, color } = this.bubbleColors(role);
        return (
            <Box
                key={key}
                sx={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', mb: 0.5 }}
            >
                <Paper
                    elevation={1}
                    sx={{
                        px: 1.5,
                        py: 1,
                        maxWidth: '75%',
                        background: bg,
                        color,
                        borderRadius: 2,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                    }}
                >
                    {opts.header}
                    <Typography
                        variant="body2"
                        component="div"
                    >
                        {text}
                    </Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 0.5 }}>
                        {opts.footer}
                        {opts.playText && this.state.ttsAvailable ? (
                            <Tooltip title={I18n.t('custom_assistant_Play answer (backend TTS)')}>
                                <span>
                                    <IconButton
                                        size="small"
                                        disabled={!this.ready || this.state.ttsPlaying === key}
                                        onClick={() => void this.playViaBackend(key, opts.playText || '')}
                                        sx={{ p: 0.25, color: 'inherit', opacity: 0.7 }}
                                    >
                                        {this.state.ttsPlaying === key ? (
                                            <CircularProgress size={12} />
                                        ) : (
                                            <PlayIcon sx={{ fontSize: '0.9rem' }} />
                                        )}
                                    </IconButton>
                                </span>
                            </Tooltip>
                        ) : null}
                        <Typography
                            variant="caption"
                            component="div"
                            sx={{ opacity: 0.6, fontSize: '0.65rem' }}
                        >
                            {new Date(ts).toLocaleTimeString()}
                        </Typography>
                    </Box>
                </Paper>
            </Box>
        );
    }

    private renderMessage(msg: ChatMessage, index: number): React.JSX.Element {
        if (msg.role === 'info') {
            return (
                <Typography
                    key={`m${index}`}
                    variant="caption"
                    component="div"
                    sx={{ textAlign: 'center', opacity: 0.6, my: 1, fontStyle: 'italic' }}
                >
                    {msg.text}
                </Typography>
            );
        }
        return this.renderBubble(`m${index}`, msg.role, msg.text, msg.ts, {
            playText: msg.role === 'assistant' ? msg.text : undefined,
        });
    }

    private chip(label: string, title?: string, color?: string): React.JSX.Element {
        const el = (
            <Chip
                size="small"
                label={label}
                sx={{
                    height: 18,
                    fontSize: '0.68rem',
                    mr: 0.5,
                    color: color ? '#fff' : 'inherit',
                    background: color || 'rgba(127,127,127,0.25)',
                    '& .MuiChip-label': { px: 0.75 },
                }}
            />
        );
        return title ? (
            <Tooltip
                key={label}
                title={title}
            >
                {el}
            </Tooltip>
        ) : (
            <React.Fragment key={label}>{el}</React.Fragment>
        );
    }

    /** Origin line above the question: transport, satellite/source, room, wake word. */
    private renderOrigin(e: JournalEntry): React.JSX.Element {
        const chips: React.JSX.Element[] = [this.chip(I18n.t(TRANSPORT_LABELS[e.transport] || e.transport))];
        const who = e.satellite || (e.transport === 'chat' || e.transport === 'state' ? '' : e.source);
        if (who) {
            chips.push(this.chip(who, I18n.t('custom_assistant_Source')));
        }
        if (e.room && e.room !== who) {
            chips.push(this.chip(e.room, I18n.t('custom_assistant_Room')));
        }
        if (e.wakeWord !== undefined) {
            chips.push(
                e.wakeWord
                    ? this.chip(`🎙 ${e.wakeWord}`, I18n.t('custom_assistant_Wake word'))
                    : this.chip(`🎙 ${I18n.t('custom_assistant_follow-up')}`, I18n.t('custom_assistant_Mic re-opened without wake word')),
            );
        }
        if (e.sttMs !== undefined) {
            chips.push(this.chip(`STT ${formatMs(e.sttMs)}`, I18n.t('custom_assistant_Speech recognition time')));
        }
        return <Box sx={{ mb: 0.5, opacity: 0.9 }}>{chips}</Box>;
    }

    /** What happened between question and answer: tier, model, tools, state ids. */
    private renderDetails(e: JournalEntry): React.JSX.Element | null {
        if (!this.state.showDetails) {
            return null;
        }
        const mono = { fontFamily: 'monospace', fontSize: '0.72rem' };
        const lines: React.JSX.Element[] = [];
        for (const [i, t] of e.tools.entries()) {
            lines.push(
                <Box
                    key={`t${i}`}
                    sx={{ ...mono, color: t.error ? 'error.main' : undefined }}
                >
                    🔧 {t.name}({JSON.stringify(t.args)}) → {t.error ? `⚠ ${t.error}` : t.result} {''}
                    <span style={{ opacity: 0.6 }}>{formatMs(t.ms)}</span>
                </Box>,
            );
        }
        if (e.read.length) {
            lines.push(
                <Box
                    key="r"
                    sx={mono}
                >
                    📖 {e.read.join(', ')}
                </Box>,
            );
        }
        for (const [i, w] of e.written.entries()) {
            lines.push(
                <Box
                    key={`w${i}`}
                    sx={mono}
                >
                    ✏️ {w.id} = {formatValue(w.value)}
                </Box>,
            );
        }
        return (
            <Box sx={{ ml: 1, mb: 1.5, pl: 1, borderLeft: '2px solid rgba(127,127,127,0.35)', opacity: 0.85 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.25 }}>
                    {e.tier ? this.chip(I18n.t(TIER_LABELS[e.tier]), undefined, TIER_COLORS[e.tier]) : null}
                    {e.detail ? (
                        <Typography
                            variant="caption"
                            sx={{ ...mono, mr: 1 }}
                        >
                            {e.detail}
                        </Typography>
                    ) : null}
                    {e.done ? (
                        <Typography
                            variant="caption"
                            sx={{ opacity: 0.7 }}
                        >
                            {formatMs(e.ms)}
                        </Typography>
                    ) : null}
                    {e.followUp ? this.chip(I18n.t('custom_assistant_waits for reply')) : null}
                </Box>
                {lines}
            </Box>
        );
    }

    private renderEntry(e: JournalEntry): React.JSX.Element {
        let answer: React.JSX.Element;
        if (!e.done) {
            answer = (
                <Box
                    key={`${e.id}a`}
                    sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1, opacity: 0.7 }}
                >
                    <CircularProgress size={16} />
                    <Typography variant="body2">{I18n.t('custom_assistant_Thinking…')}</Typography>
                </Box>
            );
        } else if (e.error) {
            answer = this.renderBubble(`${e.id}a`, 'error', e.error, e.ts + (e.ms || 0));
        } else {
            answer = this.renderBubble(
                `${e.id}a`,
                'assistant',
                e.answer || (
                    <i style={{ opacity: 0.6 }}>{I18n.t('custom_assistant_(no spoken answer)')}</i>
                ),
                e.ts + (e.ms || 0),
                { playText: e.answer || undefined },
            );
        }
        return (
            <React.Fragment key={e.id}>
                {this.renderBubble(`${e.id}q`, 'user', e.question, e.ts, { header: this.renderOrigin(e) })}
                {answer}
                {this.renderDetails(e)}
            </React.Fragment>
        );
    }

    /** Journal entries and local messages merged by time, filtered by source. */
    private renderTimeline(): React.JSX.Element[] {
        const { entries, messages, filter } = this.state;
        const items: { ts: number; el: () => React.JSX.Element }[] = [];
        for (const e of Object.values(entries)) {
            if (!filter || sourceKey(e) === filter) {
                items.push({ ts: e.ts, el: () => this.renderEntry(e) });
            }
        }
        // Local messages belong to this chat.
        if (!filter || filter === 'chat') {
            messages.forEach((m, i) => items.push({ ts: m.ts, el: () => this.renderMessage(m, i) }));
        }
        items.sort((a, b) => a.ts - b.ts);
        return items.map(i => i.el());
    }

    private renderFilter(): React.JSX.Element | null {
        const keys = [...new Set(Object.values(this.state.entries).map(sourceKey))].sort();
        if (!this.state.journalEnabled || keys.length < 2) {
            return null;
        }
        return (
            <Select
                size="small"
                variant="standard"
                value={keys.includes(this.state.filter) ? this.state.filter : ''}
                displayEmpty
                onChange={e => this.setState({ filter: String(e.target.value) })}
                sx={{ mr: 1, minWidth: 140, fontSize: '0.85rem' }}
            >
                <MenuItem value="">{I18n.t('custom_assistant_All sources')}</MenuItem>
                {keys.map(k => (
                    <MenuItem
                        key={k}
                        value={k}
                    >
                        {k}
                    </MenuItem>
                ))}
            </Select>
        );
    }

    renderItem(): React.JSX.Element {
        const dark = this.props.oContext.themeType === 'dark';
        const { alive, messages, entries, sending, input, listening, speak, journalEnabled, showDetails } =
            this.state;
        const ready = this.ready;
        const timeline = this.renderTimeline();
        const empty = !messages.length && !Object.keys(entries).length;

        return (
            <Box sx={{ width: '100%', display: 'flex', flexDirection: 'column', height: 'calc(100vh - 300px)' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                    <Box>
                        <Typography variant="h6">{I18n.t(journalEnabled ? 'custom_assistant_Chat' : 'custom_assistant_Test chat')}</Typography>
                        {journalEnabled ? (
                            <Typography
                                variant="caption"
                                sx={{ opacity: 0.7 }}
                            >
                                {I18n.t('custom_assistant_Shows all requests live: satellites, Telegram, scripts and this chat.')}
                            </Typography>
                        ) : null}
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center' }}>
                        {this.renderFilter()}
                        {journalEnabled ? (
                            <Tooltip
                                title={I18n.t(
                                    showDetails
                                        ? 'custom_assistant_Hide processing details'
                                        : 'custom_assistant_Show processing details',
                                )}
                            >
                                <IconButton
                                    size="small"
                                    color={showDetails ? 'primary' : 'default'}
                                    onClick={() => this.toggleDetails()}
                                >
                                    {showDetails ? <DetailsOnIcon /> : <DetailsOffIcon />}
                                </IconButton>
                            </Tooltip>
                        ) : null}
                        {this.ttsSupported ? (
                            <Tooltip
                                title={I18n.t(
                                    speak
                                        ? 'custom_assistant_Stop reading answers aloud'
                                        : 'custom_assistant_Read answers aloud',
                                )}
                            >
                                <IconButton
                                    size="small"
                                    color={speak ? 'primary' : 'default'}
                                    onClick={() => {
                                        if (speak) {
                                            window.speechSynthesis.cancel();
                                        }
                                        this.setState({ speak: !speak });
                                    }}
                                >
                                    {speak ? <VolumeOnIcon /> : <VolumeOffIcon />}
                                </IconButton>
                            </Tooltip>
                        ) : null}
                        <Tooltip title={I18n.t('custom_assistant_Refresh device cache')}>
                            <span>
                                <IconButton
                                    size="small"
                                    disabled={!ready}
                                    onClick={() => void this.refreshCache()}
                                >
                                    <RefreshIcon />
                                </IconButton>
                            </span>
                        </Tooltip>
                        <Tooltip title={I18n.t('custom_assistant_Clear chat')}>
                            <span>
                                <IconButton
                                    size="small"
                                    disabled={empty}
                                    onClick={() =>
                                        journalEnabled ? this.setState({ confirmClear: true }) : void this.clearHistory()
                                    }
                                >
                                    <ClearIcon />
                                </IconButton>
                            </span>
                        </Tooltip>
                    </Box>
                </Box>

                {!ready ? (
                    <Typography
                        sx={{ p: 2 }}
                        color="warning.main"
                    >
                        {!alive
                            ? I18n.t('custom_assistant_Start the assistant instance to chat.')
                            : I18n.t(
                                  'custom_assistant_Save the configuration (the instance will restart) before chatting.',
                              )}
                    </Typography>
                ) : null}

                <Box
                    ref={this.scrollRef}
                    sx={{
                        flex: 1,
                        overflowY: 'auto',
                        p: 1,
                        border: `1px solid ${dark ? '#444' : '#ccc'}`,
                        borderRadius: 1,
                        background: dark ? '#1e1e1e' : '#fafafa',
                        mb: 1,
                    }}
                >
                    {timeline.length ? (
                        timeline
                    ) : (
                        <Typography
                            sx={{ p: 2, textAlign: 'center', opacity: 0.6 }}
                            variant="body2"
                        >
                            {I18n.t('custom_assistant_No messages yet. Type a question below.')}
                        </Typography>
                    )}
                    {sending && !journalEnabled ? (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1, opacity: 0.7 }}>
                            <CircularProgress size={16} />
                            <Typography variant="body2">{I18n.t('custom_assistant_Thinking…')}</Typography>
                        </Box>
                    ) : null}
                </Box>

                <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 1 }}>
                    {this.speechSupported ? (
                        <Tooltip
                            title={I18n.t(
                                listening ? 'custom_assistant_Stop listening' : 'custom_assistant_Speak',
                            )}
                        >
                            <span>
                                <IconButton
                                    color={listening ? 'error' : 'primary'}
                                    disabled={!ready || sending}
                                    onClick={() => this.toggleListening()}
                                >
                                    <MicIcon />
                                </IconButton>
                            </span>
                        </Tooltip>
                    ) : null}
                    <TextField
                        fullWidth
                        multiline
                        maxRows={4}
                        size="small"
                        variant="outlined"
                        placeholder={I18n.t(
                            listening ? 'custom_assistant_Listening…' : 'custom_assistant_Type a message…',
                        )}
                        value={input}
                        disabled={!ready || sending}
                        onChange={e => this.setState({ input: e.target.value })}
                        onKeyDown={this.onKeyDown}
                    />
                    <IconButton
                        color="primary"
                        disabled={!ready || sending || !input.trim()}
                        onClick={() => void this.send()}
                    >
                        <SendIcon />
                    </IconButton>
                </Box>

                <Dialog
                    open={this.state.confirmClear}
                    onClose={() => this.setState({ confirmClear: false })}
                >
                    <DialogTitle>{I18n.t('custom_assistant_Clear chat')}</DialogTitle>
                    <DialogContent>
                        <Typography variant="body2">
                            {I18n.t('custom_assistant_Delete the recorded history of all sources?')}
                        </Typography>
                    </DialogContent>
                    <DialogActions>
                        <Button
                            color="error"
                            variant="contained"
                            onClick={() => void this.clearHistory()}
                        >
                            {I18n.t('custom_assistant_Delete')}
                        </Button>
                        <Button onClick={() => this.setState({ confirmClear: false })}>
                            {I18n.t('custom_assistant_Cancel')}
                        </Button>
                    </DialogActions>
                </Dialog>
            </Box>
        );
    }
}
