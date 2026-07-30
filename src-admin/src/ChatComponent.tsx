import React from 'react';

import { Box, CircularProgress, IconButton, Paper, TextField, Tooltip, Typography } from '@mui/material';
import {
    Send as SendIcon,
    DeleteSweep as ClearIcon,
    Refresh as RefreshIcon,
    Mic as MicIcon,
    VolumeUp as VolumeOnIcon,
    VolumeOff as VolumeOffIcon,
    PlayArrow as PlayIcon,
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

interface ChatMessage {
    /** Who produced the message. `info` = local system notice (e.g. cache cleared), not from the LLM. */
    role: 'user' | 'assistant' | 'error' | 'info';
    text: string;
    /** ms timestamp for display. */
    ts: number;
}

interface ChatState extends ConfigGenericState {
    messages: ChatMessage[];
    input: string;
    /** True while an `ask` round-trip is in flight. */
    sending: boolean;
    alive: boolean;
    /** Mic is actively listening (Web Speech API). */
    listening: boolean;
    /** Auto-read assistant answers aloud (speechSynthesis). */
    speak: boolean;
    /** Timestamp of the message currently being fetched/played via the backend TTS (0 = none). */
    ttsPlayingTs: number;
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

/**
 * A simple chat console that sends test prompts to the running adapter instance (via the `ask`
 * sendTo command) and renders the conversation as a scrolling message list. The input is only
 * enabled while the instance is alive (`props.alive`); when the instance is stopped the component
 * shows a hint instead of the composer.
 */
export default class ChatComponent extends ConfigGeneric<ConfigGenericProps, ChatState> {
    private scrollRef = React.createRef<HTMLDivElement>();
    private aliveSubId = '';
    private recognition: SpeechRecognitionLike | null = null;

    constructor(props: ConfigGenericProps) {
        super(props);
        this.state = {
            ...this.state,
            messages: [],
            input: '',
            sending: false,
            alive: false,
            listening: false,
            speak: false,
            ttsPlayingTs: 0,
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
        }

        // Live-track the instance's alive flag so the composer enables/disables without a reload.
        this.props.oContext.socket.subscribeState(this.aliveSubId, this.onAliveChange);
    }

    componentWillUnmount(): void {
        if (this.aliveSubId) {
            this.props.oContext.socket.unsubscribeState(this.aliveSubId, this.onAliveChange);
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

    /** Start/stop browser speech recognition; the final transcript is sent as a message. */
    private toggleListening(): void {
        if (this.state.listening) {
            this.recognition?.stop();
            return;
        }
        const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
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
    private async playViaBackend(ts: number, text: string): Promise<void> {
        if (!this.ready || !text) {
            return;
        }
        this.setState({ ttsPlayingTs: ts });
        try {
            const res = (await this.props.oContext.socket.sendTo(this.instanceId, 'tts', { text })) as
                | { audio?: string; mime?: string; error?: string }
                | undefined;
            if (res?.audio) {
                const audio = new Audio(`data:${res.mime || 'audio/wav'};base64,${res.audio}`);
                audio.onended = () => this.setState({ ttsPlayingTs: 0 });
                audio.onerror = () => this.setState({ ttsPlayingTs: 0 });
                await audio.play();
            } else {
                this.setState({ ttsPlayingTs: 0 });
            }
        } catch {
            this.setState({ ttsPlayingTs: 0 });
        }
    }

    private onAliveChange = (_id: string, state: ioBroker.State | null | undefined): void => {
        const alive = !!state?.val;
        this.setState({ alive });
        if (alive) {
            void this.checkTtsAvailable(); // re-probe (a voice key may have just been saved)
        }
    };

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

    private async send(): Promise<void> {
        const text = this.state.input.trim();
        if (!text || this.state.sending || !this.ready) {
            return;
        }

        const userMsg: ChatMessage = { role: 'user', text, ts: Date.now() };
        // Functional updates so the reply appends to the list that already contains userMsg
        // (appending userMsg again in the second setState was the "message shown twice" bug).
        this.setState(prev => ({ messages: [...prev.messages, userMsg], input: '', sending: true }));
        this.scrollToBottom();

        let reply: ChatMessage;
        try {
            const res = (await this.props.oContext.socket.sendTo(this.instanceId, 'ask', { text })) as
                | { answer?: string; error?: string }
                | undefined;
            reply =
                res?.error !== undefined
                    ? { role: 'error', text: res.error, ts: Date.now() }
                    : { role: 'assistant', text: res?.answer ?? '', ts: Date.now() };
        } catch (e) {
            reply = { role: 'error', text: (e as Error).message, ts: Date.now() };
        }
        this.setState(prev => ({ messages: [...prev.messages, reply], sending: false }));
        this.scrollToBottom();
        if (this.state.speak && reply.role === 'assistant') {
            this.speak(reply.text);
        }
    }

    /** Tell the backend to drop its cached device/room/function listings (e.g. after adding a device). */
    private async refreshCache(): Promise<void> {
        if (!this.ready) {
            return;
        }
        try {
            await this.props.oContext.socket.sendTo(this.instanceId, 'clearCache', {});
            this.setState(prev => ({
                messages: [
                    ...prev.messages,
                    { role: 'info', text: I18n.t('custom_assistant_Device cache cleared.'), ts: Date.now() },
                ],
            }));
            this.scrollToBottom();
        } catch {
            /* ignore */
        }
    }

    private onKeyDown = (e: React.KeyboardEvent): void => {
        // Enter sends, Shift+Enter inserts a newline.
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void this.send();
        }
    };

    private renderMessage(msg: ChatMessage, index: number): React.JSX.Element {
        const dark = this.props.oContext.themeType === 'dark';

        if (msg.role === 'info') {
            return (
                <Typography
                    key={index}
                    variant="caption"
                    component="div"
                    sx={{ textAlign: 'center', opacity: 0.6, my: 1, fontStyle: 'italic' }}
                >
                    {msg.text}
                </Typography>
            );
        }

        const isUser = msg.role === 'user';
        const isError = msg.role === 'error';

        let bg: string;
        if (isUser) {
            bg = dark ? '#1e88e5' : '#2196f3';
        } else if (isError) {
            bg = dark ? '#5d1f1f' : '#f8d7da';
        } else {
            bg = dark ? '#3a3a3a' : '#eceff1';
        }
        const color = isUser ? '#fff' : isError ? (dark ? '#ffb4b4' : '#842029') : dark ? '#eee' : '#111';

        const time = new Date(msg.ts).toLocaleTimeString();

        return (
            <Box
                key={index}
                sx={{
                    display: 'flex',
                    justifyContent: isUser ? 'flex-end' : 'flex-start',
                    mb: 1,
                }}
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
                    <Typography
                        variant="body2"
                        component="div"
                    >
                        {msg.text}
                    </Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 0.5 }}>
                        {msg.role === 'assistant' && this.state.ttsAvailable ? (
                            <Tooltip title={I18n.t('custom_assistant_Play answer (backend TTS)')}>
                                <span>
                                    <IconButton
                                        size="small"
                                        disabled={!this.ready || this.state.ttsPlayingTs === msg.ts}
                                        onClick={() => void this.playViaBackend(msg.ts, msg.text)}
                                        sx={{ p: 0.25, color: 'inherit', opacity: 0.7 }}
                                    >
                                        {this.state.ttsPlayingTs === msg.ts ? (
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
                            {time}
                        </Typography>
                    </Box>
                </Paper>
            </Box>
        );
    }

    renderItem(): React.JSX.Element {
        const dark = this.props.oContext.themeType === 'dark';
        const { alive, messages, sending, input, listening, speak } = this.state;
        const ready = this.ready;

        return (
            <Box sx={{ width: '100%', display: 'flex', flexDirection: 'column', height: 'calc(100vh - 300px)' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                    <Typography variant="h6">{I18n.t('custom_assistant_Test chat')}</Typography>
                    <Box>
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
                                    disabled={!messages.length}
                                    onClick={() => this.setState({ messages: [] })}
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
                    {messages.length ? (
                        messages.map((m, i) => this.renderMessage(m, i))
                    ) : (
                        <Typography
                            sx={{ p: 2, textAlign: 'center', opacity: 0.6 }}
                            variant="body2"
                        >
                            {I18n.t('custom_assistant_No messages yet. Type a question below.')}
                        </Typography>
                    )}
                    {sending ? (
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
            </Box>
        );
    }
}
