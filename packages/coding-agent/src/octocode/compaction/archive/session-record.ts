import fs from "node:fs";
import type { ExtensionContext } from "../../../core/extensions/index.ts";
import type { RecordMessage, SessionRecord } from "../../shared/archive/record.ts";
import { repoKey } from "../../shared/home/repo.ts";
import { isRecord } from "../../../utils/guards.ts";
import { PARENT_SESSION_ENV } from "../../shared/env.ts";

/** The most forks a lineage follows back: a chain of session files that points in a circle stops here too. */
const LINEAGE_DEPTH = 32;

/** The id and source of the session file `file` (its first line, Octocode's header); undefined when it cannot be read. */
function sessionHeaderOf(file: string): { id: string; parentSession?: string } | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "r");
		const buffer = Buffer.alloc(64 * 1024);
		const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
		const header: unknown = JSON.parse(buffer.subarray(0, read).toString("utf8").split("\n")[0] ?? "");
		if (!isRecord(header) || header.type !== "session" || typeof header.id !== "string") return undefined;
		return {
			id: header.id,
			...(typeof header.parentSession === "string" ? { parentSession: header.parentSession } : {}),
		};
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/**
 * The sessions this one was forked from, nearest first: Octocode's header names the source session's file
 * (`parentSession`), whose own header may name an earlier one. A source that is gone ends the chain.
 */
export function forkLineage(sessions: Pick<ExtensionContext["sessionManager"], "getHeader">): string[] {
	const ids: string[] = [];
	let source = sessions.getHeader()?.parentSession;
	while (source && ids.length < LINEAGE_DEPTH) {
		const header = sessionHeaderOf(source);
		if (!header || ids.includes(header.id)) break;
		ids.push(header.id);
		source = header.parentSession;
	}
	return ids;
}

/** A message's text, without thinking, tool calls or images. */
const messageText = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content
					.flatMap((part) =>
						isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
					)
					.join("\n\n")
			: "";

/**
 * The current session's record (`shared/archive.ts`) from its branch: its first user message is its goal, its last user
 * message and the replies after it its ending (their text; their tool calls are counted). Undefined when the session is
 * not saved (`--no-session`: nothing outlives it) or has no user message yet.
 */
export function sessionRecordOf(
	sessions: ExtensionContext["sessionManager"],
	lineage: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
): SessionRecord | undefined {
	const transcript = sessions.getSessionFile();
	if (!transcript) return undefined;
	const messages = sessions.getBranch().flatMap((entry) => {
		const message: unknown = entry.type === "message" ? entry.message : undefined;
		return isRecord(message) ? [{ message, at: entry.timestamp }] : [];
	});
	const users = messages.flatMap((entry, index) =>
		entry.message.role === "user" && messageText(entry.message.content).trim() ? [index] : [],
	);
	if (users.length === 0) return undefined;
	const toRecord = ({ message, at }: (typeof messages)[number]): RecordMessage => ({
		role: String(message.role),
		at,
		text: messageText(message.content),
	});
	const tail = messages.slice(users.at(-1));
	const ending = tail
		.filter(
			(entry, index) =>
				index === 0 || (entry.message.role === "assistant" && messageText(entry.message.content).trim()),
		)
		.map(toRecord);
	const toolCalls = tail.reduce(
		(sum, { message }) =>
			sum +
			(Array.isArray(message.content)
				? message.content.filter((part) => isRecord(part) && part.type === "toolCall").length
				: 0),
		0,
	);
	const cwd = sessions.getCwd();
	const parent = env[PARENT_SESSION_ENV]?.trim();
	const name = sessions.getSessionName();
	const started = sessions.getHeader()?.timestamp;
	const lastActive = sessions.getBranch().at(-1)?.timestamp;
	return {
		session: sessions.getSessionId(),
		repository: repoKey(cwd).key,
		workspace: cwd,
		...(lineage[0] ? { forkedFrom: lineage[0] } : {}),
		...(parent ? { parent } : {}),
		...(name ? { name } : {}),
		...(started ? { started } : {}),
		...(lastActive ? { lastActive } : {}),
		transcript,
		goal: toRecord(messages[users[0]]),
		ending,
		toolCalls,
	};
}
