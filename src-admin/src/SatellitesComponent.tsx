import React from 'react';

import {
    Box,
    Chip,
    IconButton,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableRow,
    TextField,
    Tooltip,
    Typography,
} from '@mui/material';
import { Campaign as AnnounceIcon, Circle as DotIcon } from '@mui/icons-material';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import { I18n } from '@iobroker/adapter-react-v5';

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

interface SatRow {
    status: string;
    room: string;
    alive: boolean;
    lastSeen: number;
}

interface SatellitesState extends ConfigGenericState {
    /** satellite state-id → its live values. */
    sats: Record<string, SatRow>;
    /** per-satellite (and '__all__') announcement composer text. */
    speak: Record<string, string>;
}

/** Status chip colour per satellite state. */
const STATUS_COLOR: Record<string, 'default' | 'info' | 'warning' | 'success' | 'error'> = {
    idle: 'default',
    listening: 'info',
    processing: 'warning',
    speaking: 'success',
    offline: 'error',
};

const BROADCAST = '__all__';

/**
 * Live view of the voice satellites: reads `assistant.<n>.satellites.*` and shows each satellite's
 * status, room, reachability and last-seen time — plus a composer to push a test announcement to one
 * satellite (`satellites.<id>.tts`) or to all of them (`tts.text`).
 */
export default class SatellitesComponent extends ConfigGeneric<ConfigGenericProps, SatellitesState> {
    private pattern = '';

    constructor(props: ConfigGenericProps) {
        super(props);
        this.state = { ...this.state, sats: {}, speak: {} };
    }

    private get instanceId(): string {
        const ctx = this.props.oContext;
        return `${ctx.adapterName}.${ctx.instance}`;
    }

    async componentDidMount(): Promise<void> {
        super.componentDidMount();
        this.pattern = `${this.instanceId}.satellites.*`;
        try {
            const states = (await this.props.oContext.socket.getForeignStates(this.pattern)) as Record<
                string,
                ioBroker.State | null | undefined
            >;
            const sats: Record<string, SatRow> = {};
            for (const [id, st] of Object.entries(states || {})) {
                this.applyToMap(sats, id, st);
            }
            this.setState({ sats });
        } catch {
            /* states may not exist yet */
        }
        this.props.oContext.socket.subscribeState(this.pattern, this.onState);
    }

    componentWillUnmount(): void {
        if (this.pattern) {
            this.props.oContext.socket.unsubscribeState(this.pattern, this.onState);
        }
        super.componentWillUnmount?.();
    }

    /** Split a full state id into `{ satId, prop }` (satIds are sanitised → contain no dots). */
    private parse(fullId: string): { satId: string; prop: string } | null {
        const prefix = `${this.instanceId}.satellites.`;
        if (!fullId.startsWith(prefix)) {
            return null;
        }
        const rest = fullId.slice(prefix.length);
        const dot = rest.indexOf('.');
        return dot < 0 ? null : { satId: rest.slice(0, dot), prop: rest.slice(dot + 1) };
    }

    private applyToMap(map: Record<string, SatRow>, fullId: string, st: ioBroker.State | null | undefined): void {
        const p = this.parse(fullId);
        if (!p) {
            return;
        }
        const row = map[p.satId] || { status: 'idle', room: '', alive: false, lastSeen: 0 };
        if (p.prop === 'status') {
            row.status = String(st?.val ?? 'idle');
        } else if (p.prop === 'room') {
            row.room = String(st?.val ?? '');
        } else if (p.prop === 'alive') {
            row.alive = !!st?.val;
        } else if (p.prop === 'lastSeen') {
            row.lastSeen = Number(st?.val) || 0;
        }
        map[p.satId] = row;
    }

    private onState = (id: string, st: ioBroker.State | null | undefined): void => {
        this.setState(prev => {
            const sats = { ...prev.sats };
            // clone the affected row so React sees the change
            const p = this.parse(id);
            if (p && sats[p.satId]) {
                sats[p.satId] = { ...sats[p.satId] };
            }
            this.applyToMap(sats, id, st);
            return { sats };
        });
    };

    /** Push the composer text to one satellite (or all) by writing the corresponding tts state. */
    private announce(satId: string): void {
        const text = (this.state.speak[satId] || '').trim();
        if (!text) {
            return;
        }
        const target =
            satId === BROADCAST ? `${this.instanceId}.tts.text` : `${this.instanceId}.satellites.${satId}.tts`;
        this.props.oContext.socket.setState(target, { val: text, ack: false }).catch(() => {});
        this.setState(prev => ({ speak: { ...prev.speak, [satId]: '' } }));
    }

    /** Compact relative time, e.g. "5 s", "2 min", "1 h", "3 d" — or "—" when never seen. */
    private ago(ts: number): string {
        if (!ts) {
            return '—';
        }
        const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
        if (s < 60) {
            return `${s} s`;
        }
        if (s < 3600) {
            return `${Math.round(s / 60)} min`;
        }
        if (s < 86400) {
            return `${Math.round(s / 3600)} h`;
        }
        return `${Math.round(s / 86400)} d`;
    }

    private renderComposer(satId: string, placeholder: string): React.JSX.Element {
        const value = this.state.speak[satId] || '';
        return (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <TextField
                    size="small"
                    variant="outlined"
                    placeholder={placeholder}
                    value={value}
                    onChange={e => this.setState(prev => ({ speak: { ...prev.speak, [satId]: e.target.value } }))}
                    onKeyDown={e => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            this.announce(satId);
                        }
                    }}
                    sx={{ minWidth: 180 }}
                />
                <Tooltip title={I18n.t('custom_assistant_Send announcement')}>
                    <span>
                        <IconButton
                            size="small"
                            color="primary"
                            disabled={!value.trim()}
                            onClick={() => this.announce(satId)}
                        >
                            <AnnounceIcon />
                        </IconButton>
                    </span>
                </Tooltip>
            </Box>
        );
    }

    renderItem(): React.JSX.Element {
        const ids = Object.keys(this.state.sats).sort();

        return (
            <Box sx={{ width: '100%' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                    <Typography variant="h6">{I18n.t('custom_assistant_Satellites')}</Typography>
                    {ids.length ? this.renderComposer(BROADCAST, I18n.t('custom_assistant_Speak on all satellites')) : null}
                </Box>

                {!ids.length ? (
                    <Typography
                        sx={{ p: 2, opacity: 0.7 }}
                        variant="body2"
                    >
                        {I18n.t('custom_assistant_No satellites registered yet.')}
                    </Typography>
                ) : (
                    <Table
                        size="small"
                        sx={{ '& td, & th': { px: 1 } }}
                    >
                        <TableHead>
                            <TableRow>
                                <TableCell />
                                <TableCell>{I18n.t('custom_assistant_Satellite')}</TableCell>
                                <TableCell>{I18n.t('custom_assistant_room')}</TableCell>
                                <TableCell>{I18n.t('custom_assistant_Status')}</TableCell>
                                <TableCell>{I18n.t('custom_assistant_Last seen')}</TableCell>
                                <TableCell>{I18n.t('custom_assistant_Announcement')}</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {ids.map(id => {
                                const s = this.state.sats[id];
                                return (
                                    <TableRow key={id}>
                                        <TableCell sx={{ width: 24 }}>
                                            <Tooltip
                                                title={
                                                    s.alive
                                                        ? I18n.t('custom_assistant_online')
                                                        : I18n.t('custom_assistant_offline')
                                                }
                                            >
                                                <DotIcon
                                                    sx={{
                                                        fontSize: '0.8rem',
                                                        color: s.alive ? 'success.main' : 'error.main',
                                                    }}
                                                />
                                            </Tooltip>
                                        </TableCell>
                                        <TableCell>{id}</TableCell>
                                        <TableCell>{s.room || '—'}</TableCell>
                                        <TableCell>
                                            <Chip
                                                size="small"
                                                variant="outlined"
                                                color={STATUS_COLOR[s.status] || 'default'}
                                                label={I18n.t(`custom_assistant_sat_${s.status}`)}
                                            />
                                        </TableCell>
                                        <TableCell>
                                            <Tooltip
                                                title={s.lastSeen ? new Date(s.lastSeen).toLocaleString() : ''}
                                            >
                                                <span>{this.ago(s.lastSeen)}</span>
                                            </Tooltip>
                                        </TableCell>
                                        <TableCell>
                                            {this.renderComposer(id, I18n.t('custom_assistant_Type a message…'))}
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                )}
            </Box>
        );
    }
}
