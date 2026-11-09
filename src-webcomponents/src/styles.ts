/**
 * The styles of the shadow roots. An element fills the box of the host, has a transparent background and inherits
 * `color` and `font`; colors come from the theme of the host (`--iob-primary`, `--iob-error`, ...), so it looks right
 * in light and dark. The layout follows the box with container queries, nothing is measured.
 */

/** The box, the hint shown instead of the content while settings are missing, buttons and text fields */
const BASE = `
:host {
    display: block;
    width: 100%;
    height: 100%;
}
.mount {
    width: 100%;
    height: 100%;
    /* the size of the box does not depend on what is in it */
    container-type: size;
}
.edit {
    pointer-events: none;
}
.hint {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 8px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: clamp(2px, 3cqmin, 8px);
    overflow: hidden;
    text-align: center;
    color: var(--iob-text-secondary);
    font-size: clamp(10px, 6cqmin, 15px);
}
.hint svg {
    width: clamp(16px, 14cqmin, 36px);
    height: clamp(16px, 14cqmin, 36px);
    fill: currentColor;
    flex: none;
}
.icon-btn {
    flex: none;
    box-sizing: border-box;
    width: 36px;
    height: 36px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: inherit;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
}
.icon-btn svg {
    width: 22px;
    height: 22px;
    fill: currentColor;
}
.icon-btn:hover:not(:disabled) {
    background: color-mix(in srgb, currentColor 10%, transparent);
}
.icon-btn:focus-visible {
    outline: 2px solid var(--iob-primary);
    outline-offset: -2px;
}
.icon-btn:disabled {
    opacity: 0.38;
    cursor: default;
}
.icon-btn.primary {
    color: var(--iob-primary);
}
.icon-btn.on {
    color: var(--iob-error);
}
.icon-btn.filled {
    background: var(--iob-primary);
    color: var(--iob-primary-contrast);
}
.icon-btn.filled:hover:not(:disabled) {
    background: color-mix(in srgb, var(--iob-primary) 85%, currentColor);
}
.field {
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
    margin: 0;
    padding: 7px 12px;
    font: inherit;
    line-height: 1.4;
    color: inherit;
    background: transparent;
    border: 1px solid var(--iob-divider);
    border-radius: 18px;
    outline: none;
    resize: none;
    field-sizing: content;
    min-height: 36px;
    max-height: 7em;
}
.field:focus {
    border-color: var(--iob-primary);
}
.field:disabled {
    opacity: 0.6;
}
.field::placeholder {
    color: var(--iob-text-secondary);
}
.spinner {
    flex: none;
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
}
@keyframes spin {
    to {
        transform: rotate(360deg);
    }
}
`;

/** `<iob-assistant-chat>`: the conversation in bubbles, the composer below */
export const CHAT_STYLES = `${BASE}
.chat {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow: hidden;
}
.banner {
    flex: none;
    padding: 2px 6px;
    color: var(--iob-warning);
    font-size: 0.85em;
}
.list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 2px;
}
.empty {
    margin: auto;
    padding: 16px;
    text-align: center;
    color: var(--iob-text-secondary);
}
.row {
    display: flex;
    justify-content: flex-start;
}
.row.user {
    justify-content: flex-end;
}
.bubble {
    max-width: 82%;
    box-sizing: border-box;
    padding: 6px 10px;
    border-radius: 14px;
    border-bottom-left-radius: 4px;
    background: color-mix(in srgb, currentColor 9%, transparent);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.4;
}
.user .bubble {
    border-radius: 14px;
    border-bottom-right-radius: 4px;
    background: var(--iob-primary);
    color: var(--iob-primary-contrast);
}
.error .bubble {
    background: color-mix(in srgb, var(--iob-error) 14%, transparent);
    color: var(--iob-error);
}
.silent {
    font-style: italic;
    opacity: 0.7;
}
.time {
    margin-top: 2px;
    text-align: right;
    font-size: 0.7em;
    opacity: 0.65;
}
.chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 3px;
}
.chip {
    padding: 0 7px;
    border-radius: 999px;
    background: color-mix(in srgb, currentColor 20%, transparent);
    font-size: 0.72em;
    line-height: 1.6;
    white-space: nowrap;
}
.chip.tier {
    background: var(--tier);
    color: #fff;
}
.details {
    margin: 0 0 4px 8px;
    padding-left: 8px;
    border-left: 2px solid var(--iob-divider);
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: var(--iob-text-secondary);
    font-size: 0.78em;
}
.details .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
}
.mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    overflow-wrap: anywhere;
}
.thinking {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    color: var(--iob-text-secondary);
}
.level {
    flex: none;
    height: 3px;
    border-radius: 2px;
    overflow: hidden;
    background: color-mix(in srgb, var(--iob-primary) 22%, transparent);
}
.level span {
    display: block;
    height: 100%;
    background: var(--iob-primary);
    transition: width 0.1s linear;
}
.level.hearing span {
    background: var(--iob-error);
}
.level.busy span {
    width: 35%;
    animation: slide 1.2s ease-in-out infinite;
}
.level.speaking span {
    background: var(--iob-secondary);
}
@keyframes slide {
    from {
        transform: translateX(-100%);
    }
    to {
        transform: translateX(300%);
    }
}
.composer {
    flex: none;
    display: flex;
    align-items: flex-end;
    gap: 4px;
}
@container (max-height: 180px) {
    .time {
        display: none;
    }
}
@container (max-width: 260px) {
    .bubble {
        max-width: 92%;
    }
}
`;

/** `<iob-assistant-satellites>`: one row per satellite, the announcement on all of them below */
export const SATELLITES_STYLES = `${BASE}
.satellites {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow: hidden;
}
.list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
}
.empty {
    margin: auto;
    padding: 16px;
    text-align: center;
    color: var(--iob-text-secondary);
}
.sat {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    padding: 4px 4px 4px 8px;
    border-bottom: 1px solid var(--iob-divider);
}
.sat:last-child {
    border-bottom: none;
}
.dot {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--iob-error);
}
.dot.alive {
    background: var(--iob-success);
}
.info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
}
.name {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.sub {
    font-size: 0.8em;
    color: var(--iob-text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.status {
    --state: var(--iob-text-secondary);
    flex: none;
    padding: 1px 9px;
    border: 1px solid var(--state);
    border-radius: 999px;
    color: var(--state);
    font-size: 0.78em;
    line-height: 1.5;
    white-space: nowrap;
}
.status.listening {
    --state: var(--iob-info);
}
.status.processing {
    --state: var(--iob-warning);
}
.status.speaking {
    --state: var(--iob-success);
}
.status.offline {
    --state: var(--iob-error);
}
.seen {
    flex: none;
    width: 6.5em;
    text-align: right;
    font-size: 0.8em;
    color: var(--iob-text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.composer {
    flex: none;
    display: flex;
    align-items: center;
    gap: 4px;
}
@container (max-width: 340px) {
    .seen {
        display: none;
    }
}
@container (max-width: 240px) {
    .status {
        display: none;
    }
}
`;
