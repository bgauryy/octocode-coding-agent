import type { SessionEntry } from "../../../core/session-manager.ts";
import { fence, inlineCode, MESSAGE_LINES, oneLine, templateLine } from "../../history/archive/text.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { contentText, stringOrEmpty } from "../../shared/util.ts";

/** The first line of the first user message, the label of last resort. */
export function firstUserLine(messages: readonly unknown[]): string | undefined {
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "user") continue;
		const line = contentText(message.content)
			.split("\n")
			.map((text) => text.trim())
			.find(Boolean);
		if (line) return line;
	}
	return undefined;
}

/** A message's content parts as Markdown blocks: text verbatim, tool calls with their JSON arguments, images as a placeholder, no thinking. */
function contentBlocks(content: unknown): string[] {
	if (typeof content === "string") return content === "" ? [] : [fence(content)];
	if (!Array.isArray(content)) return [];
	return content.flatMap((part): string[] => {
		if (!isRecord(part)) return [fence(JSON.stringify(part) ?? String(part), "json")];
		switch (part.type) {
			case "text":
				return typeof part.text === "string" && part.text !== "" ? [fence(part.text)] : [];
			case "image":
				return [templateLine(MESSAGE_LINES.image)];
			case "thinking":
				return [];
			case "toolCall":
				return [
					templateLine(MESSAGE_LINES.toolCall, inlineCode(String(part.name)), inlineCode(String(part.id))),
					fence(JSON.stringify(part.arguments ?? {}, null, 2), "json"),
				];
			default:
				return [fence(JSON.stringify(part), "json")];
		}
	});
}

/** The body of one message under its heading, by role. */
function messageBlocks(message: Record<string, unknown>): string[] {
	switch (message.role) {
		case "user":
		case "assistant":
		case "custom":
			return [
				...contentBlocks(message.content),
				...(typeof message.errorMessage === "string"
					? [templateLine(MESSAGE_LINES.error), fence(message.errorMessage)]
					: []),
			];
		case "toolResult":
			return [
				templateLine(
					message.isError === true ? MESSAGE_LINES.toolResultError : MESSAGE_LINES.toolResult,
					inlineCode(stringOrEmpty(message.toolName)),
					inlineCode(stringOrEmpty(message.toolCallId)),
				),
				...contentBlocks(message.content),
			];
		case "bashExecution": {
			const exit = message.cancelled === true ? "cancelled" : `exit ${oneLine(String(message.exitCode))}`;
			return [
				templateLine(MESSAGE_LINES.command, exit),
				fence(stringOrEmpty(message.command), "sh"),
				...(stringOrEmpty(message.output) ? [fence(stringOrEmpty(message.output))] : []),
			];
		}
		case "branchSummary":
		case "compactionSummary":
			return [fence(stringOrEmpty(message.summary))];
		default:
			return [fence(JSON.stringify(message, null, 2), "json")];
	}
}

export const isoTime = (timestamp: unknown): string | undefined =>
	typeof timestamp === "number" && Number.isFinite(timestamp)
		? new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, "Z")
		: undefined;

/** Legacy lookup, for a preparation that carries no entry ids: the session entry a summarized message came from. Messages are the entries' own objects unless a context edit copied them, so a copy is found by role, time and call. */
export function entryIndex(entries: readonly SessionEntry[]): (message: unknown) => string | undefined {
	const key = (message: Record<string, unknown>): string =>
		`${stringOrEmpty(message.role)}|${String(message.timestamp)}|${stringOrEmpty(message.toolCallId)}${stringOrEmpty(message.customType)}`;
	const byObject = new Map<unknown, string>();
	const byKey = new Map<string, string>();
	for (const entry of entries) {
		const message: unknown =
			entry.type === "message"
				? entry.message
				: entry.type === "custom_message"
					? { role: "custom", customType: entry.customType, timestamp: Date.parse(entry.timestamp) }
					: undefined;
		if (!isRecord(message)) continue;
		byObject.set(message, entry.id);
		byKey.set(key(message), entry.id);
	}
	return (message) => byObject.get(message) ?? (isRecord(message) ? byKey.get(key(message)) : undefined);
}

/** The messages as the segment file shows them: one `### role · time · entry id` section each, in order. */
export function renderMessages(
	messages: readonly unknown[],
	entryOf: ((message: unknown) => string | undefined) | ReadonlyArray<string | undefined>,
): string {
	return messages
		.map((message, index) => {
			const record = isRecord(message) ? message : { role: "unknown", value: message };
			const role =
				record.role === "custom"
					? `custom (${oneLine(stringOrEmpty(record.customType))})`
					: oneLine(stringOrEmpty(record.role)) || "unknown";
			const entry = typeof entryOf === "function" ? entryOf(message) : entryOf[index];
			const heading = [
				"###",
				role,
				...(isoTime(record.timestamp) ? [`· ${isoTime(record.timestamp)}`] : []),
				...(entry ? [`· entry ${oneLine(entry)}`] : []),
			].join(" ");
			return [heading, ...messageBlocks(record)].join("\n\n");
		})
		.join("\n\n");
}
