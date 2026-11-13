import type { SessionManager } from "../session-manager.ts";

/** Plain text of a user message, for prefilling the editor after a fork. */
function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

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
		selectedText: extractUserMessageText(selectedEntry.message.content),
	};
}
