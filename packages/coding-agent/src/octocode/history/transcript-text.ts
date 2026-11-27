import { isRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * What one transcript entry says, as text a search tests and an evidence read shows: a message's text, the tool calls
 * an assistant emitted (name, id and arguments) and a tool result's tool name, call id and text. Thinking is left out.
 * The text is not redacted here (the session codec removed credentials when it wrote the line, and a search tests
 * every entry); whatever is shown goes through `redactSecrets` first.
 */

export interface TranscriptText {
	/** `user`, `assistant`, `toolResult`, `custom` or `compaction`. */
	role: string;
	time?: string;
	/** A tool result's tool, or the tools an assistant message called. */
	tool?: string;
	text: string;
}

function parts(content: unknown): { text: string[]; tools: string[] } {
	const text: string[] = [];
	const tools: string[] = [];
	if (typeof content === "string") return { text: [content], tools };
	if (!Array.isArray(content)) return { text, tools };
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") text.push(part.text);
		else if (part.type === "toolCall" && typeof part.name === "string") {
			tools.push(part.name);
			text.push(`[call ${part.name} ${String(part.id)}] ${JSON.stringify(part.arguments ?? {})}`);
		}
	}
	return { text, tools };
}

/** The text of a parsed transcript entry; undefined for entries that carry none (model changes, labels). */
export function transcriptText(entry: unknown): TranscriptText | undefined {
	if (!isRecord(entry)) return undefined;
	const time = typeof entry.timestamp === "string" ? { time: entry.timestamp } : {};
	if (entry.type === "compaction" && typeof entry.summary === "string")
		return { role: "compaction", ...time, text: entry.summary };
	const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
	if (entry.type === "custom_message") {
		return { role: "custom", ...time, text: parts(entry.content).text.join("\n\n") };
	}
	if (!message) return undefined;
	const { text, tools } = parts(message.content);
	const role = typeof message.role === "string" ? message.role : "unknown";
	if (role === "toolResult") {
		const tool = typeof message.toolName === "string" ? message.toolName : "unknown tool";
		const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
		return { role, ...time, tool, text: `${tool} ${id}\n${text.join("\n\n")}` };
	}
	return { role, ...time, ...(tools.length ? { tool: tools.join(",") } : {}), text: text.join("\n\n") };
}

/** Characters of a call's arguments an error sample shows. */
const EMITTED_ARGS_CHARS = 300;

/** `name {arguments}` of the call `callId` in an assistant entry, the arguments clipped; undefined when it holds no such call. */
export function emittedCall(entry: unknown, callId: string): string | undefined {
	const message = isRecord(entry) && isRecord(entry.message) ? entry.message : undefined;
	if (!message || !Array.isArray(message.content)) return undefined;
	const call = message.content.find((part) => isRecord(part) && part.type === "toolCall" && part.id === callId);
	if (!isRecord(call)) return undefined;
	const args = JSON.stringify(call.arguments ?? {});
	return `${String(call.name)} ${args.length > EMITTED_ARGS_CHARS ? `${args.slice(0, EMITTED_ARGS_CHARS)}…` : args}`;
}
