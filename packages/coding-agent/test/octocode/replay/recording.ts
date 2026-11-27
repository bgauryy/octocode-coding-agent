import fs from "node:fs";
import path from "node:path";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@octocodeai/octocode-ai";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { CustomMessageEntry } from "../../../src/core/session-manager/types.ts";

/**
 * A recorded session read back as turns to replay: what started each run (a user prompt, or the custom messages that woke
 * an idle session), the assistant messages the model sent in that run, and every recorded tool result by its call id. The
 * recording is copied first and only the copy is opened, so the source file is never touched.
 */

/** Custom messages the replayed session's own features write again (recall, context notices, compaction restores). */
const NATIVE_NOTICES = new Set([
	"octocode-memory",
	"octocode-context-usage",
	"octocode-restored-files",
	"octocode-compact-resume",
	"octocode-running-work",
	"octocode-turn",
]);

export type ReplayCustomMessage = Pick<CustomMessageEntry, "customType" | "content" | "display" | "details">;

export type ReplayTrigger =
	| { kind: "user"; text: string; images: ImageContent[] }
	/** Custom messages that started a run while the session was idle (a finished job, a child's report). */
	| { kind: "custom"; messages: ReplayCustomMessage[] };

export interface ReplayTurn {
	index: number;
	trigger: ReplayTrigger;
	/** The assistant messages of the run, in order: each one answers one request. */
	replies: AssistantMessage[];
}

export interface Recording {
	/** The copy that was opened. */
	file: string;
	bytes: number;
	entries: number;
	turns: ReplayTurn[];
	/** Recorded tool results by tool call id, oldest first (an id a provider reused holds more than one). */
	results: Map<string, ToolResultMessage[]>;
	/** Recorded compaction summaries, oldest first: the answers to summary requests. */
	summaries: string[];
	/** Every tool name the recorded assistant messages call. */
	toolNames: string[];
	/** The recorded usage, summed: what the original provider reported for the original prompt. */
	recordedUsage: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** What the reader left out, and why: none of it can be replayed as a model reply or a run start. */
	skipped: {
		/** Assistant messages that ended in an error or an abort: retries and interruptions, not answers. */
		failedReplies: number;
		/** Custom messages delivered inside a run, or written by the session's own features. */
		customMessages: number;
		/** Messages of other roles (`!` commands, system prompts). */
		otherMessages: number;
		/** Assistant messages before any prompt, or after a reply that ended its run with nothing new to answer. */
		orphanReplies: number;
	};
}

const textOf = (content: string | (TextContent | ImageContent)[]): string =>
	typeof content === "string"
		? content
		: content
				.filter((part): part is TextContent => part.type === "text")
				.map((part) => part.text)
				.join("\n");

const imagesOf = (content: string | (TextContent | ImageContent)[]): ImageContent[] =>
	typeof content === "string" ? [] : content.filter((part): part is ImageContent => part.type === "image");

/** Copies `source` into `into` and returns the copy's path; the source is only read. */
export function copyRecording(source: string, into: string): string {
	fs.mkdirSync(into, { recursive: true });
	const copy = path.join(into, path.basename(source));
	fs.copyFileSync(source, copy);
	fs.chmodSync(copy, 0o600);
	return copy;
}

/** Reads the active branch of the session file `copy` (already a copy) into turns. */
export function readRecording(copy: string): Recording {
	const manager = SessionManager.open(copy, path.dirname(copy));
	const branch = manager.getBranch();
	const recording: Recording = {
		file: copy,
		bytes: fs.statSync(copy).size,
		entries: branch.length,
		turns: [],
		results: new Map(),
		summaries: [],
		toolNames: [],
		recordedUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		skipped: { failedReplies: 0, customMessages: 0, otherMessages: 0, orphanReplies: 0 },
	};
	const names = new Set<string>();
	/** Custom messages seen since the last run ended; they start the next run when a reply follows before a prompt. */
	let idleCustom: ReplayCustomMessage[] = [];
	let current: ReplayTurn | undefined;
	/** Whether the last reply asked for tools: a custom message now arrives inside the run, not as its start. */
	let inRun = false;

	const startTurn = (trigger: ReplayTrigger): ReplayTurn => {
		const turn = { index: recording.turns.length, trigger, replies: [] };
		recording.turns.push(turn);
		return turn;
	};

	for (const entry of branch) {
		if (entry.type === "compaction") {
			recording.summaries.push(entry.summary);
			continue;
		}
		if (entry.type === "custom_message") {
			if (inRun) recording.skipped.customMessages += 1;
			else idleCustom.push(entry);
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			recording.skipped.customMessages += idleCustom.length;
			idleCustom = [];
			current = startTurn({ kind: "user", text: textOf(message.content), images: imagesOf(message.content) });
			inRun = false;
		} else if (message.role === "assistant") {
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				recording.skipped.failedReplies += 1;
				continue;
			}
			if (idleCustom.length > 0) {
				// Started by the custom messages that arrived while idle; those the session writes itself are written again.
				const delivered = idleCustom.filter((custom) => !NATIVE_NOTICES.has(custom.customType));
				const messages = delivered.length > 0 ? delivered : idleCustom.slice(-1);
				recording.skipped.customMessages += idleCustom.length - messages.length;
				current = startTurn({ kind: "custom", messages });
				idleCustom = [];
			}
			const previous = current?.replies.at(-1);
			const ended = previous !== undefined && !previous.content.some((part) => part.type === "toolCall");
			if (!current || ended) {
				recording.skipped.orphanReplies += 1;
				continue;
			}
			current.replies.push(message);
			const usage = message.usage;
			recording.recordedUsage.input += usage?.input ?? 0;
			recording.recordedUsage.output += usage?.output ?? 0;
			recording.recordedUsage.cacheRead += usage?.cacheRead ?? 0;
			recording.recordedUsage.cacheWrite += usage?.cacheWrite ?? 0;
			const calls = message.content.filter((part) => part.type === "toolCall");
			for (const call of calls) names.add(call.name);
			inRun = calls.length > 0;
		} else if (message.role === "toolResult") {
			const queue = recording.results.get(message.toolCallId) ?? [];
			queue.push(message);
			recording.results.set(message.toolCallId, queue);
		} else recording.skipped.otherMessages += 1;
	}
	recording.skipped.customMessages += idleCustom.length;
	recording.toolNames = [...names].sort();
	return recording;
}
