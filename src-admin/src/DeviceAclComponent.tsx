import React from 'react';

import {
    Box,
    Checkbox,
    LinearProgress,
    Paper,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    TextField,
    Typography,
} from '@mui/material';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import type { AssistantAdapterConfig, DeviceInfo } from './types';
import { I18n } from '@iobroker/adapter-react-v5';

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

interface DeviceAclState extends ConfigGenericState {
    devices: DeviceInfo[];
    loading: boolean;
    alive: boolean;
    filter: string;
}

/**
 * Per-device read/write ACL editor. Lists the devices the assistant sees (from the adapter's
 * `getDevices` sendTo, which uses the ioBroker type-detector) with type and room, and lets the user
 * toggle read/write per device. The result is stored in `config.deviceAcl` (only deviations from the
 * default "read+write allowed" are persisted); the backend enforces the write flag on `set_state`.
 */
export default class DeviceAclComponent extends ConfigGeneric<ConfigGenericProps, DeviceAclState> {
    constructor(props: ConfigGenericProps) {
        super(props);
        this.state = {
            ...this.state,
            devices: [],
            loading: true,
            alive: false,
            filter: '',
        };
    }

    async componentDidMount(): Promise<void> {
        super.componentDidMount();
        const ctx = this.props.oContext;
        const id = `${ctx.adapterName}.${ctx.instance}`;

        let alive = false;
        try {
            const st = await ctx.socket.getState(`system.adapter.${id}.alive`);
            alive = !!st?.val;
        } catch {
            alive = false;
        }

        let devices: DeviceInfo[] = [];
        if (alive) {
            try {
                const res = (await ctx.socket.sendTo(id, 'getDevices', {})) as DeviceInfo[] | undefined;
                devices = Array.isArray(res) ? res : [];
            } catch {
                devices = [];
            }
        }
        this.setState({ devices, alive, loading: false });
    }

    private getAcl(key: string): { read: boolean; write: boolean } {
        const config = this.props.data as AssistantAdapterConfig;
        return config.deviceAcl?.[key] || { read: true, write: true };
    }

    private setAcl(key: string, patch: Partial<{ read: boolean; write: boolean }>): void {
        const data: AssistantAdapterConfig = JSON.parse(JSON.stringify(this.props.data));
        data.deviceAcl = data.deviceAcl || {};
        const next = { ...(data.deviceAcl[key] || { read: true, write: true }), ...patch };
        // Persist only deviations from the default (read + write allowed) to keep the config small.
        if (next.read && next.write) {
            delete data.deviceAcl[key];
        } else {
            data.deviceAcl[key] = next;
        }
        this.props.onChange(data);
    }

    renderItem(): React.JSX.Element {
        if (this.state.loading) {
            return <LinearProgress />;
        }
        if (!this.state.alive) {
            return (
                <Typography
                    sx={{ p: 2 }}
                    color="warning.main"
                >
                    {I18n.t('custom_assistant_Start the assistant instance to load the device list.')}
                </Typography>
            );
        }
        if (!this.state.devices.length) {
            return (
                <Typography sx={{ p: 2 }}>
                    {I18n.t('custom_assistant_No devices detected. Assign states to rooms and functions in ioBroker.')}
                </Typography>
            );
        }

        const filter = this.state.filter.trim().toLowerCase();
        const devices = filter
            ? this.state.devices.filter(d => `${d.name} ${d.type} ${d.room}`.toLowerCase().includes(filter))
            : this.state.devices;
        const dark = this.props.oContext.themeType === 'dark';

        return (
            <Box sx={{ width: '100%' }}>
                <Typography
                    variant="h6"
                    sx={{ mt: 1 }}
                >
                    {I18n.t('custom_assistant_Per-device permissions')}
                </Typography>
                <Typography
                    variant="body2"
                    sx={{ mb: 1 }}
                    color="text.secondary"
                >
                    {I18n.t('custom_assistant_hint')}
                </Typography>
                <TextField
                    variant="standard"
                    size="small"
                    label="Filter"
                    value={this.state.filter}
                    onChange={e => this.setState({ filter: e.target.value })}
                    sx={{ mb: 1, width: 320 }}
                />
                <TableContainer
                    component={Paper}
                    sx={{ width: '100%' }}
                >
                    <Table size="small">
                        <TableHead>
                            <TableRow sx={{ background: dark ? '#333' : '#DDD' }}>
                                <TableCell>{I18n.t('custom_assistant_device')}</TableCell>
                                <TableCell>{I18n.t('custom_assistant_type')}</TableCell>
                                <TableCell>{I18n.t('custom_assistant_room')}</TableCell>
                                <TableCell align="center">{I18n.t('custom_assistant_read')}</TableCell>
                                <TableCell align="center">{I18n.t('custom_assistant_write')}</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {devices.map(d => {
                                const acl = this.getAcl(d.key);
                                const canWrite = d.writableStateIds.length > 0;
                                return (
                                    <TableRow key={d.key}>
                                        <TableCell>
                                            {d.name}
                                            {d.stateIds.length ? (
                                                <Typography
                                                    variant="caption"
                                                    component="div"
                                                    sx={{
                                                        wordBreak: 'break-all',
                                                        fontStyle: 'italic',
                                                        opacity: 0.7,
                                                        fontSize: 'smaller',
                                                    }}
                                                >
                                                    {d.stateIds.join(', ')}
                                                </Typography>
                                            ) : null}
                                        </TableCell>
                                        <TableCell>{d.type}</TableCell>
                                        <TableCell>{d.room && d.room !== 'No room' ? d.room : '-'}</TableCell>
                                        <TableCell align="center">
                                            <Checkbox
                                                checked={acl.read}
                                                onChange={() => this.setAcl(d.key, { read: !acl.read })}
                                            />
                                        </TableCell>
                                        <TableCell align="center">
                                            <Checkbox
                                                checked={acl.write && canWrite}
                                                disabled={!canWrite}
                                                onChange={() => this.setAcl(d.key, { write: !acl.write })}
                                            />
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Box>
        );
    }
}
