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
    Divider,
    FormControl,
    InputLabel,
    MenuItem,
    Select,
    Slider,
    Switch,
    TextField,
    Tooltip,
    Typography,
} from '@mui/material';
import { I18n } from '@iobroker/gui-components';

/** One wake word as the device describes it. */
interface WakeWord {
    id: string;
    phrase: string;
    languages: string[];
}

export interface SatelliteSettingsProps {
    /** `assistant.0` */
    instanceId: string;
    /** Sanitised satellite state id, i.e. the segment under `satellites.`. */
    satId: string;
    room: string;
    /** Live values of every state under this satellite, keyed by the part after `satellites.<satId>.`. */
    values: Record<string, ioBroker.StateValue>;
    /** Object definitions of the control states, keyed the same way. Empty while still loading. */
    objects: Record<string, ioBroker.StateObject>;
    loading: boolean;
    /** Write a value; `prop` is relative to `satellites.<satId>.`. */
    onWrite: (prop: string, value: ioBroker.StateValue) => void;
    onClose: () => void;
}

/** Controls whose value is the device telling us something, not something to set. */
function isReadOnly(obj: ioBroker.StateObject): boolean {
    return obj.common.write === false;
}

/**
 * Per-satellite settings, opened from the gear button in the satellites table.
 *
 * Everything here is rendered from the **object metadata** the adapter wrote when the device announced
 * its entities — `min`/`max`/`step` for a number, `states` for a select, the type for a switch. Nothing
 * is hard-coded per product, so a device with a different set of knobs gets the right controls without
 * a change here. Values are written straight to the states; the adapter forwards them to the device and
 * writes back what the device actually accepted, so a clamped value visibly snaps into place.
 */
export default function SatelliteSettingsDialog(props: SatelliteSettingsProps): React.JSX.Element {
    const { values, objects, loading, onWrite } = props;

    // ── wake words ──────────────────────────────────────────────────────────
    const available: { max: number; words: WakeWord[] } | null = React.useMemo(() => {
        try {
            const raw = values.availableWakeWords;
            return raw ? (JSON.parse(String(raw)) as { max: number; words: WakeWord[] }) : null;
        } catch {
            return null;
        }
    }, [values.availableWakeWords]);

    const active = String(values.wakeWords ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    const toggleWakeWord = (id: string): void => {
        const next = active.includes(id) ? active.filter(w => w !== id) : [...active, id];
        onWrite('wakeWords', next.join(','));
    };

    const max = available?.max || 0;
    const full = max > 0 && active.length >= max;

    // ── controls, grouped so the compound ones stay together ────────────────
    const controlProps = Object.keys(objects).sort();
    /** `controls.<objectId>` (scalar) or `controls.<objectId>.<leaf>` (media player, firmware). */
    const groups = new Map<string, string[]>();
    for (const prop of controlProps) {
        const rest = prop.replace(/^controls\./, '');
        const dot = rest.indexOf('.');
        const group = dot < 0 ? rest : rest.slice(0, dot);
        groups.set(group, [...(groups.get(group) || []), prop]);
    }

    function renderControl(prop: string): React.JSX.Element | null {
        const obj = objects[prop];
        const common = obj.common;
        const label = common.name && typeof common.name === 'string' ? common.name : prop;
        const value = values[prop];

        // A button (firmware install): fire and forget.
        if (common.role === 'button') {
            return (
                <Button
                    key={prop}
                    size="small"
                    variant="outlined"
                    onClick={() => onWrite(prop, true)}
                >
                    {label}
                </Button>
            );
        }

        if (isReadOnly(obj)) {
            return (
                <Box key={prop}>
                    <Typography
                        variant="caption"
                        sx={{ opacity: 0.7 }}
                    >
                        {label}
                    </Typography>
                    <Typography variant="body2">{value === undefined || value === null ? '—' : String(value)}</Typography>
                </Box>
            );
        }

        if (common.type === 'boolean') {
            return (
                <Box
                    key={prop}
                    sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                >
                    <Typography variant="body2">{label}</Typography>
                    <Switch
                        size="small"
                        checked={!!value}
                        onChange={e => onWrite(prop, e.target.checked)}
                    />
                </Box>
            );
        }

        if (common.states) {
            // `states` may be a value→label map or a plain list of values.
            const options: Record<string, string> = Array.isArray(common.states)
                ? Object.fromEntries((common.states as string[]).map((s: string) => [s, s]))
                : (common.states as Record<string, string>);
            return (
                <FormControl
                    key={prop}
                    size="small"
                    fullWidth
                >
                    <InputLabel>{label}</InputLabel>
                    <Select
                        label={label}
                        value={value === undefined || value === null ? '' : String(value)}
                        onChange={e => onWrite(prop, e.target.value)}
                    >
                        {Object.entries(options).map(([k, v]) => (
                            <MenuItem
                                key={k}
                                value={k}
                            >
                                {v}
                            </MenuItem>
                        ))}
                    </Select>
                </FormControl>
            );
        }

        if (common.type === 'number' && common.min !== undefined && common.max !== undefined) {
            const num = Number(value ?? common.min);
            return (
                <Box key={prop}>
                    <Typography variant="body2">
                        {label}
                        <Typography
                            component="span"
                            variant="caption"
                            sx={{ ml: 1, opacity: 0.7 }}
                        >
                            {num}
                            {common.unit || ''} ({common.min}…{common.max})
                        </Typography>
                    </Typography>
                    <Slider
                        size="small"
                        value={Number.isFinite(num) ? num : common.min}
                        min={common.min}
                        max={common.max}
                        step={common.step || 1}
                        // Only write when the drag ends — otherwise every pixel is a device round-trip.
                        onChangeCommitted={(_e, v) => onWrite(prop, Array.isArray(v) ? v[0] : v)}
                        valueLabelDisplay="auto"
                    />
                </Box>
            );
        }

        return (
            <TextField
                key={prop}
                size="small"
                fullWidth
                label={label}
                defaultValue={value === undefined || value === null ? '' : String(value)}
                onBlur={e => onWrite(prop, e.target.value)}
                onKeyDown={e => {
                    if (e.key === 'Enter') {
                        onWrite(prop, (e.target as HTMLInputElement).value);
                    }
                }}
            />
        );
    }

    return (
        <Dialog
            open
            onClose={props.onClose}
            maxWidth="sm"
            fullWidth
        >
            <DialogTitle>
                {I18n.t('custom_assistant_Settings for %s', props.satId)}
                {props.room ? (
                    <Typography
                        variant="caption"
                        sx={{ ml: 1, opacity: 0.7 }}
                    >
                        {props.room}
                    </Typography>
                ) : null}
            </DialogTitle>
            <DialogContent dividers>
                {loading ? (
                    <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
                        <CircularProgress size={28} />
                    </Box>
                ) : (
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {available?.words?.length ? (
                            <Box>
                                <Typography variant="subtitle2">
                                    {I18n.t('custom_assistant_Wake words')}
                                    <Typography
                                        component="span"
                                        variant="caption"
                                        sx={{ ml: 1, opacity: 0.7 }}
                                    >
                                        {I18n.t('custom_assistant_%s of %s active', active.length, max)}
                                    </Typography>
                                </Typography>
                                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
                                    {available.words.map(w => {
                                        const on = active.includes(w.id);
                                        return (
                                            <Tooltip
                                                key={w.id}
                                                title={w.languages.join(', ')}
                                            >
                                                <Chip
                                                    size="small"
                                                    label={w.phrase || w.id}
                                                    color={on ? 'primary' : 'default'}
                                                    variant={on ? 'filled' : 'outlined'}
                                                    // A full device would silently drop the extra one.
                                                    disabled={!on && full}
                                                    onClick={() => toggleWakeWord(w.id)}
                                                    // The admin theme flattens an outlined chip almost
                                                    // into the background, which turns nine of them into
                                                    // one wall of text. Force a visible frame.
                                                    sx={{
                                                        border: '1px solid',
                                                        borderColor: on ? 'primary.main' : 'text.secondary',
                                                        bgcolor: on ? undefined : 'action.hover',
                                                        fontWeight: on ? 600 : 400,
                                                    }}
                                                />
                                            </Tooltip>
                                        );
                                    })}
                                </Box>
                                <Typography
                                    variant="caption"
                                    sx={{ display: 'block', mt: 0.5, opacity: 0.7 }}
                                >
                                    {I18n.t('custom_assistant_wake_word_hint')}
                                </Typography>
                            </Box>
                        ) : null}

                        {available?.words?.length && groups.size ? <Divider /> : null}

                        {[...groups.entries()].map(([group, propsInGroup]) => (
                            <Box
                                key={group}
                                sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}
                            >
                                {propsInGroup.length > 1 ? (
                                    <Typography
                                        variant="subtitle2"
                                        sx={{ opacity: 0.8 }}
                                    >
                                        {group}
                                    </Typography>
                                ) : null}
                                {propsInGroup.map(renderControl)}
                            </Box>
                        ))}

                        {!groups.size && !available ? (
                            <Typography
                                variant="body2"
                                sx={{ opacity: 0.7 }}
                            >
                                {I18n.t('custom_assistant_This satellite exposes no settings.')}
                            </Typography>
                        ) : null}
                    </Box>
                )}
            </DialogContent>
            <DialogActions>
                <Button onClick={props.onClose}>{I18n.t('custom_assistant_Close')}</Button>
            </DialogActions>
        </Dialog>
    );
}
