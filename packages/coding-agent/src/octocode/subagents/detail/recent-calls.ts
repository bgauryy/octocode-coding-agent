import fs from "node:fs";
import path from "node:path";
import { cutText } from "@octocodeai/octocode-common/text";
import { loadSessionFile } from "../../../core/session-manager/file-reader.ts";
import { formatAgo } from "../../shared/format.ts";

/** Tool calls the agent page lists. */
const RECENT_CALLS_SHOWN = 5;

/** One tool call from an agent's transcript. */
export interface RecentCall {
	name: string;
	/** Short `key: value` arguments, the first few that are plain values. */
	args: string;
	at: number;
}

const ARG_WIDTH = 60;

/** The transcript file of session `sessionId` in `dir`: files are named `<timestamp>_<id>.jsonl`. */
function transcriptFile(dir: string, sessionId: string): string | undefined {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const name = names.find((file) => file.endsWith(`_${sessionId}.jsonl`));
	return name ? path.join(dir, name) : undefined;
}

function shortArgs(args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	return Object.entries(args)
		.filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
		.slice(0, 2)
		.map(([key, value]) => `${key}=${cutText(String(value).replace(/\s+/g, " "), ARG_WIDTH, { chars: true })}`)
		.join(" ");
}

/** The last `limit` tool calls in the transcript of `sessionId` under `dir`, newest first; none when it has no file. */
export function recentCalls(dir: string, sessionId: string, limit = RECENT_CALLS_SHOWN): RecentCall[] {
	const file = transcriptFile(dir, sessionId);
	if (!file) return [];
	const calls: RecentCall[] = [];
	for (const entry of loadSessionFile(file).entries) {
		if (entry.type !== "message") continue;
		const message = (entry as { message?: { role?: string; content?: unknown; timestamp?: number } }).message;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const stamp = Date.parse((entry as { timestamp?: string }).timestamp ?? "");
		for (const part of message.content as Array<Record<string, unknown>>) {
			if (part.type === "toolCall" && typeof part.name === "string")
				calls.push({ name: part.name, args: shortArgs(part.arguments), at: Number.isNaN(stamp) ? 0 : stamp });
		}
	}
	return calls.slice(-limit).reverse();
}

/** `bash command=ls (3m ago)` per call, newest first. */
export function recentCallLines(calls: readonly RecentCall[], now: number): string[] {
	return calls.map(
		(call) => `${[call.name, call.args].filter(Boolean).join(" ")}${call.at ? ` (${formatAgo(now - call.at)})` : ""}`,
	);
}
