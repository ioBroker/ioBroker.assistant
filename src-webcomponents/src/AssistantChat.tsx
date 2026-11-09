/**
 * Talk to the assistant from a dashboard as a web component: `<iob-assistant-chat>` - the chat of the instance
 * settings (`src-admin/src/ChatComponent.tsx`) without what only belongs there (the filter by source, the request
 * details, clearing the journal, the device cache).
 *
 * One module for every host - vis-2, devices, Aura, admin (`@iobroker/web-components`). Its manifest is a file of
 * its own (`assistant-chat.json`, written by the build from `manifest.ts`), so a host loads this module only when it
 * shows the element. The host sets `socket` and `settings`, and if it has them `theme`, `editMode` and `dialogs`.
 *
 * The conversation comes from the journal of the adapter: `getJournal` once, then every request as it starts and
 * as it is answered through the state `journal.last`. A question goes to the existing `ask` command; with the
 * journal switched off (journal hours 0) the element keeps the conversation itself. The microphone button uses the
 * speech recognition of the browser, the dialog mode sends what is said as audio and needs voice to be on in the
 * instance settings (`system.adapter.assistant.<n>`, read for that). Answers are read aloud with the voice of the
 * satellites (`tts`) if there is one, else with the voice of the browser.
 *
 * React is not in the module: it comes from `lib/esm/react-19.js` beside `adapter/`, see `vite.config.ts`.
 */
import { createRoot, type Root } from 'react-dom/client';

import type { WebComponentSocket } from '@iobroker/web-components';
import { defineWebComponent, IobWebComponent } from '@iobroker/web-components/element';

import type { JournalEntry } from '../../src-admin/src/journal';
import { DIALOG_RATE, pcmToBase64, VoiceDialog } from '../../src-admin/src/voiceDialog';

import { ChatView, type ChatItem, type DialogStatus, type LocalMessage } from './ChatView';
import { CHAT_SOURCE, CHAT_TAG, getInstance, type ChatSettings } from './constants';
import { getChatWords, type ChatWords } from './chatWords';
import { toLocale } from './i18n';
import { Hint, ICONS } from './icons';
import { cancelSpeech, getSpeechRecognition, hasSpeechSynthesis, type SpeechRecognitionLike } from './speech';
import { CHAT_STYLES } from './styles';

/** How many lines the chat shows at most: the journal keeps up to a week */
const MAX_ITEMS = 200;

/** The answer of `ask` */
interface AskResult {
    answer?: string;
    error?: string;
    /** What speech recognition made of a recording ('' = nothing) */
    heard?: string;
    /** The exchange is in the journal: it arrives through `journal.last` */
    journaled?: boolean;
}

/** The answer of `getJournal`; an adapter without a journal has no `enabled` */
interface JournalResult {
    enabled?: boolean;
    entries?: JournalEntry[];
}

/** What the chat needs of the instance settings */
interface VoiceConfig {
    voiceEnabled?: boolean;
    voiceLanguage?: string;
}

class AssistantChatElement extends IobWebComponent<ChatSettings> {
    readonly #root: Root;

    /** The instance the conversation below belongs to */
    #instance = '';

    /** The requests of the journal by ID */
    readonly #entries = new Map<string, JournalEntry>();

    /** Local messages: errors without a journal entry, everything while the journal is off */
    #messages: ChatItem[] = [];

    #messageCount = 0;

    /** null: not asked yet; false: the journal is off, or the adapter has none */
    #journal: boolean | null = null;

    /** The value of `journal.last` taken over last */
    #journalState: ioBroker.State | null = null;

    /** The socket the journal was loaded through while the instance runs; null: load it (again) */
    #loadedSocket: WebComponentSocket | null = null;

    /** The adapter can synthesize speech (`tts`) */
    #ttsAvailable = false;

    /** An `ask` is under way */
    #sending = false;

    /** The toggle of the composer; null: as the setting says */
    #speak: boolean | null = null;

    #recognition: SpeechRecognitionLike | null = null;

    #voiceDialog: VoiceDialog | null = null;

    #dialog: DialogStatus = '';

    #dialogLevel = 0;

    #levelAt = 0;

    /** Ends the answer being read aloud */
    #stopSpeaking: (() => void) | null = null;

    constructor() {
        super();
        const shadow = this.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = CHAT_STYLES;
        const mount = document.createElement('div');
        mount.className = 'mount';
        shadow.append(style, mount);
        this.#root = createRoot(mount);
    }

    override disconnectedCallback(): void {
        super.disconnectedCallback();
        this.#stopVoice();
        // what was answered meanwhile: load the journal again when it is back on the page
        this.#loadedSocket = null;
    }

    /** Whether the instance runs, and every request of the journal as it starts and as it is answered */
    protected override getStateIds(settings: ChatSettings): string[] {
        const instance = getInstance(settings.instance);
        return instance ? [`system.adapter.${instance}.alive`, `${instance}.journal.last`] : [];
    }

    /** The instance settings: whether voice is on (dialog mode) and its language */
    protected override getObjectIds(settings: ChatSettings): string[] {
        const instance = getInstance(settings.instance);
        return instance ? [`system.adapter.${instance}`] : [];
    }

    get #alive(): boolean {
        return !!this.#instance && !!this.states[`system.adapter.${this.#instance}.alive`]?.val;
    }

    get #config(): VoiceConfig {
        const obj = this.objects[`system.adapter.${this.#instance}`];
        return (obj?.native || {}) as VoiceConfig;
    }

    /** The language of the speech of the browser: that of the satellites, else that of the system */
    get #locale(): string {
        return toLocale(this.#config.voiceLanguage || this.systemLang);
    }

    get #speakOn(): boolean {
        return this.#speak ?? !!this.settings.speak;
    }

    get #word(): ChatWords {
        return getChatWords(this.systemLang);
    }

    protected override render(): void {
        const instance = getInstance(this.settings.instance);
        if (instance !== this.#instance) {
            this.#reset(instance);
        }
        if (!instance) {
            this.#root.render(
                <Hint
                    text={this.#word('chooseInstance')}
                    icon={ICONS.chat}
                    editMode={this.editMode}
                />,
            );
            return;
        }
        this.#takeJournalState();
        const socket = this.socket;
        if (!this.#alive || this.editMode) {
            this.#stopVoice();
        }
        if (!this.#alive) {
            // load it again when the instance runs again: its retention may have changed with the restart
            this.#loadedSocket = null;
        } else if (socket && this.#loadedSocket !== socket) {
            this.#loadedSocket = socket;
            void this.#load(instance, socket);
        }
        this.#draw();
    }

    #reset(instance: string): void {
        this.#stopVoice();
        this.#instance = instance;
        this.#entries.clear();
        this.#messages = [];
        this.#journal = null;
        this.#journalState = null;
        this.#loadedSocket = null;
        this.#ttsAvailable = false;
        this.#sending = false;
        this.#speak = null;
    }

    /** Take over the request `journal.last` names, as it starts or as it is answered */
    #takeJournalState(): void {
        const state = this.states[`${this.#instance}.journal.last`];
        if (!state || state === this.#journalState) {
            return;
        }
        this.#journalState = state;
        if (this.#journal === false || typeof state.val !== 'string' || !state.val) {
            return;
        }
        try {
            const entry = JSON.parse(state.val) as JournalEntry;
            if (entry?.id) {
                this.#entries.set(entry.id, entry);
            }
        } catch {
            // not a journal entry
        }
    }

    /** The journal of the last hours, and whether the adapter can speak */
    async #load(instance: string, socket: WebComponentSocket): Promise<void> {
        const [journal, tts] = await Promise.all([
            socket.sendTo<JournalResult | undefined>(instance, 'getJournal', {}).catch(() => undefined),
            socket.sendTo<{ available?: boolean } | undefined>(instance, 'ttsAvailable', {}).catch(() => undefined),
        ]);
        if (instance !== this.#instance || socket !== this.socket) {
            return;
        }
        this.#ttsAvailable = !!tts?.available;
        this.#journal = journal?.enabled === undefined ? false : journal.enabled;
        if (this.#journal) {
            for (const entry of journal?.entries || []) {
                // what arrived through `journal.last` meanwhile is newer
                if (entry?.id && !this.#entries.has(entry.id)) {
                    this.#entries.set(entry.id, entry);
                }
            }
        } else {
            this.#entries.clear();
        }
        this.#draw();
    }

    #addMessage(role: LocalMessage['role'], text: string, ts = Date.now()): void {
        this.#messages.push({ key: `m${++this.#messageCount}`, ts, message: { role, text, ts } });
    }

    /** The requests and the local messages by time: those of this chat, or all of them */
    #getItems(): ChatItem[] {
        const all = !!this.settings.allRequests;
        const items: ChatItem[] = [...this.#messages];
        for (const entry of this.#entries.values()) {
            if (all || entry.source === CHAT_SOURCE) {
                items.push({ key: entry.id, ts: entry.ts, entry });
            }
        }
        items.sort((a, b) => a.ts - b.ts);
        return items.slice(-MAX_ITEMS);
    }

    #draw(): void {
        if (!this.#instance) {
            return;
        }
        const config = this.#config;
        this.#root.render(
            <ChatView
                items={this.#getItems()}
                allRequests={!!this.settings.allRequests}
                details={!!this.settings.details}
                ready={this.#alive}
                thinking={this.#sending && !this.#journal && !this.#dialog}
                sending={this.#sending}
                micSupported={!!getSpeechRecognition()}
                listening={!!this.#recognition}
                dialogSupported={VoiceDialog.supported}
                voiceEnabled={!!config.voiceEnabled}
                dialog={this.#dialog}
                dialogLevel={this.#dialogLevel}
                speakSupported={hasSpeechSynthesis() || this.#ttsAvailable}
                speak={this.#speakOn}
                editMode={this.editMode}
                locale={toLocale(this.systemLang)}
                word={this.#word}
                onSend={text => void this.#send(text)}
                onMic={() => this.#toggleMic()}
                onDialog={() => void this.#toggleDialog()}
                onSpeak={() => this.#toggleSpeak()}
            />,
        );
    }

    /** Ask the assistant - the same command as the chat of the instance settings, so the same conversation */
    async #send(text: string): Promise<void> {
        const instance = this.#instance;
        const socket = this.socket;
        if (!instance || !socket || this.editMode || this.#sending || !this.#alive) {
            return;
        }
        const journal = !!this.#journal;
        const askedAt = Date.now();
        this.#sending = true;
        if (!journal) {
            this.#addMessage('user', text, askedAt);
        }
        this.#draw();
        try {
            const res = await socket.sendTo<AskResult | undefined>(instance, 'ask', { text });
            if (instance !== this.#instance) {
                return;
            }
            if (journal && !res?.journaled) {
                // refused before it reached the journal (e.g. the assistant is not ready yet): show the question
                this.#addMessage('user', text, askedAt);
            }
            if (!res) {
                this.#addMessage('error', this.#word('noAnswer'));
            } else if (res.error !== undefined) {
                if (!res.journaled) {
                    this.#addMessage('error', res.error);
                }
            } else if (!res.journaled) {
                this.#addMessage('assistant', res.answer ?? '');
            }
            if (res?.answer && this.#speakOn) {
                void this.#speakAndWait(res.answer);
            }
        } catch (e) {
            if (instance === this.#instance) {
                this.#addMessage('error', String((e as Error)?.message || e));
            }
        } finally {
            if (instance === this.#instance) {
                this.#sending = false;
                this.#draw();
            }
        }
    }

    #toggleSpeak(): void {
        if (this.editMode) {
            return;
        }
        const speak = !this.#speakOn;
        if (!speak) {
            this.#stopSpeaking?.();
        }
        this.#speak = speak;
        this.#draw();
    }

    /** Start or stop the speech recognition of the browser; what it heard is asked at once */
    #toggleMic(): void {
        if (this.#recognition) {
            this.#recognition.stop();
            return;
        }
        const Recognition = getSpeechRecognition();
        if (!Recognition || this.editMode || !this.#alive) {
            return;
        }
        const recognition = new Recognition();
        recognition.lang = this.#locale;
        recognition.interimResults = false;
        recognition.continuous = false;
        recognition.onresult = (e): void => {
            const transcript = e.results?.[0]?.[0]?.transcript || '';
            if (transcript) {
                void this.#send(transcript);
            }
        };
        const ended = (): void => {
            if (this.#recognition === recognition) {
                this.#recognition = null;
                this.#draw();
            }
        };
        recognition.onerror = ended;
        recognition.onend = ended;
        this.#recognition = recognition;
        this.#draw();
        try {
            recognition.start();
        } catch {
            ended();
        }
    }

    /** Start or end the dialog mode: the microphone stays open and everything said becomes a question */
    async #toggleDialog(): Promise<void> {
        if (this.#voiceDialog) {
            this.#stopDialog();
            this.#draw();
            return;
        }
        if (this.editMode || !this.#alive || !this.#config.voiceEnabled) {
            return;
        }
        this.#recognition?.stop();
        this.#stopSpeaking?.();
        const dialog = new VoiceDialog({
            onUtterance: pcm => this.#dialogTurn(pcm),
            onLevel: (level, hearing) => this.#onDialogLevel(level, hearing),
        });
        this.#voiceDialog = dialog;
        this.#dialog = 'listening';
        this.#dialogLevel = 0;
        this.#draw();
        try {
            await dialog.start();
        } catch (e) {
            if (this.#voiceDialog === dialog) {
                this.#stopDialog();
            }
            this.#addMessage('error', `${this.#word('The microphone could not be opened:')} ${(e as Error).message}`);
            this.#draw();
        }
    }

    #stopDialog(): void {
        this.#voiceDialog?.stop();
        this.#voiceDialog = null;
        this.#stopSpeaking?.();
        this.#dialog = '';
        this.#dialogLevel = 0;
    }

    /** Ends everything that listens or speaks: the element left the page, the instance stopped, edit mode */
    #stopVoice(): void {
        if (this.#recognition) {
            const recognition = this.#recognition;
            this.#recognition = null;
            try {
                recognition.stop();
            } catch {
                // already stopped
            }
        }
        if (this.#voiceDialog) {
            this.#stopDialog();
        }
        // only what this element reads aloud: the speech of the browser is one for the whole page
        this.#stopSpeaking?.();
    }

    #onDialogLevel(level: number, hearing: boolean): void {
        if (this.#dialog !== 'listening' && this.#dialog !== 'hearing') {
            return;
        }
        const now = Date.now();
        // ten updates a second are plenty for the meter
        if (now - this.#levelAt < 100 && hearing === (this.#dialog === 'hearing')) {
            return;
        }
        this.#levelAt = now;
        this.#dialogLevel = level;
        this.#dialog = hearing ? 'hearing' : 'listening';
        this.#draw();
    }

    /**
     * One turn of the dialog: the utterance goes to the assistant as PCM (recognised there by the speech engine of
     * the instance, answered like a typed question of this chat), the answer is read aloud, then it listens again
     */
    async #dialogTurn(pcm: Int16Array): Promise<void> {
        const dialog = this.#voiceDialog;
        const instance = this.#instance;
        const socket = this.socket;
        if (!dialog || !socket || !this.#alive) {
            return;
        }
        const journal = !!this.#journal;
        this.#dialog = 'thinking';
        this.#dialogLevel = 0;
        this.#sending = true;
        this.#draw();
        try {
            const res = await socket.sendTo<AskResult | undefined>(instance, 'ask', {
                audio: pcmToBase64(pcm),
                format: 'pcm',
                sampleRate: DIALOG_RATE,
                spoken: true,
            });
            if (this.#voiceDialog !== dialog) {
                return; // ended meanwhile
            }
            if (!res) {
                this.#addMessage('error', this.#word('noAnswer'));
                return;
            }
            if (res.heard === '') {
                return; // a noise, nothing recognised: listen on
            }
            if (!journal || !res.journaled) {
                if (res.heard) {
                    this.#addMessage('user', res.heard);
                }
                if (res.error !== undefined) {
                    this.#addMessage('error', res.error);
                } else {
                    this.#addMessage('assistant', res.answer ?? '');
                }
            }
            if (res.answer) {
                this.#dialog = 'speaking';
                this.#draw();
                await this.#speakAndWait(res.answer);
            }
        } catch (e) {
            if (instance === this.#instance) {
                this.#addMessage('error', String((e as Error)?.message || e));
            }
        } finally {
            if (instance === this.#instance) {
                this.#sending = false;
                if (this.#voiceDialog === dialog) {
                    this.#dialog = 'listening';
                    this.#dialogLevel = 0;
                }
                this.#draw();
            }
        }
    }

    /**
     * Read an answer aloud with the voice of the satellites (the browser's if there is none) and resolve when it
     * was spoken - or stopped
     */
    #speakAndWait(text: string): Promise<void> {
        this.#stopSpeaking?.();
        const instance = this.#instance;
        const socket = this.socket;
        const locale = this.#locale;
        return new Promise(resolve => {
            let done = false;
            let audio: HTMLAudioElement | null = null;
            let guard: ReturnType<typeof setTimeout> | undefined = undefined;
            let stop: (() => void) | null = null;
            const finish = (): void => {
                if (!done) {
                    done = true;
                    clearTimeout(guard);
                    if (this.#stopSpeaking === stop) {
                        this.#stopSpeaking = null;
                    }
                    resolve();
                }
            };
            stop = (): void => {
                audio?.pause();
                cancelSpeech();
                finish();
            };
            this.#stopSpeaking = stop;
            // a voice of the browser sometimes never reports its end
            guard = setTimeout(finish, 15_000 + text.length * 120);
            const browserVoice = (): void => {
                if (done || !hasSpeechSynthesis()) {
                    finish();
                    return;
                }
                const utterance = new SpeechSynthesisUtterance(text);
                utterance.lang = locale;
                utterance.onend = finish;
                utterance.onerror = finish;
                window.speechSynthesis.cancel();
                window.speechSynthesis.speak(utterance);
            };
            if (!this.#ttsAvailable || !socket) {
                browserVoice();
                return;
            }
            void (async () => {
                try {
                    const res = await socket.sendTo<{ audio?: string; mime?: string } | undefined>(instance, 'tts', {
                        text,
                    });
                    if (done) {
                        return;
                    }
                    if (res?.audio) {
                        audio = new Audio(`data:${res.mime || 'audio/wav'};base64,${res.audio}`);
                        audio.onended = finish;
                        audio.onerror = finish;
                        await audio.play();
                        return;
                    }
                } catch {
                    // the voice of the browser then (e.g. autoplay was refused)
                }
                browserVoice();
            })();
        });
    }
}

defineWebComponent(CHAT_TAG, AssistantChatElement);
