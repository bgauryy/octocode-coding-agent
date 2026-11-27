import { renderPrompt } from "../../core/prompt-template.ts";
import type { FeatureSetup, FeatureContext } from "../../core/features/index.ts";
import { nestedContextFiles } from "../../core/resource-loader/context-files.ts";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import { recordedLocalReads } from "../shared/local-reads.ts";
import { bashReads } from "./bash-reads.ts";
import { clearedResults } from "./reads.ts";

/**
 * Instruction files below the working folder, delivered when the agent first reads a file under them. The system prompt
 * holds the working folder's AGENTS.md and its ancestors' only; a deeper one reaches the model appended to the first
 * read result under its folder, framed as the project context is, so the cached prefix never changes. Which files a
 * result read comes from the read receipts (`details.localReads`, any reader role, never a tool's name) or a plain bash
 * print (`bashReads`). Only in a trusted project; each file is cut at 64 KB as project context is, and a session
 * delivers at most `NESTED_CONTEXT_MAX_BYTES` while those results are in context; a file left out for that budget is named in
 * the result. A delivered file is named in its
 * result's `details.nestedContext`; after a compaction summarizes that result away or clearing replaces its text, the
 * next read under the folder delivers it again.
 */

/** The `details` key naming the instruction files a result delivered. */
export const NESTED_CONTEXT_DETAILS = "nestedContext";
/** Bytes of nested instruction text the context may hold at once; past it a file waits for the agent to read it. */
export const NESTED_CONTEXT_MAX_BYTES = 64 * 1024;

interface Delivered {
	path: string;
	bytes: number;
}

function isDelivered(value: unknown): value is Delivered {
	return isRecord(value) && typeof value.path === "string" && Number.isSafeInteger(value.bytes);
}

/**
 * The files whose delivering results the model still sees: a compaction keeps the results from its first kept entry on
 * (none when that entry is unknown), and a cleared result's text, appended files included, is gone.
 */
function deliveredInContext(ctx: Pick<FeatureContext, "sessionManager">): Delivered[] {
	const branch = ctx.sessionManager.getBranch();
	const cleared = clearedResults(branch);
	const position = new Map<string, number>();
	let deliveries: Array<{ at: number; files: Delivered[] }> = [];
	branch.forEach((entry, at) => {
		if (typeof entry.id === "string") position.set(entry.id, at);
		if (entry.type === "compaction") {
			const kept = typeof entry.firstKeptEntryId === "string" ? position.get(entry.firstKeptEntryId) : undefined;
			deliveries = kept === undefined ? [] : deliveries.filter((delivery) => delivery.at >= kept);
			return;
		}
		if (entry.type !== "message") return;
		const message = asRecord(entry.message);
		if (typeof message.toolCallId === "string" && cleared.has(message.toolCallId)) return;
		const listed = asRecord(message.details)[NESTED_CONTEXT_DETAILS];
		if (Array.isArray(listed)) deliveries.push({ at, files: listed.filter(isDelivered) });
	});
	return deliveries.flatMap((delivery) => delivery.files);
}

/** The files the result read: its read receipts, or the files a bash command printed. */
function readFiles(event: { toolName: string; input: Record<string, unknown>; details: unknown }, cwd: string) {
	if (event.toolName === "bash" && typeof event.input.command === "string")
		return bashReads(event.input.command, cwd).map((read) => read.file);
	return recordedLocalReads(event.details).map((read) => read.file);
}

export function registerNestedContext(api: FeatureSetup): void {
	api.bus.on("tool_result", async (event, ctx) => {
		if (event.isError || event.parentToolCallId || !ctx.isProjectTrusted()) return undefined;
		if (!event.content.some((part) => part.type === "text")) return undefined;
		const files = readFiles(event, ctx.cwd);
		if (files.length === 0) return undefined;
		const delivered = deliveredInContext(ctx);
		const seen = new Set([...delivered.map((item) => item.path), ...files]);
		let budget = NESTED_CONTEXT_MAX_BYTES - delivered.reduce((sum, item) => sum + item.bytes, 0);
		const added: Array<{ path: string; content: string; bytes: number }> = [];
		const withheld: string[] = [];
		for (const file of files)
			for (const context of nestedContextFiles(file, ctx.cwd)) {
				if (seen.has(context.path)) continue;
				seen.add(context.path);
				const bytes = Buffer.byteLength(context.content);
				if (bytes > budget) {
					withheld.push(context.path);
					continue;
				}
				budget -= bytes;
				added.push({ ...context, bytes });
			}
		if (added.length === 0 && withheld.length === 0) return undefined;
		// A file left out for the budget is named, never dropped silently: the agent can read it itself.
		const notice =
			withheld.length > 0 ? [renderPrompt("notices/nested-context-withheld.md", { paths: withheld.join(", ") })] : [];
		if (added.length === 0)
			return {
				content: [...event.content, { type: "text" as const, text: notice.join("") }],
				details: asRecord(event.details),
				...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
			};
		// The same frame as the project context in the system prompt, whose rule (a deeper file wins in its folder) applies.
		const blocks = added.map(
			({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
		);
		return {
			content: [...event.content, { type: "text" as const, text: [...blocks, ...notice].join("\n\n") }],
			details: {
				...asRecord(event.details),
				[NESTED_CONTEXT_DETAILS]: added.map(({ path, bytes }) => ({ path, bytes })),
			},
			...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
		};
	});
}
