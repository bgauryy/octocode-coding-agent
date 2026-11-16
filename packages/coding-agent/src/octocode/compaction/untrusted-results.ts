import { renderInstruction } from "../../core/prompt-template.ts";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { fenceUntrusted, headerText } from "../shared/fence.ts";
import { isWorkspaceReader } from "../shared/local-reads.ts";
import { untrustedResultOrigin } from "../permission/result-origin.ts";

/**
 * Web pages, search snippets, the results of MCP servers (GitHub content, browser pages, third-party servers, resources
 * read with the `mcp` tool) and the output of network commands (`curl`, `ssh`: the `NETWORK` programs) are text written
 * by someone other than the user, so a request shows each of them inside a fence that says it is data and names where it
 * came from (OWASP LLM01, Microsoft Spotlighting). Reads and searches of the user's own workspace (the reader and search roles of trusted
 * MCP entries, `isWorkspaceReader`) are not fenced: they are the repository the user asked about, and a fence would only
 * cost tokens on every read. A project entry's roles count only in a trusted project, so an untrusted server stays fenced.
 *
 * The fence is added when the request is built (`requestMessages`), never to the stored result, so:
 * - the session, the terminal, the API and ACP show and keep the text as the tool returned it;
 * - the read dedupe and the clearing of cold results hash and save the unfenced text, so they behave as before;
 * - the same result is fenced to the same bytes in every request (and after a resume): the marker is a hash of the text,
 *   not a random value, which keeps the cached prompt prefix intact. The text cannot contain its own hash, so it cannot
 *   close its fence early. The origin comes from the stored tool call, so it is the same in every request too.
 */

/**
 * Where the result of `toolName`, called with `input` (undefined when its call is not in the request), came from when
 * that is outside the user's workspace: the label its fence header names. Undefined for a trusted result. The `mcp` and
 * shell results count only when the call ran (`details` says so): a refused or blocked call holds Octocode's own text. A
 * shell result whose call is missing cannot be told apart from a local command, so it stays unfenced.
 */
function untrustedOrigin(toolName: string, input: unknown, details: unknown): string | undefined {
	if (toolName.startsWith("mcp__") && isWorkspaceReader(toolName)) return undefined;
	return untrustedResultOrigin(toolName, input, details);
}

const fenceText = (origin: string, text: string): string =>
	fenceUntrusted(`Result of ${headerText(origin)}`, text, {
		marker: `untrusted-${sha256(text).slice(0, 16)}`,
		note: renderInstruction("notices/mail/fence-tool-result.md"),
	});

/** The arguments of each tool call in `messages`, by call id: a result's origin is in the call that asked for it. */
function callArguments(messages: readonly unknown[]): Map<string, unknown> {
	const calls = new Map<string, unknown>();
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content)
			if (isRecord(part) && part.type === "toolCall" && typeof part.id === "string") calls.set(part.id, part.arguments);
	}
	return calls;
}

/**
 * `messages` with the text parts of untrusted tool results (web, MCP, `mcp` resource reads, network commands) fenced; a
 * result already replaced by a placeholder (`cleared`, by tool call id) and parts without text stay as they are. The same
 * list when nothing changes; the stored messages are never modified.
 */
export function fenceUntrustedResults<T>(messages: T[], cleared: ReadonlyMap<string, string> = new Map()): T[] {
	let calls: Map<string, unknown> | undefined;
	let changed = false;
	const result = messages.map((message): T => {
		if (
			!isRecord(message) ||
			message.role !== "toolResult" ||
			typeof message.toolName !== "string" ||
			cleared.has(String(message.toolCallId)) ||
			!Array.isArray(message.content)
		)
			return message;
		calls ??= callArguments(messages);
		const origin = untrustedOrigin(message.toolName, calls.get(String(message.toolCallId)), message.details);
		if (origin === undefined) return message;
		let touched = false;
		const content = message.content.map((part: unknown) => {
			if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string" || part.text === "") return part;
			touched = true;
			return { ...part, text: fenceText(origin, part.text) };
		});
		if (!touched) return message;
		changed = true;
		return { ...message, content };
	});
	return changed ? result : messages;
}
