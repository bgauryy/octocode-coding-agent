import type { ExtensionAPI } from "../../core/features/index.ts";
import { wakeGateOf } from "./gate.ts";

/**
 * The hidden or one-off turn starters, sent through the gate so each shows in the `woke` row. Their message text, type and
 * delivery are the senders' own.
 */

const ITEM_REF = /\bB\d+\b/;
const FOLLOW_UP = { triggerTurn: true, deliverAs: "followUp" } as const;
let feedbackSeq = 0;
let peerSeq = 0;

/** A graph notice (items ready, or left waiting): the first item it names heads the row line. */
export function sendGraphNotice(api: ExtensionAPI, customType: string, content: string): void | Promise<void> {
	const ref = ITEM_REF.exec(content)?.[0] ?? "backlog";
	return wakeGateOf(api).emit(
		{ kind: "item.ready", ref, prerequisites: [] },
		{ customType, content, display: false },
		FOLLOW_UP,
	);
}

/** A background hook's feedback that restarts an idle session. */
export function sendHookFeedback(api: ExtensionAPI, customType: string, content: string): void | Promise<void> {
	return wakeGateOf(api).emit(
		{ kind: "hook.feedback", hook: "background", event: "feedback", text: content, seq: ++feedbackSeq },
		{ customType, content, display: false },
		FOLLOW_UP,
	);
}

/** The retry of a wake the provider failed (`attempt` of 5). */
export function sendWakeRetry(
	api: ExtensionAPI,
	customType: string,
	content: string,
	attempt: number,
	error: string | undefined,
): void | Promise<void> {
	return wakeGateOf(api).emit(
		{ kind: "wake.retry", attempt, error: error ?? "unknown error" },
		{ customType, content, display: false },
		FOLLOW_UP,
	);
}

/** A notice about a peer session that starts a turn. */
export function sendPeerNotice(api: ExtensionAPI, customType: string, content: string): void | Promise<void> {
	return wakeGateOf(api).emit(
		{ kind: "peer.notice", text: content, seq: ++peerSeq },
		{ customType, content, display: true },
		{ triggerTurn: true, deliverAs: "steer" },
	);
}
