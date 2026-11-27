import fs from "node:fs";
import type { SessionEntry } from "../../../src/core/session-manager/types.ts";
import { userText } from "../../../src/octocode/compaction/summary-text.ts";

/**
 * Whether the user's own words survive each compaction of a replayed session. After compaction `k`, every user message
 * written before it must be reachable from what the model holds: inline in the checkpoint or the kept messages, through a
 * saved reference the checkpoint names (followed transitively), or, when the checkpoint says it left messages out, in the
 * transcript it points to.
 */

export interface Recovery {
	compaction: number;
	/** User messages before this compaction. */
	before: number;
	inline: number;
	referenced: number;
	/** Not in the checkpoint's reach, but counted by its "Earlier user messages not kept here" note and in the transcript. */
	transcript: number;
	/** Missing (the first characters of each). */
	lost: string[];
}

/** User text as the checkpoint section stores it: its own section tags and heading made inert. */
const inert = (text: string) =>
	text.replace(/<(\/?)user-message>/g, "<\\$1user-message>").replace(/^## User Messages/gm, "\\## User Messages");

const SAVED = /saved at (\S+?);/g;
const OMITTED = /Earlier user messages not kept here: (\d+)/;

/** `text` with every file it names as saved, and every file those name, appended. */
function reach(text: string, seen: Set<string>): string {
	let out = text;
	for (const [, file] of text.matchAll(SAVED)) {
		if (seen.has(file)) continue;
		seen.add(file);
		try {
			out += `\n${reach(fs.readFileSync(file, "utf8"), seen)}`;
		} catch {
			// A reference to a file that is gone reaches nothing; the message is then reported lost.
		}
	}
	return out;
}

const messageText = (entry: SessionEntry): string | undefined => {
	if (entry.type === "custom_message")
		return typeof entry.content === "string" ? entry.content : textParts(entry.content);
	if (entry.type !== "message") return undefined;
	const content = (entry.message as { content?: unknown }).content;
	return typeof content === "string" ? content : Array.isArray(content) ? textParts(content) : undefined;
};

const textParts = (content: readonly unknown[]): string =>
	content
		.map((part) => {
			const record = part as { type?: string; text?: string; arguments?: unknown };
			if (record.type === "text") return record.text ?? "";
			return record.type === "toolCall" ? JSON.stringify(record.arguments) : "";
		})
		.join("\n");

/** Checks every compaction on `branch` (root first) against the user messages before it; `transcript` is the file's text. */
export function recoverability(branch: readonly SessionEntry[], transcript: string): Recovery[] {
	const users: string[] = [];
	const report: Recovery[] = [];
	const index = new Map(branch.map((entry, position) => [entry.id, position]));
	for (const [position, entry] of branch.entries()) {
		if (entry.type === "message" && entry.message.role === "user") {
			// The user's words as a checkpoint keeps them: an expanded skill becomes a pointer to its file.
			const text = userText(entry.message);
			if (text) users.push(text);
			continue;
		}
		if (entry.type !== "compaction") continue;
		const kept = branch.slice(index.get(entry.firstKeptEntryId) ?? position, position);
		const held = `${entry.summary}\n${kept.map((one) => messageText(one) ?? "").join("\n")}`;
		const reachable = reach(held, new Set());
		const omitted = Number(OMITTED.exec(entry.summary)?.[1] ?? 0);
		const row: Recovery = {
			compaction: report.length + 1,
			before: users.length,
			inline: 0,
			referenced: 0,
			transcript: 0,
			lost: [],
		};
		for (const text of users) {
			if (held.includes(text) || held.includes(inert(text))) row.inline += 1;
			else if (reachable.includes(text) || reachable.includes(inert(text))) row.referenced += 1;
			else if (row.transcript < omitted && transcript.includes(JSON.stringify(text).slice(1, -1))) row.transcript += 1;
			else row.lost.push(text.slice(0, 80));
		}
		report.push(row);
	}
	return report;
}
