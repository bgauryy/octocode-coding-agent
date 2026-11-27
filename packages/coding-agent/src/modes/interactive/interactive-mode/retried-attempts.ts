/**
 * Failed attempts the session sent again. A retry, a fallback model or a recovery that strips images sets the failed
 * response aside (`omitRecoveryAttempt`: a context edit that removes it from model context) and asks again, so its
 * error is not the turn's outcome. The transcript keeps the attempt and marks it retried, live from the retry's start
 * and from the session file after a rebuild, resume or reload.
 */

import { RETRY_CANCELLED_ENTRY } from "../../../core/agent-session/types.ts";
import type { Container } from "@octocodeai/octocode-tui";
import type { SessionEntry } from "../../../core/session-manager.ts";
import { AssistantMessageComponent } from "../components/assistant-message.ts";

/** The ids of the failed assistant entries among `entries` that a context edit removed from model context. */
export function retriedAttemptIds(entries: readonly SessionEntry[]): Set<string> {
	const failed = new Set<string>();
	const retried = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error")
			failed.add(entry.id);
		else if (entry.type === "context_edit" && entry.replacement === null && failed.has(entry.targetId))
			retried.add(entry.targetId);
		else if (entry.type === "custom" && entry.customType === RETRY_CANCELLED_ENTRY && typeof entry.data === "string")
			retried.delete(entry.data);
	}
	return retried;
}

/** A retry starts: the newest assistant row is the attempt that just failed, and it reads as retried from now on. */
export function markRetriedAttempt(chat: Container, retried = true): void {
	const rows = chat.children;
	for (let index = rows.length - 1; index >= 0; index--) {
		const row = rows[index];
		if (!(row instanceof AssistantMessageComponent)) continue;
		row.markRetried(retried);
		return;
	}
}
