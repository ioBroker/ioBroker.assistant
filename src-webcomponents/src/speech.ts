/**
 * The speech of the browser, as the chat of the instance settings uses it (`src-admin/src/ChatComponent.tsx`):
 * speech recognition (Web Speech API) for the microphone button, speech synthesis to read answers aloud.
 */

/** The part of the browser's `SpeechRecognition` the chat uses (the DOM types have none) */
export interface SpeechRecognitionLike {
    lang: string;
    interimResults: boolean;
    continuous: boolean;
    onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
    onerror: ((e: unknown) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

/** The speech recognition of the browser (Chrome, Edge, Safari) - only in a secure context (https, localhost) */
export function getSpeechRecognition(): SpeechRecognitionConstructor | null {
    if (typeof window === 'undefined' || !window.isSecureContext) {
        return null;
    }
    const w = window as unknown as {
        SpeechRecognition?: SpeechRecognitionConstructor;
        webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/** Text to speech of the browser - works over plain http too */
export function hasSpeechSynthesis(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window && !!window.speechSynthesis;
}

/** Stops what the browser reads aloud */
export function cancelSpeech(): void {
    if (hasSpeechSynthesis()) {
        window.speechSynthesis.cancel();
    }
}
