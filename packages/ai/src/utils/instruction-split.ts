import type { SystemMessage } from "../types.ts";
import { contentText } from "./text.ts";

/**
 * The leading system prompt cut into instruction blocks. `cached` holds one to three blocks that each end in a cache
 * breakpoint; `volatile` is the trailing block that carries none. Every block but the last ends with the "\n\n"
 * joiner, so `instructionBlockTexts(blocks).join("")` is exactly `getSystemMessageText(message)`.
 */
export interface InstructionBlocks {
	cached: readonly string[];
	volatile?: string;
	/** True when the last cached block holds the workspace's own sections (the first block that differs between workspaces). */
	workspace?: true;
}

/** The blocks in prompt order. */
export function instructionBlockTexts(blocks: InstructionBlocks): string[] {
	return blocks.volatile === undefined ? [...blocks.cached] : [...blocks.cached, blocks.volatile];
}

/**
 * Whether the tools keep their own breakpoint beside these blocks. A second cached block takes that slot: the base
 * block's breakpoint already covers the tools that precede it, and the request stays within four breakpoints.
 */
export function keepsToolBreakpoint(blocks: InstructionBlocks | undefined): boolean {
	return !blocks || blocks.cached.length < 2;
}

/**
 * Splits a leading system message into up to four instruction blocks, for adapters with explicit cache breakpoints.
 * The base block holds the content and every section before `boundary`; the session block runs from `boundary` up to
 * `workspaceBoundary` (the sections that differ between workspaces, so the blocks before it are shared across them) or
 * `volatileBoundary`; the workspace block runs on to `volatileBoundary`; the volatile block holds `volatileBoundary` and every later section and is sent without a
 * breakpoint, so a change in it (the date, the working directory, MCP status) rewrites no cached block. Either
 * boundary may be absent or name no section: its cut is then not made.
 *
 * Returns undefined, meaning "send one block", when the message has no sections (an opaque prompt never splits),
 * when no cut applies, or when nothing would be left to cache before the volatile block.
 */
export function splitSystemMessageIntoBlocks(
	message: SystemMessage,
	boundary: string | undefined,
	volatileBoundary?: string,
	workspaceBoundary?: string,
): InstructionBlocks | undefined {
	if ((!boundary && !volatileBoundary && !workspaceBoundary) || !message.sections) return undefined;
	const parts: string[][] = [[contentText(message.content)], [], [], []];
	let stage = 0;
	for (const [name, text] of Object.entries(message.sections)) {
		if (name === volatileBoundary) stage = 3;
		else if (name === workspaceBoundary && stage < 2) stage = 2;
		else if (name === boundary && stage === 0) stage = 1;
		if (text !== null) parts[stage].push(text);
	}
	const [base, session, workspace, volatile] = parts.map((part) => part.filter((text) => text.length > 0).join("\n\n"));
	const cached = [base, session, workspace].filter((text) => text.length > 0);
	// Without a base there is nothing a second breakpoint would save: the prompt stays one block.
	if (base.length === 0 && volatile.length === 0) return undefined;
	if (cached.length === 0 || (cached.length === 1 && volatile.length === 0)) return undefined;
	const texts = volatile.length > 0 ? [...cached, volatile] : cached;
	const joined = texts.map((text, index) => (index < texts.length - 1 ? `${text}\n\n` : text));
	const flag = workspace.length > 0 ? { workspace: true as const } : {};
	return volatile.length > 0
		? { cached: joined.slice(0, -1), volatile: joined.at(-1), ...flag }
		: { cached: joined, ...flag };
}
