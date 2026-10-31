import path from "node:path";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * What the research server answered about file types it cannot serve: once it reports that a file's grammar is
 * unregistered or that no language server exists for it, later edits of files with the same extension in the same
 * session skip that feedback call instead of repeating the same error. The server owns the list of supported
 * languages; this remembers only its answers, per session and per tool, so nothing here presumes what it can parse.
 */

/** Session ids are few per process; the oldest sessions are forgotten past this count. */
const MAX_SESSIONS = 64;
const answered = new Map<string, Set<string>>();

/** The server's own words for a file type it does not serve (`syntaxTree.language.unsupported`, `serverUnavailable`). */
const UNSUPPORTED_MARKS = [
	/language\.unsupported/,
	/No registered tree-sitter grammar/,
	/"serverUnavailable"/,
	/"serverAvailable":\s*false/,
	/No language server is configured/,
];

/** The lower-cased extension of `file` (with its dot), or its whole name when it has none. */
function extensionOf(file: string): string {
	const extension = path.extname(file).toLowerCase();
	return extension || path.basename(file).toLowerCase();
}

function sessionSet(sessionId: string, tool: string): Set<string> {
	const key = `${sessionId}\0${tool}`;
	const known = answered.get(key);
	if (known) return known;
	if (answered.size >= MAX_SESSIONS) answered.delete(answered.keys().next().value!);
	const created = new Set<string>();
	answered.set(key, created);
	return created;
}

/** Whether the server already answered, in this session, that `tool` does not serve files like `file`. */
export function knownUnsupported(sessionId: string, tool: string, file: string): boolean {
	return answered.get(`${sessionId}\0${tool}`)?.has(extensionOf(file)) ?? false;
}

/** Remember the server's answer that `tool` does not serve files like `file`, for the rest of the session. */
export function noteUnsupported(sessionId: string, tool: string, file: string): void {
	sessionSet(sessionId, tool).add(extensionOf(file));
}

/** Whether a tool outcome is the server's answer that it does not serve this file type (not a transient failure). */
export function saysUnsupported(outcome: {
	result?: { content?: readonly { type: string; text?: string }[]; structuredContent?: unknown };
}): boolean {
	const result = outcome.result;
	if (!isRecord(result)) return false;
	const texts = [
		...(Array.isArray(result.content)
			? result.content.flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
			: []),
		...(result.structuredContent === undefined ? [] : [JSON.stringify(result.structuredContent)]),
	];
	return texts.some((text) => UNSUPPORTED_MARKS.some((mark) => mark.test(text)));
}
