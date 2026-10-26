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
    Tab,
    Tabs,
    Tooltip,
    Typography,
} from '@mui/material';
import {
    Close as CloseIcon,
    ContentCopy as CopyIcon,
    Download as DownloadIcon,
    UnfoldLess as CollapseIcon,
    UnfoldMore as ExpandIcon,
} from '@mui/icons-material';
import { I18n } from '@iobroker/gui-components';

import {
    STAGE_COLORS,
    STAGE_LABELS,
    TIER_COLORS,
    TIER_LABELS,
    TRANSPORT_LABELS,
    formatMs,
    formatTokens,
    formatValue,
    type JournalEntry,
    type JournalStep,
} from './journal';

/** What the adapter answers to `getJournalTrace`. */
export interface TraceResponse {
    entry?: JournalEntry;
    /** null: no steps were kept for this request (too old, or recorded by an older adapter version). */
    steps?: JournalStep[] | null;
    error?: string;
}

export interface RequestDetailsProps {
    /** The request as the chat has it — live, so a running request fills in while the dialog is open. */
    entry: JournalEntry;
    fetchTrace: (id: string) => Promise<TraceResponse>;
    dark: boolean;
    onClose: () => void;
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** Clipboard API where allowed (https/localhost), the old textarea trick over plain http. */
async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // not a secure context
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
        ok = document.execCommand('copy');
    } catch {
        ok = false;
    }
    document.body.removeChild(ta);
    return ok;
}

function download(name: string, text: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "+120 ms", "−0.8 s" — a step's start relative to the request. */
function offset(ms: number): string {
    return `${ms < 0 ? '−' : '+'}${formatMs(Math.abs(ms))}`;
}

/** A tool result arrives as a JSON string: show it pretty-printed when it is one. */
function parseJsonText(text: string): unknown {
    const s = text.trim();
    if (!/^[[{]/.test(s)) {
        return undefined;
    }
    try {
        return JSON.parse(s);
    } catch {
        return undefined;
    }
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A chat message of either API (`{role, content}` or OpenAI's `{role, tool_calls}`). */
function isMessage(v: unknown): v is Record<string, unknown> {
    return isRecord(v) && typeof v.role === 'string' && ('content' in v || 'tool_calls' in v);
}

/** Anthropic content blocks: text, tool_use, tool_result, thinking. */
function isBlockList(v: unknown): v is Record<string, unknown>[] {
    return (
        Array.isArray(v) &&
        v.length > 0 &&
        v.every(
            b =>
                isRecord(b) &&
                typeof b.type === 'string' &&
                ('text' in b || 'input' in b || 'content' in b || 'thinking' in b),
        )
    );
}

// ── data rendering ─────────────────────────────────────────────────────────────────────────────────────

interface ViewCtx {
    dark: boolean;
    onCopy: (text: string) => void;
}

function CopyButton(props: { text: string; ctx: ViewCtx }): React.JSX.Element {
    return (
        <Tooltip title={I18n.t('custom_assistant_Copy')}>
            <IconButton
                size="small"
                onClick={e => {
                    e.stopPropagation();
                    props.ctx.onCopy(props.text);
                }}
                sx={{ position: 'absolute', top: 2, right: 2, p: 0.25, opacity: 0.5, '&:hover': { opacity: 1 } }}
            >
                <CopyIcon sx={{ fontSize: '0.9rem' }} />
            </IconButton>
        </Tooltip>
    );
}

/** A block of text or JSON: scrollable, wrapped, with a copy button. */
function Pre(props: { text: string; ctx: ViewCtx; maxHeight?: number }): React.JSX.Element {
    return (
        <Box sx={{ position: 'relative' }}>
            <Box
                component="pre"
                sx={{
                    m: 0,
                    p: 1,
                    pr: 3.5,
                    fontFamily: MONO,
                    fontSize: '0.74rem',
                    lineHeight: 1.45,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: props.maxHeight ?? 360,
                    overflow: 'auto',
                    borderRadius: 1,
                    background: props.ctx.dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
                }}
            >
                {props.text}
            </Box>
            <CopyButton
                text={props.text}
                ctx={props.ctx}
            />
        </Box>
    );
}

function Json(props: { value: unknown; ctx: ViewCtx }): React.JSX.Element {
    return (
        <Pre
            text={JSON.stringify(props.value, null, 2)}
            ctx={props.ctx}
        />
    );
}

function TextValue(props: { text: string; ctx: ViewCtx }): React.JSX.Element {
    const parsed = parseJsonText(props.text);
    if (parsed !== undefined) {
        return (
            <Json
                value={parsed}
                ctx={props.ctx}
            />
        );
    }
    if (props.text.length > 100 || props.text.includes('\n')) {
        return (
            <Pre
                text={props.text}
                ctx={props.ctx}
            />
        );
    }
    return <span style={{ fontFamily: MONO, fontSize: '0.78rem' }}>{formatValue(props.text)}</span>;
}

const ROLE_COLORS: Record<string, string> = {
    system: '#757575',
    user: '#1e88e5',
    assistant: '#43a047',
    tool: '#fb8c00',
};

function SmallChip(props: { label: string; color?: string }): React.JSX.Element {
    return (
        <Chip
            size="small"
            label={props.label}
            sx={{
                height: 18,
                fontSize: '0.68rem',
                mr: 0.5,
                color: props.color ? '#fff' : 'inherit',
                background: props.color || 'rgba(127,127,127,0.25)',
                '& .MuiChip-label': { px: 0.75 },
            }}
        />
    );
}

/** One Anthropic content block. */
function Block(props: { block: Record<string, unknown>; ctx: ViewCtx }): React.JSX.Element {
    const { block, ctx } = props;
    const cached = block.cache_control ? <SmallChip label="cache_control" /> : null;
    let head: React.ReactNode = null;
    let body: React.ReactNode;
    if (block.type === 'text') {
        body = (
            <Pre
                text={String(block.text ?? '')}
                ctx={ctx}
            />
        );
    } else if (block.type === 'tool_use') {
        head = `🔧 ${String(block.name)}`;
        body = (
            <Json
                value={block.input}
                ctx={ctx}
            />
        );
    } else if (block.type === 'tool_result') {
        head = `↩ ${I18n.t('custom_assistant_Tool result')}`;
        body =
            typeof block.content === 'string' ? (
                <TextValue
                    text={block.content}
                    ctx={ctx}
                />
            ) : (
                <Json
                    value={block.content}
                    ctx={ctx}
                />
            );
    } else if (block.type === 'thinking') {
        head = '💭 thinking';
        body = (
            <Pre
                text={String(block.thinking ?? '')}
                ctx={ctx}
            />
        );
    } else {
        body = (
            <Json
                value={block}
                ctx={ctx}
            />
        );
    }
    return (
        <Box sx={{ mb: 0.75 }}>
            {head || cached ? (
                <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.25, fontFamily: MONO, fontSize: '0.76rem' }}>
                    <span style={{ marginRight: 6 }}>{head}</span>
                    {cached}
                </Box>
            ) : null}
            {body}
        </Box>
    );
}

/** A message of the model conversation, as the provider got or sent it. */
function Message(props: { msg: Record<string, unknown>; ctx: ViewCtx }): React.JSX.Element {
    const { msg, ctx } = props;
    const role = String(msg.role);
    const content = msg.content;
    const calls = Array.isArray(msg.tool_calls) ? (msg.tool_calls as Record<string, unknown>[]) : [];
    return (
        <Box
            sx={{
                mb: 1,
                pl: 1,
                borderLeft: `3px solid ${ROLE_COLORS[role] || '#9e9e9e'}`,
            }}
        >
            <Box sx={{ mb: 0.5 }}>
                <SmallChip
                    label={role}
                    color={ROLE_COLORS[role]}
                />
            </Box>
            {typeof content === 'string' && content ? (
                <TextValue
                    text={content}
                    ctx={ctx}
                />
            ) : null}
            {isBlockList(content)
                ? content.map((b, i) => (
                      <Block
                          key={i}
                          block={b}
                          ctx={ctx}
                      />
                  ))
                : null}
            {calls.map((c, i) => {
                const fn = isRecord(c.function) ? c.function : {};
                const args =
                    typeof fn.arguments === 'string' ? (parseJsonText(fn.arguments) ?? fn.arguments) : fn.arguments;
                return (
                    <Box
                        key={i}
                        sx={{ mb: 0.75 }}
                    >
                        <Box sx={{ fontFamily: MONO, fontSize: '0.76rem', mb: 0.25 }}>🔧 {String(fn.name)}</Box>
                        <Json
                            value={args}
                            ctx={ctx}
                        />
                    </Box>
                );
            })}
        </Box>
    );
}

/** Any value of a step's data, rendered for reading rather than as raw JSON where that helps. */
function Value(props: { value: unknown; ctx: ViewCtx; depth: number }): React.JSX.Element {
    const { value, ctx, depth } = props;
    if (value === null || value === undefined) {
        return <span style={{ opacity: 0.5 }}>—</span>;
    }
    if (typeof value === 'string') {
        return (
            <TextValue
                text={value}
                ctx={ctx}
            />
        );
    }
    if (typeof value !== 'object') {
        return <span style={{ fontFamily: MONO, fontSize: '0.78rem' }}>{String(value)}</span>;
    }
    if (Array.isArray(value) && value.length && value.every(isMessage)) {
        return (
            <Box>
                {value.map((m, i) => (
                    <Message
                        key={i}
                        msg={m}
                        ctx={ctx}
                    />
                ))}
            </Box>
        );
    }
    if (isBlockList(value)) {
        return (
            <Box>
                {value.map((b, i) => (
                    <Block
                        key={i}
                        block={b}
                        ctx={ctx}
                    />
                ))}
            </Box>
        );
    }
    if (isMessage(value)) {
        return (
            <Message
                msg={value}
                ctx={ctx}
            />
        );
    }
    if (Array.isArray(value) && value.every(v => typeof v !== 'object' || v === null)) {
        const text = value.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ');
        return text.length > 160 ? (
            <Pre
                text={text}
                ctx={ctx}
            />
        ) : (
            <span style={{ fontFamily: MONO, fontSize: '0.78rem' }}>{text || '[]'}</span>
        );
    }
    if (isRecord(value) && depth < 2) {
        return (
            <Fields
                data={value}
                ctx={ctx}
                depth={depth + 1}
            />
        );
    }
    return (
        <Json
            value={value}
            ctx={ctx}
        />
    );
}

/** An object as label/value rows. */
function Fields(props: { data: Record<string, unknown>; ctx: ViewCtx; depth: number }): React.JSX.Element {
    const keys = Object.keys(props.data).filter(k => props.data[k] !== undefined);
    return (
        <Box
            sx={{ display: 'grid', gridTemplateColumns: 'minmax(90px, max-content) 1fr', columnGap: 1.5, rowGap: 0.5 }}
        >
            {keys.map(k => (
                <React.Fragment key={k}>
                    <Box sx={{ fontFamily: MONO, fontSize: '0.74rem', opacity: 0.65, pt: '2px' }}>{k}</Box>
                    <Box sx={{ minWidth: 0 }}>
                        <Value
                            value={props.data[k]}
                            ctx={props.ctx}
                            depth={props.depth}
                        />
                    </Box>
                </React.Fragment>
            ))}
        </Box>
    );
}

// ── the dialog ───────────────────────────────────────────────────────────────────────────────────────────

function Fact(props: { label: string; children: React.ReactNode }): React.JSX.Element {
    return (
        <Box sx={{ minWidth: 0 }}>
            <Typography
                variant="caption"
                component="div"
                sx={{ opacity: 0.6, lineHeight: 1.2 }}
            >
                {props.label}
            </Typography>
            <Box sx={{ fontSize: '0.85rem', wordBreak: 'break-word' }}>{props.children}</Box>
        </Box>
    );
}

/**
 * Everything the adapter knows about one request — opened by clicking a question or answer in the chat.
 * Above: who asked, what came out, the timings and token counts. Below, step by step: speech recognition,
 * routine/NLU decisions (and why a part could not run locally), the full prompt and every model round with
 * what was sent and returned, tool calls with complete arguments and results, state reads and writes,
 * speech synthesis. A waterfall bar per step shows where the time went; the raw JSON can be copied or
 * downloaded to attach to an issue.
 */
export default function RequestDetailsDialog(props: RequestDetailsProps): React.JSX.Element {
    const { entry, dark } = props;
    const [steps, setSteps] = React.useState<JournalStep[] | null | undefined>(undefined);
    const [error, setError] = React.useState('');
    const [tab, setTab] = React.useState(0);
    const [open, setOpen] = React.useState<Record<number, boolean>>({});
    const [copied, setCopied] = React.useState(false);
    const loading = React.useRef(false);
    const again = React.useRef(false);

    const { fetchTrace } = props;
    const load = React.useCallback(async (): Promise<void> => {
        // The entry changes on every tool call of a running request: never more than one fetch in flight.
        if (loading.current) {
            again.current = true;
            return;
        }
        loading.current = true;
        try {
            do {
                again.current = false;
                try {
                    const res = await fetchTrace(entry.id);
                    setError(res.error || '');
                    setSteps(res.error ? null : (res.steps ?? null));
                } catch (e) {
                    setError((e as Error).message);
                }
            } while (again.current);
        } finally {
            loading.current = false;
        }
    }, [fetchTrace, entry.id]);

    React.useEffect(() => {
        void load();
    }, [entry, load]);

    const ctx: ViewCtx = {
        dark,
        onCopy: text => {
            void copyText(text).then(ok => {
                if (ok) {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                }
            });
        },
    };

    const list = [...(steps || [])].map((s, i) => ({ ...s, i })).sort((a, b) => a.t - b.t || a.i - b.i);
    const start = Math.min(0, ...list.map(s => s.t));
    const end = Math.max(entry.ms || 0, ...list.map(s => s.t + (s.ms || 0)));
    const span = Math.max(1, end - start);
    const allOpen = list.length > 0 && list.every(s => open[s.i] || s.data === undefined);
    const raw = JSON.stringify({ entry, steps: steps ?? null }, null, 2);

    const box = {
        p: 1,
        borderRadius: 1,
        background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
        whiteSpace: 'pre-wrap' as const,
        wordBreak: 'break-word' as const,
        fontSize: '0.9rem',
    };

    const renderStep = (s: JournalStep & { i: number }): React.JSX.Element => {
        const color = s.level === 'error' ? '#c62828' : STAGE_COLORS[s.stage] || '#9e9e9e';
        const expandable = s.data !== undefined || !!s.tokens;
        const isOpen = !!open[s.i];
        const toggle = (): void => setOpen(o => ({ ...o, [s.i]: !o[s.i] }));
        const left = ((s.t - start) / span) * 100;
        const width = s.ms !== undefined ? Math.max((s.ms / span) * 100, 0.4) : 0;
        return (
            <Box
                key={s.i}
                sx={{
                    borderBottom: `1px solid ${dark ? '#333' : '#eee'}`,
                    background:
                        s.level === 'error'
                            ? 'rgba(198,40,40,0.08)'
                            : s.level === 'warn'
                              ? 'rgba(251,140,0,0.08)'
                              : undefined,
                }}
            >
                <Box
                    role={expandable ? 'button' : undefined}
                    tabIndex={expandable ? 0 : undefined}
                    onClick={expandable ? toggle : undefined}
                    onKeyDown={e => {
                        if (expandable && (e.key === 'Enter' || e.key === ' ')) {
                            e.preventDefault();
                            toggle();
                        }
                    }}
                    sx={{
                        display: 'grid',
                        gridTemplateColumns: '64px 132px 1fr 64px 16px',
                        alignItems: 'center',
                        columnGap: 1,
                        px: 1,
                        pt: 0.6,
                        cursor: expandable ? 'pointer' : 'default',
                        '&:hover': expandable
                            ? { background: dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)' }
                            : {},
                    }}
                >
                    <Box sx={{ fontFamily: MONO, fontSize: '0.72rem', opacity: 0.6, textAlign: 'right' }}>
                        {offset(s.t)}
                    </Box>
                    <Box>
                        <SmallChip
                            label={STAGE_LABELS[s.stage] ? I18n.t(STAGE_LABELS[s.stage]) : s.stage}
                            color={STAGE_COLORS[s.stage]}
                        />
                    </Box>
                    <Box
                        sx={{
                            fontSize: '0.82rem',
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: isOpen ? 'normal' : 'nowrap',
                            color: s.level === 'error' ? 'error.main' : s.level === 'warn' ? 'warning.main' : undefined,
                        }}
                        title={s.title}
                    >
                        {s.title}
                        {s.tokens ? (
                            <span style={{ opacity: 0.6, fontSize: '0.72rem', marginLeft: 8 }}>
                                {formatTokens(s.tokens)}
                            </span>
                        ) : null}
                    </Box>
                    <Box sx={{ fontFamily: MONO, fontSize: '0.72rem', textAlign: 'right', opacity: 0.8 }}>
                        {formatMs(s.ms)}
                    </Box>
                    <Box sx={{ fontSize: '0.7rem', opacity: 0.5 }}>{expandable ? (isOpen ? '▾' : '▸') : ''}</Box>
                </Box>
                {/* Waterfall: where in the request this step ran, and for how long. */}
                <Box sx={{ position: 'relative', height: 4, mx: 1, mt: 0.4, mb: 0.6, ml: 'calc(64px + 132px + 24px)' }}>
                    <Box
                        sx={{
                            position: 'absolute',
                            inset: 0,
                            borderRadius: 2,
                            background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
                        }}
                    />
                    <Box
                        sx={{
                            position: 'absolute',
                            top: width ? 0 : -1,
                            height: width ? 4 : 6,
                            left: `${left}%`,
                            width: width ? `${width}%` : 2,
                            borderRadius: 2,
                            background: color,
                        }}
                    />
                </Box>
                {isOpen && expandable ? (
                    <Box sx={{ px: 1, pb: 1.5, ml: { xs: 0, sm: 'calc(64px + 8px)' } }}>
                        {s.tokens ? (
                            <Typography
                                variant="caption"
                                component="div"
                                sx={{ mb: 0.5, opacity: 0.75 }}
                            >
                                Tokens: {formatTokens(s.tokens)}
                            </Typography>
                        ) : null}
                        {s.data !== undefined ? (
                            <Value
                                value={s.data}
                                ctx={ctx}
                                depth={0}
                            />
                        ) : null}
                    </Box>
                ) : null}
            </Box>
        );
    };

    const renderTimeline = (): React.JSX.Element => {
        if (steps === undefined && !error) {
            return (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 2 }}>
                    <CircularProgress size={18} />
                    <Typography variant="body2">{I18n.t('custom_assistant_Loading…')}</Typography>
                </Box>
            );
        }
        if (!list.length) {
            return (
                <Typography
                    variant="body2"
                    sx={{ p: 2, opacity: 0.7 }}
                >
                    {error || I18n.t('custom_assistant_No processing steps were recorded for this request.')}
                </Typography>
            );
        }
        return <Box>{list.map(renderStep)}</Box>;
    };

    const renderStates = (): React.JSX.Element => {
        const mono = { fontFamily: MONO, fontSize: '0.78rem' };
        return (
            <Box sx={{ p: 1 }}>
                <Typography
                    variant="subtitle2"
                    sx={{ mb: 0.5 }}
                >
                    {I18n.t('custom_assistant_Tool calls')} ({entry.tools.length})
                </Typography>
                {entry.tools.length ? (
                    entry.tools.map((t, i) => (
                        <Box
                            key={i}
                            sx={{ ...mono, mb: 0.75, color: t.error ? 'error.main' : undefined }}
                        >
                            🔧 <b>{t.name}</b>({JSON.stringify(t.args)}){' '}
                            <span style={{ opacity: 0.6 }}>{formatMs(t.ms)}</span>
                            <Box sx={{ pl: 2.5, opacity: 0.85 }}>→ {t.error ? `⚠ ${t.error}` : t.result}</Box>
                        </Box>
                    ))
                ) : (
                    <Typography
                        variant="body2"
                        sx={{ opacity: 0.6, mb: 1 }}
                    >
                        —
                    </Typography>
                )}
                <Typography
                    variant="subtitle2"
                    sx={{ mt: 2, mb: 0.5 }}
                >
                    {I18n.t('custom_assistant_States read')} ({entry.read.length})
                </Typography>
                {entry.read.length ? (
                    entry.read.map(id => (
                        <Box
                            key={id}
                            sx={mono}
                        >
                            📖 {id}
                        </Box>
                    ))
                ) : (
                    <Typography
                        variant="body2"
                        sx={{ opacity: 0.6 }}
                    >
                        —
                    </Typography>
                )}
                <Typography
                    variant="subtitle2"
                    sx={{ mt: 2, mb: 0.5 }}
                >
                    {I18n.t('custom_assistant_States written')} ({entry.written.length})
                </Typography>
                {entry.written.length ? (
                    entry.written.map((w, i) => (
                        <Box
                            key={i}
                            sx={mono}
                        >
                            ✏️ {w.id} = {formatValue(w.value)}
                        </Box>
                    ))
                ) : (
                    <Typography
                        variant="body2"
                        sx={{ opacity: 0.6 }}
                    >
                        —
                    </Typography>
                )}
            </Box>
        );
    };

    const who = entry.satellite || entry.source;
    const time = new Date(entry.ts).toLocaleString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
    });

    return (
        <Dialog
            open
            onClose={props.onClose}
            maxWidth="lg"
            fullWidth
            scroll="paper"
            slotProps={{ paper: { sx: { height: '90vh' } } }}
        >
            <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                    {I18n.t('custom_assistant_Request details')}
                    <Typography
                        variant="caption"
                        component="span"
                        sx={{ ml: 1, opacity: 0.6, fontFamily: MONO }}
                    >
                        {entry.id}
                    </Typography>
                </Box>
                {copied ? (
                    <Typography
                        variant="caption"
                        color="success.main"
                    >
                        {I18n.t('custom_assistant_Copied')}
                    </Typography>
                ) : null}
                <Tooltip title={I18n.t('custom_assistant_Copy everything as JSON')}>
                    <IconButton
                        size="small"
                        onClick={() => ctx.onCopy(raw)}
                    >
                        <CopyIcon fontSize="small" />
                    </IconButton>
                </Tooltip>
                <Tooltip title={I18n.t('custom_assistant_Download as JSON')}>
                    <IconButton
                        size="small"
                        onClick={() => download(`assistant-request-${entry.id}.json`, raw)}
                    >
                        <DownloadIcon fontSize="small" />
                    </IconButton>
                </Tooltip>
                <IconButton
                    size="small"
                    onClick={props.onClose}
                >
                    <CloseIcon fontSize="small" />
                </IconButton>
            </DialogTitle>
            <DialogContent dividers>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.5, mb: 1 }}>
                    <SmallChip label={I18n.t(TRANSPORT_LABELS[entry.transport] || entry.transport)} />
                    {who && who !== 'chat' ? <SmallChip label={who} /> : null}
                    {entry.room && entry.room !== who ? <SmallChip label={entry.room} /> : null}
                    {entry.wakeWord !== undefined ? (
                        <SmallChip label={`🎙 ${entry.wakeWord || I18n.t('custom_assistant_follow-up')}`} />
                    ) : null}
                    {entry.tier ? (
                        <SmallChip
                            label={I18n.t(TIER_LABELS[entry.tier])}
                            color={TIER_COLORS[entry.tier]}
                        />
                    ) : null}
                    {entry.detail ? (
                        <Typography
                            variant="caption"
                            sx={{ fontFamily: MONO }}
                        >
                            {entry.detail}
                        </Typography>
                    ) : null}
                    {!entry.done ? (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ml: 1 }}>
                            <CircularProgress size={12} />
                            <Typography variant="caption">{I18n.t('custom_assistant_in progress')}</Typography>
                        </Box>
                    ) : null}
                </Box>

                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1, mb: 1.5 }}>
                    <Box>
                        <Typography
                            variant="caption"
                            sx={{ opacity: 0.6 }}
                        >
                            {I18n.t('custom_assistant_Question')}
                        </Typography>
                        <Box sx={box}>{entry.question}</Box>
                    </Box>
                    <Box>
                        <Typography
                            variant="caption"
                            sx={{ opacity: 0.6 }}
                        >
                            {I18n.t(entry.error ? 'custom_assistant_Error' : 'custom_assistant_Answer')}
                        </Typography>
                        <Box sx={{ ...box, color: entry.error ? 'error.main' : undefined }}>
                            {entry.error ||
                                entry.answer ||
                                (entry.done ? (
                                    <i style={{ opacity: 0.6 }}>{I18n.t('custom_assistant_(no spoken answer)')}</i>
                                ) : (
                                    '…'
                                ))}
                        </Box>
                    </Box>
                </Box>

                <Box
                    sx={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                        gap: 1.5,
                        mb: 1.5,
                    }}
                >
                    <Fact label={I18n.t('custom_assistant_Time')}>{time}</Fact>
                    <Fact label={I18n.t('custom_assistant_Total duration')}>
                        {entry.done ? formatMs(entry.ms) : '…'}
                    </Fact>
                    <Fact label={I18n.t('custom_assistant_Source')}>{entry.source || '—'}</Fact>
                    {entry.audioMs !== undefined ? (
                        <Fact label={I18n.t('custom_assistant_Recorded audio')}>{formatMs(entry.audioMs)}</Fact>
                    ) : null}
                    {entry.sttMs !== undefined ? (
                        <Fact label={I18n.t('custom_assistant_Speech recognition')}>{formatMs(entry.sttMs)}</Fact>
                    ) : null}
                    {entry.ttsMs !== undefined ? (
                        <Fact label={I18n.t('custom_assistant_Speech synthesis')}>{formatMs(entry.ttsMs)}</Fact>
                    ) : null}
                    {entry.replyAudioMs !== undefined ? (
                        <Fact label={I18n.t('custom_assistant_Reply audio')}>{formatMs(entry.replyAudioMs)}</Fact>
                    ) : null}
                    {entry.tokens ? <Fact label="Tokens">{formatTokens(entry.tokens)}</Fact> : null}
                    <Fact label={I18n.t('custom_assistant_Tool calls')}>{entry.tools.length}</Fact>
                    <Fact label={I18n.t('custom_assistant_States read')}>{entry.read.length}</Fact>
                    <Fact label={I18n.t('custom_assistant_States written')}>{entry.written.length}</Fact>
                    {entry.followUp ? (
                        <Fact label={I18n.t('custom_assistant_Follow-up')}>
                            {I18n.t('custom_assistant_waits for reply')}
                        </Fact>
                    ) : null}
                </Box>

                <Box
                    sx={{
                        display: 'flex',
                        alignItems: 'center',
                        borderBottom: `1px solid ${dark ? '#444' : '#ddd'}`,
                        mb: 0.5,
                    }}
                >
                    <Tabs
                        value={tab}
                        onChange={(_e, v: number) => setTab(v)}
                        sx={{ flex: 1, minHeight: 36, '& .MuiTab-root': { minHeight: 36, py: 0 } }}
                    >
                        <Tab label={`${I18n.t('custom_assistant_Steps')}${list.length ? ` (${list.length})` : ''}`} />
                        <Tab label={I18n.t('custom_assistant_Tools & states')} />
                        <Tab label="JSON" />
                    </Tabs>
                    {tab === 0 && list.length ? (
                        <Tooltip
                            title={I18n.t(allOpen ? 'custom_assistant_Collapse all' : 'custom_assistant_Expand all')}
                        >
                            <IconButton
                                size="small"
                                onClick={() => setOpen(allOpen ? {} : Object.fromEntries(list.map(s => [s.i, true])))}
                            >
                                {allOpen ? <CollapseIcon fontSize="small" /> : <ExpandIcon fontSize="small" />}
                            </IconButton>
                        </Tooltip>
                    ) : null}
                </Box>
                {tab === 0 ? renderTimeline() : null}
                {tab === 1 ? renderStates() : null}
                {tab === 2 ? (
                    <Pre
                        text={raw}
                        ctx={ctx}
                        maxHeight={10_000}
                    />
                ) : null}
            </DialogContent>
            <DialogActions>
                <Button onClick={props.onClose}>{I18n.t('custom_assistant_Close')}</Button>
            </DialogActions>
        </Dialog>
    );
}
