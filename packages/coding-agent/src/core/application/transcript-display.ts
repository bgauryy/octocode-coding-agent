import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import {
	applicationContentText,
	keepEnds,
	OUTPUT_CHARS,
	type ApplicationTool,
	type ToolDisplay,
	type ToolDisplayBlock,
} from "@octocodeai/octocode-contracts";
import type { ToolDisplayFunction } from "../features/types/tools.ts";

/** The session members the transcript reads: where session temp files go, and each tool's display. */
export interface TranscriptSession {
	sessionManager: object;
	getToolRenderers?(name: string): { display?: ToolDisplayFunction } | undefined;
}

/** A block's text past this many characters keeps its start and end in the display; the tool's content keeps all of it. */
const BLOCK_CHARS = OUTPUT_CHARS;

/** The first non-empty line of a result's text, for the outcome line. */
function firstLine(text: string): string {
	return (
		text
			.split("\n")
			.find((line) => line.trim())
			?.trim() ?? ""
	);
}

/**
 * How a tool without its own `display()` is drawn: its name, the label from its arguments (`hint`), and its displayed
 * result text (`text`, after any output projection, never the raw result).
 */
export function genericToolDisplay(
	toolName: string,
	hint: string | undefined,
	text: string,
	status: ApplicationTool["status"],
): ToolDisplay {
	return {
		title: toolName,
		...(hint ? { summary: hint } : {}),
		...(status !== "running" && text
			? { outcome: { text: firstLine(text), ...(status === "failed" ? { tone: "error" as const } : {}) } }
			: {}),
		blocks: text ? [{ type: "text", text, ...(status === "running" ? { preview: "tail" as const } : {}) }] : [],
	};
}

function boundBlock(block: ToolDisplayBlock): ToolDisplayBlock {
	return block.text.length > BLOCK_CHARS ? { ...block, text: keepEnds(block.text, BLOCK_CHARS) } : block;
}

/**
 * The display of a call: the tool's own `display()` (Octocode adds the reason line to every tool's, see
 * `octocode/ui/tool-display.ts`) when it has one and it succeeds, else the generic display, each block's text bounded.
 */
export function buildToolDisplay(
	display: ToolDisplayFunction | undefined,
	input: {
		toolName: string;
		args: unknown;
		result?: unknown;
		text: string;
		status: ApplicationTool["status"];
		/** The label from the arguments for the generic display. */
		hint?: string;
	},
): ToolDisplay {
	let built: ToolDisplay | undefined;
	if (display)
		try {
			built = display({
				toolName: input.toolName,
				args: input.args ?? {},
				result: input.result as AgentToolResult<unknown> | undefined,
				status: input.status,
			});
		} catch {
			// A display that cannot read this result (an older shape) falls back; the call itself is unaffected.
			built = undefined;
		}
	built ??= genericToolDisplay(input.toolName, input.hint, input.text, input.status);
	return {
		...built,
		blocks: built.blocks.map(boundBlock),
		...(built.preface ? { preface: built.preface.map(boundBlock) } : {}),
	};
}

/**
 * A tool's display after an event: rebuilt from the latest result when the event carried one (`replaced`) or the call
 * finished, otherwise the display it had. A call that never ran has no result, so its stop text is the outcome.
 * A projected result keeps the renderer's argument-only metadata and uses the projection for its outcome and blocks.
 */
export function toolDisplay(
	tool: ApplicationTool,
	result: unknown,
	replaced: boolean,
	lookup: (toolName: string) => ToolDisplayFunction | undefined,
	projected = false,
): ToolDisplay {
	if (!replaced && tool.display && tool.status === "running") return tool.display;
	let display = buildToolDisplay(lookup(tool.toolName), {
		toolName: tool.toolName,
		args: tool.arguments,
		result: projected ? undefined : result,
		text: tool.content ? applicationContentText(tool.content) : tool.text,
		status: tool.status,
		...(tool.hint ? { hint: tool.hint } : {}),
	});
	if (projected) {
		const { title, summary, meta, subjects, reason, kind, preface } = display;
		const { blocks, outcome } = genericToolDisplay(tool.toolName, tool.hint, tool.text, tool.status);
		display = { title, summary, meta, subjects, reason, kind, preface, blocks, outcome };
	}
	if (display.outcome || tool.status === "running" || !tool.text) return display;
	return {
		...display,
		outcome: { text: tool.text, tone: "error", ...(tool.notRun ? { stopped: true as const } : {}) },
	};
}
