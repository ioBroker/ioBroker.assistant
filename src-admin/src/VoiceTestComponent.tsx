import React from 'react';

import { Box, Button, CircularProgress, TextField, Typography } from '@mui/material';
import {
    Mic as MicIcon,
    PlayArrow as PlayIcon,
    Repeat as RoundTripIcon,
    Stop as StopIcon,
    UploadFile as FileIcon,
} from '@mui/icons-material';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import { I18n } from '@iobroker/gui-components';

// Register this component's translations into the shared admin I18n.
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

/** Answer of the `tts` command */
interface TtsResult {
    audio?: string;
    mime?: string;
    sampleRate?: number;
    audioMs?: number;
    ms?: number;
    error?: string;
}

/** Answer of the `stt` command, plus what was spoken for the round trip */
interface SttResult {
    text?: string;
    spoken?: string;
    audioMs?: number;
    ms?: number;
    error?: string;
}

type SttBusy = '' | 'record' | 'file' | 'roundTrip';

interface VoiceTestState extends ConfigGenericState {
    alive: boolean;
    text: string;
    busy: boolean;
    playing: boolean;
    result: TtsResult | null;
    sttBusy: SttBusy;
    recording: boolean;
    sttResult: SttResult | null;
}

/** Sentence to try a voice with, in the voice language */
const SAMPLES: Record<string, string> = {
    de: 'Hallo, ich bin dein ioBroker-Assistent. Im Wohnzimmer sind es 21,5 Grad.',
    en: "Hello, I'm your ioBroker assistant. It is 21.5 degrees in the living room.",
    ru: 'Привет, я твой ассистент ioBroker. В гостиной 21,5 градуса.',
    fr: 'Bonjour, je suis ton assistant ioBroker. Il fait 21,5 degrés dans le salon.',
    it: 'Ciao, sono il tuo assistente ioBroker. In soggiorno ci sono 21,5 gradi.',
    es: 'Hola, soy tu asistente de ioBroker. En el salón hace 21,5 grados.',
    nl: 'Hallo, ik ben je ioBroker-assistent. In de woonkamer is het 21,5 graden.',
    pl: 'Cześć, jestem twoim asystentem ioBroker. W salonie jest 21,5 stopnia.',
    pt: 'Olá, sou o teu assistente ioBroker. Na sala estão 21,5 graus.',
    uk: 'Привіт, я твій асистент ioBroker. У вітальні 21,5 градуса.',
    'zh-cn': '你好，我是你的 ioBroker 助手。客厅现在是 21.5 度。',
};

/** Rate of the recordings sent to speech recognition (what the satellites send, too) */
const RECORD_RATE = 16000;
/** A recording stops by itself after this */
const MAX_RECORD_MS = 15000;

/** Mono float samples → 16-bit WAV at {@link RECORD_RATE} (linear resampling is plenty for speech) */
function toWav(chunks: Float32Array[], rate: number): Uint8Array {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const input = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) {
        input.set(c, offset);
        offset += c.length;
    }
    const ratio = rate / RECORD_RATE;
    const length = Math.floor(total / ratio);
    const wav = new DataView(new ArrayBuffer(44 + length * 2));
    const text = (at: number, s: string): void => [...s].forEach((ch, i) => wav.setUint8(at + i, ch.charCodeAt(0)));
    text(0, 'RIFF');
    wav.setUint32(4, 36 + length * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    wav.setUint32(16, 16, true);
    wav.setUint16(20, 1, true);
    wav.setUint16(22, 1, true);
    wav.setUint32(24, RECORD_RATE, true);
    wav.setUint32(28, RECORD_RATE * 2, true);
    wav.setUint16(32, 2, true);
    wav.setUint16(34, 16, true);
    text(36, 'data');
    wav.setUint32(40, length * 2, true);
    for (let i = 0; i < length; i++) {
        const pos = i * ratio;
        const j = Math.floor(pos);
        const v = input[j] + ((input[j + 1] ?? input[j]) - input[j]) * (pos - j);
        wav.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true);
    }
    return new Uint8Array(wav.buffer);
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

/**
 * Voice test on the Voice tab, with the settings as they are in the form — also unsaved:
 *  - speech output: speaks a sentence and plays it in the browser, with sample rate, length of the audio and
 *    synthesis time, so a wrong rate (voice too high or too low) or a slow model is visible at once;
 *  - speech recognition: a recording of the browser microphone (only over https or on localhost, where
 *    browsers allow it), an audio file, or the round trip "speak the test sentence and recognize it", which
 *    needs no microphone at all.
 */
export default class VoiceTestComponent extends ConfigGeneric<ConfigGenericProps, VoiceTestState> {
    private aliveId = '';
    private audio: HTMLAudioElement | null = null;
    private recorder: {
        context: AudioContext;
        stream: MediaStream;
        node: ScriptProcessorNode;
        chunks: Float32Array[];
        timer: ReturnType<typeof setTimeout>;
    } | null = null;
    private fileInput: HTMLInputElement | null = null;

    constructor(props: ConfigGenericProps) {
        super(props);
        this.state = {
            ...this.state,
            alive: false,
            text: '',
            busy: false,
            playing: false,
            result: null,
            sttBusy: '',
            recording: false,
            sttResult: null,
        };
    }

    private get instanceId(): string {
        const ctx = this.props.oContext;
        return `${ctx.adapterName}.${ctx.instance}`;
    }

    private get language(): string {
        const data = this.props.data as Record<string, unknown>;
        return String(data.voiceLanguage || I18n.getLanguage() || 'en');
    }

    private get sentence(): string {
        return this.state.text.trim() || SAMPLES[this.language] || SAMPLES.en;
    }

    async componentDidMount(): Promise<void> {
        super.componentDidMount();
        this.aliveId = `system.adapter.${this.instanceId}.alive`;
        const socket = this.props.oContext.socket;
        try {
            const state = await socket.getState(this.aliveId);
            this.setState({ alive: !!state?.val });
        } catch {
            /* not running */
        }
        socket.subscribeState(this.aliveId, this.onAlive);
    }

    componentWillUnmount(): void {
        if (this.aliveId) {
            this.props.oContext.socket.unsubscribeState(this.aliveId, this.onAlive);
        }
        this.stop();
        this.closeRecorder();
        super.componentWillUnmount?.();
    }

    private onAlive = (_id: string, state: ioBroker.State | null | undefined): void => {
        this.setState({ alive: !!state?.val });
    };

    private stop(): void {
        if (this.audio) {
            this.audio.pause();
            this.audio = null;
        }
        if (this.state.playing) {
            this.setState({ playing: false });
        }
    }

    /** Speak with the settings of the form; the backend takes the speech fields of `config` */
    private synthesize(text: string): Promise<TtsResult> {
        return this.props.oContext.socket
            .sendTo(this.instanceId, 'tts', { text, language: this.language, config: this.props.data })
            .then(res => (res as TtsResult | undefined) || { error: I18n.t('custom_assistant_No answer') })
            .catch((e: Error) => ({ error: e.message }));
    }

    private transcribe(audio: string, format: string): Promise<SttResult> {
        return this.props.oContext.socket
            .sendTo(this.instanceId, 'stt', { audio, format, language: this.language, config: this.props.data })
            .then(res => (res as SttResult | undefined) || { error: I18n.t('custom_assistant_No answer') })
            .catch((e: Error) => ({ error: e.message }));
    }

    private test = async (): Promise<void> => {
        this.stop();
        this.setState({ busy: true, result: null });
        const result = await this.synthesize(this.sentence);
        this.setState({ busy: false, result });
        if (result.audio) {
            this.play(result);
        }
    };

    private play(result: TtsResult): void {
        const audio = new Audio(`data:${result.mime || 'audio/wav'};base64,${result.audio}`);
        audio.onended = () => this.stop();
        audio.onerror = () => this.stop();
        this.audio = audio;
        this.setState({ playing: true });
        audio.play().catch(e => {
            this.stop();
            this.setState({ result: { ...result, error: (e as Error).message } });
        });
    }

    /** Speak the test sentence, then recognize what was spoken: tests both engines without a microphone */
    private roundTrip = async (): Promise<void> => {
        const spoken = this.sentence;
        this.setState({ sttBusy: 'roundTrip', sttResult: null });
        const tts = await this.synthesize(spoken);
        if (!tts.audio) {
            this.setState({ sttBusy: '', sttResult: { error: tts.error || I18n.t('custom_assistant_No answer') } });
            return;
        }
        const stt = await this.transcribe(tts.audio, 'wav');
        this.setState({ sttBusy: '', sttResult: { ...stt, spoken } });
    };

    private startRecording = async (): Promise<void> => {
        this.setState({ sttResult: null });
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const context = new AudioContext();
            const source = context.createMediaStreamSource(stream);
            // ScriptProcessor: deprecated, but everywhere available and enough for a few seconds of test audio
            const node = context.createScriptProcessor(4096, 1, 1);
            const chunks: Float32Array[] = [];
            node.onaudioprocess = e => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
            source.connect(node);
            node.connect(context.destination);
            const timer = setTimeout(() => void this.stopRecording(), MAX_RECORD_MS);
            this.recorder = { context, stream, node, chunks, timer };
            this.setState({ recording: true });
        } catch (e) {
            this.setState({ sttResult: { error: (e as Error).message } });
        }
    };

    private closeRecorder(): { chunks: Float32Array[]; rate: number } | null {
        const rec = this.recorder;
        if (!rec) {
            return null;
        }
        this.recorder = null;
        clearTimeout(rec.timer);
        rec.node.disconnect();
        rec.stream.getTracks().forEach(track => track.stop());
        const rate = rec.context.sampleRate;
        void rec.context.close();
        return { chunks: rec.chunks, rate };
    }

    private stopRecording = async (): Promise<void> => {
        const rec = this.closeRecorder();
        this.setState({ recording: false });
        if (!rec?.chunks.length) {
            return;
        }
        this.setState({ sttBusy: 'record' });
        const result = await this.transcribe(toBase64(toWav(rec.chunks, rec.rate)), 'wav');
        this.setState({ sttBusy: '', sttResult: result });
    };

    private onFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) {
            return;
        }
        this.setState({ sttBusy: 'file', sttResult: null });
        const bytes = new Uint8Array(await file.arrayBuffer());
        const format = (file.name.split('.').pop() || '').toLowerCase();
        const result = await this.transcribe(toBase64(bytes), format);
        this.setState({ sttBusy: '', sttResult: result });
    };

    private renderTtsResult(): React.JSX.Element | null {
        const result = this.state.result;
        if (!result) {
            return null;
        }
        if (result.error) {
            return (
                <Typography
                    variant="body2"
                    color="error"
                    sx={{ wordBreak: 'break-word' }}
                >
                    {result.error}
                </Typography>
            );
        }
        const parts = [
            result.sampleRate ? `${result.sampleRate} Hz` : '',
            result.audioMs !== undefined
                ? I18n.t('custom_assistant_%s s audio', (result.audioMs / 1000).toFixed(1))
                : '',
            result.ms !== undefined ? I18n.t('custom_assistant_made in %s ms', result.ms) : '',
        ].filter(Boolean);
        return (
            <Typography
                variant="body2"
                sx={{ opacity: 0.7 }}
            >
                {parts.join(' · ')}
            </Typography>
        );
    }

    private renderSttResult(): React.JSX.Element | null {
        const result = this.state.sttResult;
        if (!result) {
            return null;
        }
        if (result.error) {
            return (
                <Typography
                    variant="body2"
                    color="error"
                    sx={{ wordBreak: 'break-word' }}
                >
                    {result.error}
                </Typography>
            );
        }
        const parts = [
            result.audioMs !== undefined
                ? I18n.t('custom_assistant_%s s audio', (result.audioMs / 1000).toFixed(1))
                : '',
            result.ms !== undefined ? I18n.t('custom_assistant_recognized in %s ms', result.ms) : '',
        ].filter(Boolean);
        return (
            <Box>
                {result.spoken ? (
                    <Typography variant="body2">
                        {I18n.t('custom_assistant_Spoken')}: „{result.spoken}“
                    </Typography>
                ) : null}
                <Typography variant="body2">
                    {I18n.t('custom_assistant_Recognized')}:{' '}
                    {result.text ? `„${result.text}“` : <i>{I18n.t('custom_assistant_Nothing recognized')}</i>}
                </Typography>
                <Typography
                    variant="body2"
                    sx={{ opacity: 0.7 }}
                >
                    {parts.join(' · ')}
                </Typography>
            </Box>
        );
    }

    renderItem(): React.JSX.Element | null {
        const { alive, busy, playing, text, sttBusy, recording } = this.state;
        // browsers only hand out the microphone in a secure context
        const micAllowed = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
        const sttDisabled = !alive || !!sttBusy;
        const spinner = (kind: SttBusy, icon: React.JSX.Element): React.JSX.Element =>
            sttBusy === kind ? <CircularProgress size={16} /> : icon;
        return (
            <Box sx={{ width: '100%', mt: 1, mb: 1 }}>
                <Typography
                    variant="subtitle2"
                    sx={{ mb: 0.5 }}
                >
                    {I18n.t('custom_assistant_Speech output')}
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <TextField
                        variant="standard"
                        fullWidth
                        value={text}
                        placeholder={SAMPLES[this.language] || SAMPLES.en}
                        label={I18n.t('custom_assistant_Test sentence')}
                        onChange={e => this.setState({ text: e.target.value })}
                        onKeyDown={e => {
                            if (e.key === 'Enter' && alive && !busy) {
                                void this.test();
                            }
                        }}
                    />
                    <Button
                        variant="contained"
                        sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                        disabled={!alive || busy}
                        startIcon={busy ? <CircularProgress size={16} /> : playing ? <StopIcon /> : <PlayIcon />}
                        onClick={() => (playing ? this.stop() : void this.test())}
                    >
                        {I18n.t(playing ? 'custom_assistant_Stop' : 'custom_assistant_Test voice')}
                    </Button>
                </Box>
                <Box sx={{ mt: 0.5 }}>{this.renderTtsResult()}</Box>

                <Typography
                    variant="subtitle2"
                    sx={{ mt: 2, mb: 0.5 }}
                >
                    {I18n.t('custom_assistant_Speech recognition')}
                </Typography>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                    {micAllowed ? (
                        <Button
                            variant={recording ? 'contained' : 'outlined'}
                            color={recording ? 'error' : 'primary'}
                            disabled={!alive || (!!sttBusy && !recording)}
                            startIcon={spinner('record', recording ? <StopIcon /> : <MicIcon />)}
                            onClick={() => void (recording ? this.stopRecording() : this.startRecording())}
                        >
                            {I18n.t(recording ? 'custom_assistant_Stop' : 'custom_assistant_Record')}
                        </Button>
                    ) : null}
                    <Button
                        variant="outlined"
                        disabled={sttDisabled || recording}
                        startIcon={spinner('file', <FileIcon />)}
                        onClick={() => this.fileInput?.click()}
                    >
                        {I18n.t('custom_assistant_Audio file')}
                    </Button>
                    <Button
                        variant="outlined"
                        disabled={sttDisabled || recording}
                        startIcon={spinner('roundTrip', <RoundTripIcon />)}
                        onClick={() => void this.roundTrip()}
                    >
                        {I18n.t('custom_assistant_Speak the test sentence and recognize it')}
                    </Button>
                    <input
                        ref={el => {
                            this.fileInput = el;
                        }}
                        type="file"
                        accept="audio/*"
                        style={{ display: 'none' }}
                        onChange={e => void this.onFile(e)}
                    />
                </Box>
                {!micAllowed ? (
                    <Typography
                        variant="body2"
                        sx={{ opacity: 0.7, mt: 0.5 }}
                    >
                        {I18n.t('custom_assistant_The microphone only works over https or on localhost.')}
                    </Typography>
                ) : null}
                <Box sx={{ mt: 0.5 }}>{this.renderSttResult()}</Box>

                {!alive ? (
                    <Typography
                        variant="body2"
                        sx={{ opacity: 0.7, mt: 1 }}
                    >
                        {I18n.t('custom_assistant_The instance must be running to test the voice.')}
                    </Typography>
                ) : null}
            </Box>
        );
    }
}
