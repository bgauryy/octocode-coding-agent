import type { ProfileTranscript, ProfileTranscriptEntry } from "@octocodeai/octocode-contracts/profiler";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import { str, type Entry, type Prepared } from "./entries.ts";

/** Entries read on each side of the asked one. */
const WINDOW = 2;
/** Characters kept of one entry's text, and of its thinking. */
const MAX_TEXT = 20_000;

const entryAt = (entry: Entry): number => {
	const at = Date.parse(String(entry.timestamp));
	return Number.isFinite(at) ? at : 0;
};

function blocks(content: unknown): Array<Record<string, unknown>> {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? content.map(asRecord) : [];
}

function joined(parts: string[]): string | undefined {
	const text = parts.join("\n\n");
	return text ? text : undefined;
}

/** One transcript entry as the Messages tab shows it: its text, an assistant's thinking and the tools it called. */
export function projectEntry(entry: Entry, position: number): ProfileTranscriptEntry {
	const message = asRecord(entry.message);
	const role =
		entry.type === "message"
			? message.role === "assistant" || message.role === "user" || message.role === "toolResult"
				? message.role
				: "other"
			: entry.type === "custom_message"
				? "notice"
				: "other";
	const content = entry.type === "custom_message" ? entry.content : message.content;
	const text: string[] = [];
	const thinking: string[] = [];
	const tools: string[] = [];
	for (const block of blocks(content)) {
		if (block.type === "text") text.push(str(block.text, ""));
		else if (block.type === "thinking") thinking.push(str(block.thinking, ""));
		else if (block.type === "toolCall") tools.push(str(block.name, "tool"));
	}
	const body = joined(text);
	const thought = joined(thinking);
	const cut = (value: string | undefined) => (value && value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value);
	const truncated = (body?.length ?? 0) > MAX_TEXT || (thought?.length ?? 0) > MAX_TEXT;
	const shownText = cut(body);
	const shownThinking = cut(thought);
	return {
		entry: position,
		role,
		at: entryAt(entry),
		...(shownText ? { text: shownText } : {}),
		...(shownThinking ? { thinking: shownThinking } : {}),
		...(tools.length ? { tools } : {}),
		...(truncated ? { truncated: true as const } : {}),
	};
}

/** The entries within `WINDOW` of `entry` in `prepared`; empty when `entry` is past the end of the transcript. */
export function readTranscript(agentId: string, prepared: Prepared, entry: number): ProfileTranscript {
	if (entry >= prepared.entries.length) return { agentId, entry, entries: [] };
	const from = Math.max(0, entry - WINDOW);
	const to = Math.min(prepared.entries.length - 1, entry + WINDOW);
	const entries: ProfileTranscriptEntry[] = [];
	for (let position = from; position <= to; position += 1)
		entries.push(projectEntry(prepared.entries[position], position));
	return { agentId, entry, entries };
}
