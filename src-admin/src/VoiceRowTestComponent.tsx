import React from 'react';

import { CircularProgress, IconButton, Tooltip } from '@mui/material';
import { PlayArrow as PlayIcon, Stop as StopIcon } from '@mui/icons-material';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import { I18n } from '@iobroker/gui-components';

import { sampleFor } from './voiceSamples';

/** Answer of the `tts` command */
interface TtsResult {
    audio?: string;
    mime?: string;
    sampleRate?: number;
    audioMs?: number;
    ms?: number;
    error?: string;
}

interface VoiceRowTestState extends ConfigGenericState {
    alive: boolean;
    busy: boolean;
    playing: boolean;
    result: TtsResult | null;
}

/**
 * Test button in a row of the table "voice per answer language": speaks the test sentence of the row's language
 * with the settings of the form (also unsaved) and only this row of the table, and plays it in the browser.
 * In a table, `data` is the row and `globalData` the whole configuration.
 */
export default class VoiceRowTestComponent extends ConfigGeneric<ConfigGenericProps, VoiceRowTestState> {
    private aliveId = '';
    private audio: HTMLAudioElement | null = null;

    constructor(props: ConfigGenericProps) {
        super(props);
        this.state = { ...this.state, alive: false, busy: false, playing: false, result: null };
    }

    private get instanceId(): string {
        const ctx = this.props.oContext;
        return `${ctx.adapterName}.${ctx.instance}`;
    }

    private get row(): { language: string; voice: string; model: string } {
        const row = (this.props.data || {}) as Record<string, unknown>;
        return {
            language: String(row.language || '').trim(),
            voice: String(row.voice || '').trim(),
            model: String(row.model || '').trim(),
        };
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

    private test = async (): Promise<void> => {
        if (this.state.playing) {
            this.stop();
            return;
        }
        const row = this.row;
        // the whole form, but only this row: another row of the same language must not win
        const config = { ...((this.props.globalData || {}) as Record<string, unknown>), ttsVoices: [row] };
        this.setState({ busy: true, result: null });
        const result: TtsResult = await this.props.oContext.socket
            .sendTo(this.instanceId, 'tts', { text: sampleFor(row.language), language: row.language, config })
            .then(res => (res as TtsResult | undefined) || { error: I18n.t('custom_assistant_No answer') })
            .catch((e: Error) => ({ error: e.message }));
        this.setState({ busy: false, result });
        if (!result.audio) {
            return;
        }
        const audio = new Audio(`data:${result.mime || 'audio/wav'};base64,${result.audio}`);
        audio.onended = () => this.stop();
        audio.onerror = () => this.stop();
        this.audio = audio;
        this.setState({ playing: true });
        audio.play().catch(e => {
            this.stop();
            this.setState({ result: { ...result, error: (e as Error).message } });
        });
    };

    private tooltip(): string {
        const { alive, result } = this.state;
        if (!alive) {
            return I18n.t('custom_assistant_Start the instance to test the voice');
        }
        if (result?.error) {
            return result.error;
        }
        if (result?.audio) {
            const parts = [
                result.sampleRate ? `${result.sampleRate} Hz` : '',
                result.audioMs ? `${(result.audioMs / 1000).toFixed(1)} s` : '',
                result.ms ? `${I18n.t('custom_assistant_synthesis')} ${result.ms} ms` : '',
            ];
            return parts.filter(Boolean).join(' · ');
        }
        return I18n.t('custom_assistant_Try this voice');
    }

    renderItem(): React.JSX.Element {
        const { alive, busy, playing, result } = this.state;
        const disabled = !alive || busy || !this.row.language;
        return (
            <Tooltip title={this.tooltip()}>
                <span>
                    <IconButton
                        size="small"
                        disabled={disabled}
                        color={result?.error ? 'error' : 'primary'}
                        onClick={this.test}
                    >
                        {/* an error: the play button in red, the message in the tooltip */}
                        {busy ? <CircularProgress size={20} /> : playing ? <StopIcon /> : <PlayIcon />}
                    </IconButton>
                </span>
            </Tooltip>
        );
    }
}
