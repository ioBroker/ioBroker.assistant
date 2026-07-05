import React from 'react';

import {
    Box,
    Button,
    Checkbox,
    Chip,
    CircularProgress,
    IconButton,
    LinearProgress,
    Paper,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    TextField,
    Tooltip,
    Typography,
} from '@mui/material';
import { Translate as TranslateIcon } from '@mui/icons-material';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import type { AssistantAdapterConfig, DeviceInfo } from './types';
import { I18n, DeviceTypeIcon, extendDeviceTypeTranslation } from '@iobroker/adapter-react-v5';
import type { Types } from '@iobroker/type-detector';

// Register the shared `type-<deviceType>` translations (e.g. type-dimmer → "Dimmer") into admin I18n.
extendDeviceTypeTranslation();

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
    /** In-progress field edits keyed by device key (present → field shows this instead of the resolved name). */
    edits: Record<string, string>;
    /** Device key currently being persisted (shows a spinner). */
    savingKey: string;
    /** Device keys currently being translated by the LLM (multiple run in parallel). */
    translatingKeys: Record<string, boolean>;
    /** Per-row save status → row background: 'dirty' (grey), 'saving' (light red), 'saved' (green, 2 s). */
    rowStatus: Record<string, 'dirty' | 'saving' | 'saved'>;
}

/** type-detector types that are read-only sensors — they cannot be controlled, so "write" is disabled. */
const READONLY_TYPES = new Set<string>([
    'temperature',
    'humidity',
    'illuminance',
    'motion',
    'door',
    'window',
    'windowTilt',
    'fireAlarm',
    'floodAlarm',
    'camera',
    'weatherCurrent',
    'weatherForecast',
    'warning',
    'location',
    'info',
    'chart',
    'image',
    'instance',
]);

/** Default read/write per device type. Locks default to write-off (safety). */
function defaultAclFor(type: string): { read: boolean; write: boolean } {
    if (type === 'lock') {
        return { read: true, write: false };
    }
    return { read: true, write: true };
}

/** Languages the editor offers (ioBroker's supported set). */
const LANGUAGES: { value: string; label: string }[] = [
    { value: 'en', label: 'English' },
    { value: 'de', label: 'Deutsch' },
    { value: 'ru', label: 'Русский' },
    { value: 'pt', label: 'Português' },
    { value: 'nl', label: 'Nederlands' },
    { value: 'fr', label: 'Français' },
    { value: 'it', label: 'Italiano' },
    { value: 'es', label: 'Español' },
    { value: 'pl', label: 'Polski' },
    { value: 'uk', label: 'Українська' },
    { value: 'zh-cn', label: '简体中文' },
];

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
            edits: {},
            savingKey: '',
            translatingKeys: {},
            rowStatus: {},
        };
    }

    /** Background color for a row based on its save status (theme-agnostic overlays). */
    private rowColor(key: string): string | undefined {
        switch (this.state.rowStatus[key]) {
            case 'dirty':
                return 'rgba(128,128,128,0.20)';
            case 'saving':
                return 'rgba(244,67,54,0.20)';
            case 'saved':
                return 'rgba(76,175,80,0.28)';
            default:
                return undefined;
        }
    }

    /** Set/clear a row's save status. */
    private setRowStatus(key: string, status: 'dirty' | 'saving' | 'saved' | null): void {
        this.setState(prev => {
            const rowStatus = { ...prev.rowStatus };
            if (status) {
                rowStatus[key] = status;
            } else {
                delete rowStatus[key];
            }
            return { rowStatus };
        });
    }

    private aliveSubId = '';

    private get instanceId(): string {
        const ctx = this.props.oContext;
        return `${ctx.adapterName}.${ctx.instance}`;
    }

    /** Editing language for the device names — taken from the Voice tab's `voiceLanguage`, else admin UI. */
    private get editLang(): string {
        return String((this.props.data as AssistantAdapterConfig).voiceLanguage || '') || I18n.getLanguage();
    }

    componentDidUpdate(prevProps: ConfigGenericProps): void {
        // Clear in-progress edits when the editing language changes on the Voice tab.
        const prev = String((prevProps.data as AssistantAdapterConfig).voiceLanguage || '');
        const now = String((this.props.data as AssistantAdapterConfig).voiceLanguage || '');
        if (prev !== now && Object.keys(this.state.edits).length) {
            this.setState({ edits: {} });
        }
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
        this.setState({ alive }, () => void this.loadDevices());

        // Reload when the instance starts (e.g. the tab was opened during a restart).
        this.props.oContext.socket.subscribeState(this.aliveSubId, this.onAliveChange);
    }

    componentWillUnmount(): void {
        if (this.aliveSubId) {
            this.props.oContext.socket.unsubscribeState(this.aliveSubId, this.onAliveChange);
        }
        super.componentWillUnmount?.();
    }

    private onAliveChange = (_id: string, state: ioBroker.State | null | undefined): void => {
        const alive = !!state?.val;
        if (alive === this.state.alive) {
            return;
        }
        // On (re)start the device list must be refetched; set loading so the UI shows progress.
        this.setState({ alive, loading: alive }, () => {
            if (alive) {
                void this.loadDevices();
            }
        });
    };

    /** (Re)load the device list (with the full smartName maps) from the backend. */
    private async loadDevices(retries = 4): Promise<void> {
        if (!this.state.alive) {
            this.setState({ loading: false });
            return;
        }
        let devices: DeviceInfo[] = [];
        try {
            // Resolve rooms/auto-names in the admin UI language; smartName maps are language-complete.
            const res = (await this.props.oContext.socket.sendTo(this.instanceId, 'getDevices', {
                language: I18n.getLanguage(),
            })) as DeviceInfo[] | undefined;
            // Buttons are write-only triggers — not worth listing in the ACL editor.
            devices = (Array.isArray(res) ? res : []).filter(d => d.type !== 'button');
        } catch {
            devices = [];
        }
        // Right after a (re)start the backend's MCP layer may not be ready yet → empty list. Retry briefly.
        if (!devices.length && retries > 0) {
            setTimeout(() => {
                if (this.state.alive) {
                    void this.loadDevices(retries - 1);
                }
            }, 1200);
            return; // keep the loading indicator until we get devices or run out of retries
        }
        this.setState({ devices, edits: {}, loading: false });
    }

    /**
     * Resolve the name to show for a device in the current editing language:
     * exact `smartName[lang]` → `en`/first smartName → the auto (parent) name.
     */
    private nameFor(d: DeviceInfo): { value: string; exact: boolean; from: string } {
        const lang = this.editLang;
        const sn = d.smartName;
        if (typeof sn === 'string' && sn) {
            return { value: sn, exact: true, from: '' }; // legacy string applies to every language
        }
        if (sn && typeof sn === 'object') {
            if (sn[lang]) {
                return { value: sn[lang], exact: true, from: lang };
            }
            const from = sn.en ? 'en' : Object.keys(sn)[0];
            if (from && sn[from]) {
                return { value: sn[from], exact: false, from };
            }
        }
        return { value: d.autoName || d.name || '', exact: false, from: 'auto' };
    }

    /** The value currently shown in a device's name field (in-progress edit, else the resolved name). */
    private fieldValue(d: DeviceInfo): string {
        return this.state.edits[d.key] ?? this.nameFor(d).value;
    }

    private onNameChange(key: string, value: string): void {
        const d = this.state.devices.find(x => x.key === key);
        const baseline = d ? this.nameFor(d).value : '';
        this.setState(prev => {
            const rowStatus = { ...prev.rowStatus };
            // Grey while changed-but-unsaved; clear when reverted to the saved value.
            if (value !== baseline) {
                rowStatus[key] = 'dirty';
            } else if (rowStatus[key] === 'dirty') {
                delete rowStatus[key];
            }
            return { edits: { ...prev.edits, [key]: value }, rowStatus };
        });
    }

    /** Flash a row green for 2 s after a successful save, then return to normal. */
    private flashSaved(key: string): void {
        this.setRowStatus(key, 'saved');
        setTimeout(() => {
            if (this.state.rowStatus[key] === 'saved') {
                this.setRowStatus(key, null);
            }
        }, 2000);
    }

    /**
     * Merge a saved name into the local device state (no full reload) so concurrent edits/translations
     * don't clobber each other. Empty `name` removes the language (falls back to the auto name).
     */
    private applyLocalName(key: string, lang: string, name: string): void {
        this.setState(prev => ({
            devices: prev.devices.map(d => {
                if (d.key !== key) {
                    return d;
                }
                const sn: Record<string, string> =
                    d.smartName && typeof d.smartName === 'object'
                        ? { ...d.smartName }
                        : typeof d.smartName === 'string' && d.smartName
                          ? { en: d.smartName }
                          : {};
                if (name) {
                    sn[lang] = name;
                } else {
                    delete sn[lang];
                }
                return { ...d, smartName: sn };
            }),
            edits: (() => {
                const e = { ...prev.edits };
                delete e[key];
                return e;
            })(),
        }));
    }

    /** Persist the edited name into `smartName[lang]` via the backend (optimistic local update). */
    private async saveName(device: DeviceInfo): Promise<void> {
        const edited = this.state.edits[device.key];
        if (edited === undefined || edited === this.nameFor(device).value) {
            return; // untouched or unchanged from the shown baseline
        }
        const lang = this.editLang;
        this.setState({ savingKey: device.key });
        this.setRowStatus(device.key, 'saving');
        try {
            await this.props.oContext.socket.sendTo(this.instanceId, 'setDeviceName', {
                stateId: device.key,
                name: edited,
                language: lang,
            });
            this.applyLocalName(device.key, lang, edited.trim());
            this.flashSaved(device.key);
        } catch {
            this.setRowStatus(device.key, 'dirty');
        }
        this.setState({ savingKey: '' });
    }

    /** Ask the LLM to translate the device's existing name into the current language, then save it. */
    private async translateName(device: DeviceInfo): Promise<void> {
        const source = this.nameFor(device).value;
        const key = device.key;
        if (!source || this.state.translatingKeys[key]) {
            return;
        }
        const lang = this.editLang;
        this.setState(prev => ({ translatingKeys: { ...prev.translatingKeys, [key]: true } }));
        this.setRowStatus(key, 'saving');
        try {
            const res = (await this.props.oContext.socket.sendTo(this.instanceId, 'translateName', {
                text: source,
                targetLang: lang,
            })) as { translation?: string; error?: string } | undefined;
            const translation = res?.translation?.trim();
            if (translation) {
                await this.props.oContext.socket.sendTo(this.instanceId, 'setDeviceName', {
                    stateId: key,
                    name: translation,
                    language: lang,
                });
                this.applyLocalName(key, lang, translation);
                this.flashSaved(key);
            } else {
                this.setRowStatus(key, null);
            }
        } catch {
            this.setRowStatus(key, null);
        }
        this.setState(prev => {
            const t = { ...prev.translatingKeys };
            delete t[key];
            return { translatingKeys: t };
        });
    }

    /** Translate every device that has no exact name in the current language (runs in parallel). */
    private async translateAllMissing(): Promise<void> {
        const missing = this.state.devices.filter(d => !this.nameFor(d).exact && !this.state.translatingKeys[d.key]);
        await Promise.all(missing.map(d => this.translateName(d)));
    }

    private getAcl(d: DeviceInfo): { read: boolean; write: boolean } {
        const config = this.props.data as AssistantAdapterConfig;
        return config.deviceAcl?.[d.key] || defaultAclFor(d.type);
    }

    private setAcl(d: DeviceInfo, patch: Partial<{ read: boolean; write: boolean }>): void {
        const data: AssistantAdapterConfig = JSON.parse(JSON.stringify(this.props.data));
        data.deviceAcl = data.deviceAcl || {};
        const def = defaultAclFor(d.type);
        const next = { ...(data.deviceAcl[d.key] || def), ...patch };
        // Persist only deviations from the type default to keep the config small.
        if (next.read === def.read && next.write === def.write) {
            delete data.deviceAcl[d.key];
        } else {
            data.deviceAcl[d.key] = next;
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
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
                    <Chip
                        size="small"
                        color="primary"
                        variant="outlined"
                        label={I18n.t(
                            'custom_assistant_Name language: %s',
                            LANGUAGES.find(l => l.value === this.editLang)?.label || this.editLang,
                        )}
                    />
                    <Typography
                        variant="caption"
                        color="text.secondary"
                    >
                        {I18n.t('custom_assistant_change it on the Voice tab')}
                    </Typography>
                    {(() => {
                        const missing = this.state.devices.filter(d => !this.nameFor(d).exact).length;
                        const anyTranslating = Object.keys(this.state.translatingKeys).length > 0;
                        return (
                            <Button
                                size="small"
                                variant="outlined"
                                startIcon={anyTranslating ? <CircularProgress size={14} /> : <TranslateIcon />}
                                disabled={!missing || anyTranslating}
                                onClick={() => void this.translateAllMissing()}
                            >
                                {I18n.t('custom_assistant_Translate all missing (%s)', missing)}
                            </Button>
                        );
                    })()}
                    <Box sx={{ flex: 1 }} />
                    <TextField
                        variant="standard"
                        size="small"
                        label="Filter"
                        value={this.state.filter}
                        onChange={e => this.setState({ filter: e.target.value })}
                        sx={{ width: 320 }}
                    />
                </Box>
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
                                const acl = this.getAcl(d);
                                // No writable state, or a read-only sensor type → cannot be controlled.
                                const canWrite = d.writableStateIds.length > 0 && !READONLY_TYPES.has(d.type);
                                // A device with read off is hidden from the assistant → show it dimmed.
                                const disabled = !acl.read;
                                return (
                                    <TableRow
                                        key={d.key}
                                        sx={{
                                            background: this.rowColor(d.key),
                                            opacity: disabled ? 0.5 : 1,
                                            transition: 'background-color 0.4s',
                                        }}
                                    >
                                        <TableCell>
                                            {(() => {
                                                const resolved = this.nameFor(d);
                                                const translating = !!this.state.translatingKeys[d.key];
                                                const busy = this.state.savingKey === d.key || translating;
                                                return (
                                                    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
                                                        <TextField
                                                            variant="standard"
                                                            size="small"
                                                            fullWidth
                                                            value={this.fieldValue(d)}
                                                            disabled={busy}
                                                            error={!resolved.exact && !this.state.edits[d.key]}
                                                            helperText={
                                                                !resolved.exact && !this.state.edits[d.key]
                                                                    ? I18n.t(
                                                                          'custom_assistant_no name in %s (showing %s)',
                                                                          this.editLang,
                                                                          resolved.from === 'auto'
                                                                              ? I18n.t('custom_assistant_auto')
                                                                              : resolved.from,
                                                                      )
                                                                    : ' '
                                                            }
                                                            onChange={e => this.onNameChange(d.key, e.target.value)}
                                                            onBlur={() => void this.saveName(d)}
                                                            onKeyDown={e => {
                                                                if (e.key === 'Enter') {
                                                                    (e.target as HTMLInputElement).blur();
                                                                }
                                                            }}
                                                            slotProps={{
                                                                input: {
                                                                    endAdornment:
                                                                        this.state.savingKey === d.key ? (
                                                                            <CircularProgress size={14} />
                                                                        ) : null,
                                                                },
                                                            }}
                                                        />
                                                        <Tooltip
                                                            title={I18n.t(
                                                                'custom_assistant_Translate name into %s',
                                                                this.editLang,
                                                            )}
                                                        >
                                                            <span>
                                                                <IconButton
                                                                    size="small"
                                                                    disabled={busy}
                                                                    onClick={() => void this.translateName(d)}
                                                                >
                                                                    {translating ? (
                                                                        <CircularProgress size={16} />
                                                                    ) : (
                                                                        <TranslateIcon fontSize="small" />
                                                                    )}
                                                                </IconButton>
                                                            </span>
                                                        </Tooltip>
                                                    </Box>
                                                );
                                            })()}
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
                                        <TableCell>
                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                                                <DeviceTypeIcon
                                                    type={d.type as Types}
                                                    style={{ width: 20, height: 20 }}
                                                />
                                                <span>{I18n.t(`type-${d.type}`)}</span>
                                            </Box>
                                        </TableCell>
                                        <TableCell>{d.room && d.room !== 'No room' ? d.room : '-'}</TableCell>
                                        <TableCell align="center">
                                            <Checkbox
                                                checked={acl.read}
                                                onChange={() => this.setAcl(d, { read: !acl.read })}
                                            />
                                        </TableCell>
                                        <TableCell align="center">
                                            <Checkbox
                                                checked={acl.write && canWrite}
                                                disabled={!canWrite}
                                                onChange={() => this.setAcl(d, { write: !acl.write })}
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
