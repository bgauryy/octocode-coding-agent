import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI } from "../../core/features/index.ts";
import { BranchIndex } from "../shared/branch-index.ts";
import { currentToolRoles } from "../../../../mcp/src/roles.ts";
import { sha256 } from "../../../../common/src/atomic-file.ts";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import { contextMessages, plainText, sessionCleared } from "./reads.ts";

/**
 * Repeated reads: when a read returns exactly the text an earlier call with the same arguments returned, and that earlier
 * result is still in the model's context (not compacted away, not cleared), the new result becomes a one-line note that
 * points at it. The text is the proof that the file did not change, so nothing guesses from modification times, and
 * nothing is lost: the content is in the context above.
 */

/** Tools whose result is the content of a file: MCP reader roles, and a `read` tool of a resumed transcript or an SDK caller (Octocode itself ships none). */
const isDeduped = (tool: string): boolean => tool === "read" || currentToolRoles().readers.has(tool);

interface ReadIndex {
	calls: Map<string, { input: Record<string, unknown>; key: string }>;
	results: Map<string, Array<{ id: string; text: string }>>;
	rebuild: boolean;
}

const resultKey = (tool: string, inputKey: string, text: string) => `${tool}\0${inputKey}\0${sha256(text)}`;

/** JSON tool inputs compare independently of property order; deep equality still verifies each candidate. */
export function argumentsKey(input: Record<string, unknown>): string {
	try {
		return JSON.stringify(input, (_key, value: unknown) =>
			isRecord(value)
				? Object.fromEntries(
						Object.keys(value)
							.sort()
							.map((key) => [key, value[key]]),
					)
				: value,
		);
	} catch {
		// An SDK caller can supply non-JSON data. Keep it in one bucket and rely on exact comparison.
		return "";
	}
}

/** Cache each prior result's text once; hash buckets avoid comparing unrelated reads. */
function indexMessage(state: ReadIndex, message: unknown): void {
	if (!isRecord(message)) return;
	if (message.role === "assistant" && Array.isArray(message.content)) {
		for (const part of message.content)
			if (isRecord(part) && part.type === "toolCall" && typeof part.id === "string" && isRecord(part.arguments))
				state.calls.set(part.id, { input: part.arguments, key: argumentsKey(part.arguments) });
		return;
	}
	if (
		message.role !== "toolResult" ||
		message.isError === true ||
		typeof message.toolName !== "string" ||
		!isDeduped(message.toolName)
	)
		return;
	const text = plainText(message.content);
	if (text === undefined) return;
	const call = state.calls.get(String(message.toolCallId));
	if (!call) return;
	const key = resultKey(message.toolName, call.key, text);
	const results = state.results.get(key) ?? [];
	results.push({ id: String(message.toolCallId), text });
	state.results.set(key, results);
}

/** The note that stands for a repeated result of `toolName` called with `input`. */
function unchangedNote(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "read" && typeof input.path === "string")
		return `[Unchanged since your earlier read of ${input.path} (same range); that result is above in your context.]`;
	return `[Unchanged since your earlier ${toolName} of the same arguments; that result is above in your context.]`;
}

/**
 * Replaces the result of a repeated read with `unchangedNote`. The note keeps the read's own `details` (so the file guard
 * still sees a whole or a partial read) and adds `unchangedOf`, the tool call id of the full result it points at.
 *
 * Registered after the file guard's `tool_result` handler (`registerFileTool`): the guard digests the text the read
 * returned, so it must see that text, not the note.
 */
export function registerReadDedupe(api: ExtensionAPI): void {
	const index = new BranchIndex<ReadIndex>(
		() => ({ calls: new Map(), results: new Map(), rebuild: true }),
		(state, entry) => {
			if (!isRecord(entry)) return;
			// These entries change earlier messages. Rebuild from the canonical projection, never infer retained context.
			if (entry.type === "compaction" || entry.type === "context_edit") state.rebuild = true;
			if (!state.rebuild && entry.type === "message") indexMessage(state, entry.message);
		},
	);
	api.on("tool_result", async (event, ctx) => {
		if (event.isError || !isDeduped(event.toolName)) return undefined;
		const text = plainText(event.content);
		if (text === undefined) return undefined;
		const state = index.read(ctx.sessionManager);
		if (state.rebuild) {
			state.calls.clear();
			state.results.clear();
			for (const { message } of contextMessages(ctx)) indexMessage(state, message);
			state.rebuild = false;
		}
		const cleared = sessionCleared(ctx.sessionManager);
		for (const { id, text: previous } of state.results.get(
			resultKey(event.toolName, argumentsKey(event.input), text),
		) ?? []) {
			const arguments_ = state.calls.get(id);
			if (
				id === event.toolCallId ||
				cleared.has(id) ||
				!arguments_ ||
				!isDeepStrictEqual(arguments_.input, event.input) ||
				previous !== text
			)
				continue;
			return {
				content: [{ type: "text" as const, text: unchangedNote(event.toolName, event.input) }],
				details: { ...asRecord(event.details), unchangedOf: id },
			};
		}
		return undefined;
	});
}
