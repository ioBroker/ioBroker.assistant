/**
 * Messages that reach `onMessage` but are no request.
 *
 * js-controller hands a reply (`callback.ack`) to the callback that waits for it; when that callback is gone, the reply
 * arrives as a message of its own. That happens when the adapter restarted while another adapter was still answering
 * it: a pi-agent answer that comes after an update of the assistant. Answering such a reply sends it back with the same
 * `callback`, and a caller that does the same keeps both adapters in a loop (field report 2026-11-13: about 25 empty
 * `ask` a second between assistant.0 and pi-agent.0 after an update of the assistant).
 */

/** Whether the message is a late reply to a request of ours rather than a request. */
export function isLateReply(obj: { callback?: { ack?: boolean } | null } | null | undefined): boolean {
    return !!obj?.callback?.ack;
}
