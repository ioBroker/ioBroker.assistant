import React from 'react';

import { Box, Chip, LinearProgress, Typography } from '@mui/material';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import { I18n } from '@iobroker/adapter-react-v5';

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

interface LlmProgressState extends ConfigGenericState {
    status: string;
    progress: number;
}

/** Colour for the status chip. */
const STATUS_COLOR: Record<string, 'default' | 'info' | 'success' | 'error'> = {
    ready: 'success',
    error: 'error',
    installing: 'info',
    downloading: 'info',
    loading: 'info',
};

/**
 * Shows the local-LLM install/download state from `localLlm.status` + `localLlm.progress` (so the
 * download progress is visible in the GUI instead of flooding the debug log).
 */
export default class LocalLlmProgress extends ConfigGeneric<ConfigGenericProps, LlmProgressState> {
    private statusId = '';
    private progressId = '';

    constructor(props: ConfigGenericProps) {
        super(props);
        this.state = { ...this.state, status: 'idle', progress: 0 };
    }

    private get instanceId(): string {
        const ctx = this.props.oContext;
        return `${ctx.adapterName}.${ctx.instance}`;
    }

    async componentDidMount(): Promise<void> {
        super.componentDidMount();
        this.statusId = `${this.instanceId}.localLlm.status`;
        this.progressId = `${this.instanceId}.localLlm.progress`;
        const socket = this.props.oContext.socket;
        try {
            const s = await socket.getState(this.statusId);
            const p = await socket.getState(this.progressId);
            this.setState({ status: (s?.val as string) || 'idle', progress: Number(p?.val) || 0 });
        } catch {
            /* states may not exist yet */
        }
        socket.subscribeState(this.statusId, this.onStatus);
        socket.subscribeState(this.progressId, this.onProgress);
    }

    componentWillUnmount(): void {
        const socket = this.props.oContext.socket;
        if (this.statusId) {
            socket.unsubscribeState(this.statusId, this.onStatus);
            socket.unsubscribeState(this.progressId, this.onProgress);
        }
        super.componentWillUnmount?.();
    }

    private onStatus = (_id: string, state: ioBroker.State | null | undefined): void => {
        this.setState({ status: (state?.val as string) || 'idle' });
    };

    private onProgress = (_id: string, state: ioBroker.State | null | undefined): void => {
        this.setState({ progress: Number(state?.val) || 0 });
    };

    renderItem(): React.JSX.Element | null {
        const { status, progress } = this.state;
        const busy = status === 'installing' || status === 'downloading' || status === 'loading';
        // Determinate bar only while downloading (we have a %); indeterminate for install/load steps.
        const showBar = busy;
        const determinate = status === 'downloading';
        return (
            <Box sx={{ width: '100%', mt: 0.5, mb: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                    <Typography variant="body2">{I18n.t('custom_assistant_Local model')}:</Typography>
                    <Chip
                        size="small"
                        color={STATUS_COLOR[status] || 'default'}
                        variant="outlined"
                        label={I18n.t(`custom_assistant_llm_${status}`)}
                    />
                    {determinate ? <Typography variant="body2">{Math.round(progress)}%</Typography> : null}
                </Box>
                {showBar ? (
                    <LinearProgress
                        variant={determinate ? 'determinate' : 'indeterminate'}
                        value={determinate ? progress : undefined}
                    />
                ) : null}
            </Box>
        );
    }
}
