/** What the chat and the request-details dialog share about the adapter's journal (mirrors `src/lib/journal.ts`). */

export type JournalTier = 'stop' | 'askReply' | 'routine' | 'nlu' | 'localLlm' | 'cloud' | 'none';

export interface JournalTokens {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
}

/** One request as recorded by the adapter's journal. */
export interface JournalEntry {
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
    audioMs?: number;
    ttsMs?: number;
    replyAudioMs?: number;
    question: string;
    answer?: string;
    error?: string;
    tier?: JournalTier;
    detail?: string;
    tools: { name: string; args: Record<string, unknown>; ms: number; result?: string; error?: string }[];
    read: string[];
    written: { id: string; value: unknown }[];
    followUp?: boolean;
    tokens?: JournalTokens;
}

/** One processing step of a request (fetched on demand via `getJournalTrace`). */
export interface JournalStep {
    /** Start, ms after the request started (negative for speech recognition). */
    t: number;
    ms?: number;
    stage: string;
    title: string;
    level?: 'warn' | 'error';
    tokens?: JournalTokens;
    data?: unknown;
}

export const TRANSPORT_LABELS: Record<JournalEntry['transport'], string> = {
    chat: 'Chat',
    script: 'custom_assistant_Script',
    state: 'custom_assistant_State',
    telegram: 'Telegram',
    esphome: 'ESPHome',
    udp: 'UDP',
    native: 'ioBroker',
    wyoming: 'Wyoming',
};

export const TIER_LABELS: Record<JournalTier, string> = {
    stop: 'custom_assistant_Stop word',
    askReply: 'custom_assistant_Reply to a question',
    routine: 'custom_assistant_Routine',
    nlu: 'custom_assistant_Rule-based NLU',
    localLlm: 'custom_assistant_Local LLM',
    cloud: 'custom_assistant_Cloud LLM',
    none: 'custom_assistant_Not understood',
};

export const TIER_COLORS: Record<JournalTier, string> = {
    stop: '#78909c',
    askReply: '#78909c',
    routine: '#00897b',
    nlu: '#43a047',
    localLlm: '#8e24aa',
    cloud: '#1e88e5',
    none: '#e53935',
};

/** Pipeline stages of a trace step: the tiers plus what happens around them. */
export const STAGE_LABELS: Record<string, string> = {
    ...TIER_LABELS,
    request: 'custom_assistant_Request',
    stt: 'custom_assistant_Speech recognition',
    context: 'custom_assistant_Context',
    youtube: 'YouTube',
    tool: 'custom_assistant_Tool',
    state: 'custom_assistant_State',
    answer: 'custom_assistant_Answer',
    tts: 'custom_assistant_Speech synthesis',
    error: 'custom_assistant_Error',
};

export const STAGE_COLORS: Record<string, string> = {
    ...TIER_COLORS,
    request: '#607d8b',
    stt: '#00838f',
    context: '#8d6e63',
    youtube: '#ff7043',
    tool: '#fb8c00',
    state: '#6d4c41',
    answer: '#3949ab',
    tts: '#00acc1',
    error: '#c62828',
};

export function formatValue(v: unknown): string {
    return typeof v === 'string' ? `"${v}"` : JSON.stringify(v);
}

export function formatMs(ms: number | undefined): string {
    if (ms === undefined) {
        return '';
    }
    return Math.abs(ms) < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** "1 234 in · 56 out · 1 200 cached" */
export function formatTokens(t: JournalTokens): string {
    const n = (v: number): string => v.toLocaleString();
    let text = `${n(t.input)} in · ${n(t.output)} out`;
    if (t.cacheRead) {
        text += ` · ${n(t.cacheRead)} cached`;
    }
    if (t.cacheWrite) {
        text += ` · ${n(t.cacheWrite)} to cache`;
    }
    return text;
}
