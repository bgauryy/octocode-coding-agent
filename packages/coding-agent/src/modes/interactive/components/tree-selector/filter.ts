import { getSearchableText, hasTextContent } from "./entry-text.ts";
import type { FilterMode, FlatNode } from "./types.ts";

/** Whether a flattened node passes the hidden-entry rules, the filter mode and the search tokens. */
export function matchesTreeFilter(
	flatNode: FlatNode,
	currentLeafId: string | null,
	filterMode: FilterMode,
	searchTokens: string[],
): boolean {
	const entry = flatNode.node.entry;
	if (entry.type === "usage") return false;
	const isCurrentLeaf = entry.id === currentLeafId;

	// Skip assistant messages with only tool calls (no text) unless error/aborted
	// Always show current leaf so active position is visible
	if (entry.type === "message" && entry.message.role === "assistant" && !isCurrentLeaf) {
		const msg = entry.message as { stopReason?: string; content?: unknown };
		const hasText = hasTextContent(msg.content);
		const isErrorOrAborted = msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse";
		// Only hide if no text AND not an error/aborted message
		if (!hasText && !isErrorOrAborted) {
			return false;
		}
	}

	// Apply filter mode
	let passesFilter = true;
	// Entry types hidden in default view (settings/bookkeeping)
	const isSettingsEntry =
		entry.type === "label" ||
		entry.type === "context_edit" ||
		entry.type === "custom" ||
		entry.type === "model_change" ||
		entry.type === "thinking_level_change" ||
		entry.type === "session_info";

	switch (filterMode) {
		case "user-only":
			// Just user messages
			passesFilter = entry.type === "message" && entry.message.role === "user";
			break;
		case "no-tools":
			// Default minus tool results
			passesFilter = !isSettingsEntry && !(entry.type === "message" && entry.message.role === "toolResult");
			break;
		case "labeled-only":
			// Just labeled entries
			passesFilter = flatNode.node.label !== undefined;
			break;
		case "all":
			// Show everything
			passesFilter = true;
			break;
		default:
			// Default mode: hide settings/bookkeeping entries
			passesFilter = !isSettingsEntry;
			break;
	}

	if (!passesFilter) return false;

	// Apply search filter
	if (searchTokens.length > 0) {
		const nodeText = getSearchableText(flatNode.node).toLowerCase();
		return searchTokens.every((token) => nodeText.includes(token));
	}

	return true;
}
