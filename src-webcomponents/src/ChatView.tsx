/**
 * What `<iob-assistant-chat>` shows: the conversation in bubbles and the composer below. The element keeps the
 * conversation and talks to the adapter; this view keeps only what is typed and where the list is scrolled to.
 */
import { useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent, type CSSProperties } from 'react';

import { formatMs, formatValue, TIER_COLORS, type JournalEntry } from '../../src-admin/src/journal';

import { Icon, ICONS } from './icons';
import type { ChatWords } from './chatWords';

/** A word of the chat */
type ChatWord = Parameters<ChatWords>[0];

/** An error that never reached the journal, and everything while the journal is off */
export interface LocalMessage {
    role: 'user' | 'assistant' | 'error';
    text: string;
    /** ms */
    ts: number;
}

/** One line of the conversation: a request of the journal, or a local message */
export type ChatItem = { key: string; ts: number } & (
    { entry: JournalEntry; message?: undefined } | { message: LocalMessage; entry?: undefined }
);

/** What the dialog mode is doing: '' = off */
export type DialogStatus = '' | 'listening' | 'hearing' | 'thinking' | 'speaking';

export interface ChatViewProps {
    items: ChatItem[];
    /** Every request of the journal is shown: say where each one came from */
    allRequests: boolean;
    /** Who answered, how long it took, what it wrote */
    details: boolean;
    /** The instance runs */
    ready: boolean;
    /** An `ask` without the journal is under way: the view shows that it thinks */
    thinking: boolean;
    /** An `ask` is under way */
    sending: boolean;
    /** The speech recognition of the browser is there */
    micSupported: boolean;
    listening: boolean;
    /** The dialog mode can be used in this browser (secure context, microphone) */
    dialogSupported: boolean;
    /** Voice is on in the instance settings: the adapter recognises what is said in the dialog mode */
    voiceEnabled: boolean;
    dialog: DialogStatus;
    /** 0…1 of the speech threshold */
    dialogLevel: number;
    /** Answers can be read aloud */
    speakSupported: boolean;
    speak: boolean;
    editMode: boolean;
    /** BCP 47, for the times */
    locale: string;
    word: ChatWords;
    onSend: (text: string) => void;
    onMic: () => void;
    onDialog: () => void;
    onSpeak: () => void;
}

const TRANSPORT_WORDS: Partial<Record<JournalEntry['transport'], ChatWord>> = {
    chat: 'transport_chat',
    script: 'transport_script',
    state: 'transport_state',
};

const TRANSPORT_NAMES: Record<JournalEntry['transport'], string> = {
    chat: 'Chat',
    script: 'Script',
    state: 'State',
    telegram: 'Telegram',
    esphome: 'ESPHome',
    udp: 'UDP',
    native: 'ioBroker',
    wyoming: 'Wyoming',
};

function formatTime(ts: number, locale: string): string {
    try {
        return new Date(ts).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    } catch {
        return new Date(ts).toLocaleTimeString();
    }
}

interface BubbleProps {
    role: LocalMessage['role'];
    ts: number;
    locale: string;
    header?: JSX.Element | null;
    children: JSX.Element | string;
}

function Bubble({ role, ts, locale, header, children }: BubbleProps): JSX.Element {
    return (
        <div className={`row ${role}`}>
            <div className="bubble">
                {header}
                <div>{children}</div>
                <div className="time">{formatTime(ts, locale)}</div>
            </div>
        </div>
    );
}

/** Above a question: where it came from - only where it can be anything but this chat, or with the details */
function Origin({
    entry,
    allRequests,
    details,
    word,
}: {
    entry: JournalEntry;
    allRequests: boolean;
    details: boolean;
    word: ChatWords;
}): JSX.Element | null {
    const chips: string[] = [];
    if (allRequests) {
        const transport = TRANSPORT_WORDS[entry.transport];
        chips.push(transport ? word(transport) : TRANSPORT_NAMES[entry.transport] || entry.transport);
        const who = entry.satellite || (entry.transport === 'chat' || entry.transport === 'state' ? '' : entry.source);
        if (who) {
            chips.push(who);
        }
        if (entry.room && entry.room !== who) {
            chips.push(entry.room);
        }
    }
    if (details && entry.wakeWord !== undefined) {
        chips.push(`🎙 ${entry.wakeWord || word('followUp')}`);
    }
    if (details && entry.sttMs !== undefined) {
        chips.push(`STT ${formatMs(entry.sttMs)}`);
    }
    if (!chips.length) {
        return null;
    }
    return (
        <div className="chips">
            {chips.map((chip, i) => (
                <span
                    key={i}
                    className="chip"
                >
                    {chip}
                </span>
            ))}
        </div>
    );
}

/** Below an answer: which tier answered, how long it took, what it wrote */
function Details({ entry, word }: { entry: JournalEntry; word: ChatWords }): JSX.Element | null {
    if (!entry.done) {
        return null;
    }
    return (
        <div className="details">
            <div className="line">
                {entry.tier ? (
                    <span
                        className="chip tier"
                        style={{ '--tier': TIER_COLORS[entry.tier] } as CSSProperties}
                    >
                        {word(`tier_${entry.tier}`)}
                    </span>
                ) : null}
                {entry.detail ? <span className="mono">{entry.detail}</span> : null}
                {entry.ms !== undefined ? <span>{formatMs(entry.ms)}</span> : null}
                {entry.ttsMs !== undefined ? <span>TTS {formatMs(entry.ttsMs)}</span> : null}
                {entry.followUp ? <span>{word('waitsForReply')}</span> : null}
            </div>
            {entry.written.map((w, i) => (
                <div
                    key={i}
                    className="mono"
                    title={word('States written')}
                >
                    ✏️ {w.id} = {formatValue(w.value)}
                </div>
            ))}
        </div>
    );
}

function Thinking({ word }: { word: ChatWords }): JSX.Element {
    return (
        <div className="thinking">
            <span className="spinner" />
            <span>{word('Thinking…')}</span>
        </div>
    );
}

function Entry({
    entry,
    allRequests,
    details,
    locale,
    word,
}: {
    entry: JournalEntry;
    allRequests: boolean;
    details: boolean;
    locale: string;
    word: ChatWords;
}): JSX.Element {
    let answer: JSX.Element;
    if (!entry.done) {
        answer = <Thinking word={word} />;
    } else if (entry.error) {
        answer = (
            <Bubble
                role="error"
                ts={entry.ts + (entry.ms || 0)}
                locale={locale}
            >
                {entry.error}
            </Bubble>
        );
    } else {
        answer = (
            <Bubble
                role="assistant"
                ts={entry.ts + (entry.ms || 0)}
                locale={locale}
            >
                {entry.answer || <span className="silent">{word('noSpokenAnswer')}</span>}
            </Bubble>
        );
    }
    return (
        <>
            <Bubble
                role="user"
                ts={entry.ts}
                locale={locale}
                header={
                    <Origin
                        entry={entry}
                        allRequests={allRequests}
                        details={details}
                        word={word}
                    />
                }
            >
                {entry.question}
            </Bubble>
            {answer}
            {details ? (
                <Details
                    entry={entry}
                    word={word}
                />
            ) : null}
        </>
    );
}

function placeholder(dialog: DialogStatus, listening: boolean): ChatWord {
    switch (dialog) {
        case 'listening':
            return 'Dialog: listening…';
        case 'hearing':
            return 'Dialog: hearing you…';
        case 'thinking':
            return 'Dialog: thinking…';
        case 'speaking':
            return 'Dialog: speaking…';
        default:
            return listening ? 'Listening…' : 'Type a message…';
    }
}

export function ChatView(props: ChatViewProps): JSX.Element {
    const { items, ready, sending, dialog, listening, editMode, word, locale } = props;
    const [input, setInput] = useState('');
    const list = useRef<HTMLDivElement>(null);
    /** The list stays at its end while the user has not scrolled up */
    const stick = useRef(true);

    useLayoutEffect(() => {
        const el = list.current;
        if (el && stick.current) {
            el.scrollTop = el.scrollHeight;
        }
    });

    const canType = ready && !editMode && !dialog;
    const send = (): void => {
        const text = input.trim();
        if (text && canType && !sending) {
            props.onSend(text);
            setInput('');
            stick.current = true;
        }
    };
    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
        // Enter sends, Shift+Enter starts a new line
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    };

    let dialogTitle: ChatWord = 'Dialog: everything you say becomes a question';
    if (dialog) {
        dialogTitle = 'End the dialog';
    } else if (!props.voiceEnabled) {
        dialogTitle = 'voiceOff';
    }
    const levelClass = dialog === 'hearing' ? 'hearing' : dialog === 'speaking' ? 'speaking busy' : 'busy';

    return (
        <div className={`chat${editMode ? ' edit' : ''}`}>
            {!ready ? <div className="banner">{word('Start the assistant instance to chat.')}</div> : null}
            <div
                ref={list}
                className="list"
                onScroll={() => {
                    const el = list.current;
                    stick.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 60;
                }}
            >
                {items.length ? (
                    items.map(item =>
                        item.entry ? (
                            <Entry
                                key={item.key}
                                entry={item.entry}
                                allRequests={props.allRequests}
                                details={props.details}
                                locale={locale}
                                word={word}
                            />
                        ) : (
                            <Bubble
                                key={item.key}
                                role={item.message.role}
                                ts={item.message.ts}
                                locale={locale}
                            >
                                {item.message.text}
                            </Bubble>
                        ),
                    )
                ) : (
                    <div className="empty">{word('No messages yet. Type a question below.')}</div>
                )}
                {props.thinking ? <Thinking word={word} /> : null}
            </div>
            {dialog ? (
                <div className={`level ${dialog === 'listening' ? '' : levelClass}`}>
                    <span
                        style={
                            dialog === 'listening' || dialog === 'hearing'
                                ? { width: `${Math.round(props.dialogLevel * 100)}%` }
                                : undefined
                        }
                    />
                </div>
            ) : null}
            <div className="composer">
                {props.dialogSupported ? (
                    <button
                        type="button"
                        className={`icon-btn ${dialog ? 'on' : 'primary'}`}
                        title={word(dialogTitle)}
                        aria-label={word(dialogTitle)}
                        disabled={editMode || (!dialog && (!ready || sending || !props.voiceEnabled))}
                        onClick={props.onDialog}
                    >
                        <Icon path={ICONS.dialog} />
                    </button>
                ) : null}
                {props.micSupported && !dialog ? (
                    <button
                        type="button"
                        className={`icon-btn ${listening ? 'on' : 'primary'}`}
                        title={word(listening ? 'Stop listening' : 'Speak')}
                        aria-label={word(listening ? 'Stop listening' : 'Speak')}
                        disabled={!ready || sending || editMode}
                        onClick={props.onMic}
                    >
                        <Icon path={ICONS.mic} />
                    </button>
                ) : null}
                <textarea
                    className="field"
                    rows={1}
                    value={input}
                    placeholder={word(placeholder(dialog, listening))}
                    disabled={!canType || sending}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={onKeyDown}
                />
                {props.speakSupported ? (
                    <button
                        type="button"
                        className={`icon-btn${props.speak ? ' primary' : ''}`}
                        title={word(props.speak ? 'Stop reading answers aloud' : 'Read answers aloud')}
                        aria-label={word(props.speak ? 'Stop reading answers aloud' : 'Read answers aloud')}
                        aria-pressed={props.speak}
                        disabled={editMode}
                        onClick={props.onSpeak}
                    >
                        <Icon path={props.speak ? ICONS.volumeOn : ICONS.volumeOff} />
                    </button>
                ) : null}
                <button
                    type="button"
                    className="icon-btn filled"
                    title={word('send')}
                    aria-label={word('send')}
                    disabled={!canType || sending || !input.trim()}
                    onClick={send}
                >
                    <Icon path={ICONS.send} />
                </button>
            </div>
        </div>
    );
}
