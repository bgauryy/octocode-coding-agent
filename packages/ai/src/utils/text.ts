import type { AssistantContent, SystemMessage } from "../types.ts";

/** Extract and join text from message content. */
export function contentText(content: string | readonly AssistantContent[], separator = "\n"): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join(separator);
}

/** Render a system message as a complete prompt: its content followed by its sections. */
export function getSystemMessageText(message: SystemMessage): string {
	const parts = [contentText(message.content)];
	for (const text of Object.values(message.sections ?? {})) {
		if (text !== null) parts.push(text);
	}
	return parts.filter((part) => part.length > 0).join("\n\n");
}

/**
 * Render a later system message for APIs that accept system messages mid-conversation.
 * Section changes are framed by name so the model can relate them to the leading prompt.
 * This framing is request-time only and may change between versions.
 */
export function renderSystemMessageUpdate(message: SystemMessage): string {
	const parts: string[] = [];
	const text = contentText(message.content);
	if (text.length > 0) parts.push(text);
	for (const [name, value] of Object.entries(message.sections ?? {})) {
		parts.push(
			value === null
				? `Removed system prompt section "${name}".`
				: `Updated system prompt section "${name}":\n\n${value}`,
		);
	}
	return parts.join("\n\n");
}

/**
 * Render a later system message as the text of a user-role message, for APIs that reject
 * mid-conversation system messages. The leading prompt must stay byte-identical for prefix
 * caching, so an update travels as a marked user turn instead of rewriting it. Returns an
 * empty string when the message carries no prompt text (a tool-only change).
 * This framing is request-time only and may change between versions.
 */
export function renderSystemUpdateAsUserText(message: SystemMessage): string {
	const update = renderSystemMessageUpdate(message);
	if (update.length === 0) return "";
	return [
		"[System update from the harness, not written by the user. It amends the system prompt and overrides earlier instructions it contradicts. Continue the user's current request.]",
		update,
	].join("\n\n");
}
