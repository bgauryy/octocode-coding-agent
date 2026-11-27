import fs from "node:fs";
import type { Message } from "@octocodeai/octocode-ai";
import { convertToLlm } from "../../core/messages.ts";
import type { ReadonlySessionManager, SessionEntry } from "../../core/session-manager.ts";
import { createSessionHeader, generateId, getSessionFilePath } from "../../core/session-manager/entries.ts";
import { writeNewSessionFile } from "../../core/session-manager/storage.ts";
import { emptyUsage } from "../shared/util.ts";
import type { ChildSession } from "./process/session.ts";

/**
 * The conversation a `context: "fork"` child starts from: what the parent's model sees on its active branch at this
 * moment, in provider shape. Other branches never enter, nor do records the model never sees (display-only messages,
 * `!!` shell output, state entries). The parent's prompt and tools stay with the parent: the child gets its own. Tool
 * calls without a result yet (this very call and its parallel siblings) are removed, so the copy is a valid history.
 */
function freezeVisibleBranch(session: Pick<ReadonlySessionManager, "readSessionProjection">): Message[] {
	const visible = convertToLlm(session.readSessionProjection().messages).filter((message) => message.role !== "system");
	const answered = new Set<string>();
	for (const message of visible) if (message.role === "toolResult") answered.add(message.toolCallId);
	const kept = new Set<string>();
	const frozen: Message[] = [];
	for (const message of visible) {
		if (message.role === "toolResult") {
			if (!kept.has(message.toolCallId)) continue;
			const { usage: _toolUsage, ...rest } = message;
			frozen.push(rest);
		} else if (message.role === "assistant") {
			const content = message.content.filter((block) => block.type !== "toolCall" || answered.has(block.id));
			if (content.length === 0) continue;
			for (const block of content) if (block.type === "toolCall") kept.add(block.id);
			// The child's own turns are what it spends: the copied turns start its accounting at zero.
			frozen.push({ ...message, content, usage: emptyUsage() });
		} else frozen.push(message);
	}
	return frozen;
}

/**
 * The frozen conversation of a call that asked for `context: "fork"`, else undefined. Only a new Octocode child can
 * start from one: a resumed child keeps its own conversation and a runner holds its own in its CLI.
 */
export function forkedContext(
	params: { context?: string; resume?: string; runner?: string },
	session: Pick<ReadonlySessionManager, "readSessionProjection">,
): Message[] | undefined {
	if (params.context !== "fork") return undefined;
	if (params.resume || params.runner)
		throw new Error("context: fork starts a new Octocode child; resume and runner do not take it.");
	return freezeVisibleBranch(session);
}

/** The branch's entries in one chain, each message stamped with its own time. */
function chain(messages: readonly Message[], now: number): SessionEntry[] {
	const ids = new Set<string>();
	let parentId: string | null = null;
	return messages.map((message) => {
		const id = generateId(ids);
		ids.add(id);
		const at = Number.isFinite(message.timestamp) ? message.timestamp : now;
		const entry: SessionEntry = { type: "message", id, parentId, timestamp: new Date(at).toISOString(), message };
		parentId = id;
		return entry;
	});
}

/**
 * Saves `messages` as the child's own session before it starts: a new id and file in its session folder, which the
 * child opens by that id as it would a resumed conversation. Returns the file; an existing one is an error, never
 * overwritten.
 */
export function writeForkedSession(
	session: ChildSession,
	cwd: string,
	parentSessionId: string,
	messages: readonly Message[],
	now = Date.now(),
): string {
	fs.mkdirSync(session.dir, { recursive: true, mode: 0o700 });
	const timestamp = new Date(now).toISOString();
	const file = getSessionFilePath(session.dir, timestamp, session.id);
	writeNewSessionFile(file, [
		{ ...createSessionHeader(session.id, timestamp, cwd, undefined), parentSessionId },
		...chain(messages, now),
	]);
	return file;
}
