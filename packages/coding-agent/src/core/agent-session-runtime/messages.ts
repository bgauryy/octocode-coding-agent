import { contentText } from "@octocodeai/octocode-ai";
import { withoutSourceHeader } from "@octocodeai/octocode-common/text";
import type { SessionManager } from "../session-manager.ts";

/**
 * Where a fork of `entryId` leaves the new session: at the entry itself (`at`), or before a user message (`before`),
 * whose text then prefills the editor.
 */
export function forkTarget(
	sessionManager: Pick<SessionManager, "getEntry">,
	entryId: string,
	position: "before" | "at",
): { targetLeafId: string | null; selectedText?: string } {
	const selectedEntry = sessionManager.getEntry(entryId);
	if (!selectedEntry) throw new Error("Invalid entry ID for forking");
	if (position === "at") return { targetLeafId: selectedEntry.id };
	if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
		throw new Error("Invalid entry ID for forking");
	}
	return {
		targetLeafId: selectedEntry.parentId,
		selectedText: withoutSourceHeader(contentText(selectedEntry.message.content, "")),
	};
}
