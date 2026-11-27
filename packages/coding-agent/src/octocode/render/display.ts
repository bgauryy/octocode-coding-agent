import type { ToolDisplay, ToolDisplayBlock } from "@octocodeai/octocode-contracts";
import type { ToolDisplayInput } from "../../core/features/types.ts";

/**
 * The text blocks of a result, joined; images and other blocks are drawn from the result's content, not here. Any value
 * is accepted, since a stream's partial result is untyped: one without a content array has no text.
 */
export function displayText(result: unknown): string {
	const content = result && typeof result === "object" && "content" in result ? result.content : undefined;
	return Array.isArray(content)
		? content
				.flatMap((block) => (block?.type === "text" && typeof block.text === "string" ? [block.text] : []))
				.join("\n")
		: "";
}

/** A saved file the row names (`saved: <path>`, `log: <path>`). */
export function pathBlock(path: string | undefined, label = "saved"): ToolDisplayBlock[] {
	return path ? [{ type: "path", text: `${label}: ${path}`, label, path }] : [];
}

/**
 * The common result shape: the first line of the result (or `summary`) as the outcome, the rest as a text block, and a
 * saved path. A failure is an error outcome, or an interrupted one with `stopped`. Before a result, the header alone.
 */
export function textResultDisplay(
	head: ToolDisplay,
	{ result, status }: Pick<ToolDisplayInput, "result" | "status">,
	options: { summary?: string; spill?: string; stopped?: boolean; keepBody?: boolean; tail?: boolean } = {},
): ToolDisplay {
	if (!result) return head;
	const text = displayText(result).trim();
	const [first = "", ...rest] = text.split("\n");
	const failed = status === "failed";
	const summary = (failed ? undefined : options.summary) ?? first;
	const body = options.keepBody && options.summary && !failed ? text : rest.join("\n").trim();
	return {
		...head,
		...(summary
			? {
					outcome: {
						text: summary,
						...(failed ? { tone: "error" as const } : {}),
						...(failed && options.stopped ? { stopped: true as const } : {}),
					},
				}
			: {}),
		blocks: [
			...(body ? [{ type: "text" as const, text: body, ...(options.tail ? { preview: "tail" as const } : {}) }] : []),
			...pathBlock(options.spill),
		],
	};
}
