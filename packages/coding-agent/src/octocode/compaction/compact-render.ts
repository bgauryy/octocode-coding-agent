import type { Component } from "@octocodeai/octocode-tui";
import type { Theme } from "../../theme/theme.ts";
import { resultBlock, resultText, toolHeader } from "../shared/render.ts";
import { timingOf } from "../shared/render/rows.ts";
import { clip, oneLine } from "../shared/render/text.ts";
import type { RenderContext } from "../shared/render/types.ts";

/** What the `compact` tool's result records for its row. */
export interface CompactDetails {
	queued: true;
	/** A request was already waiting: this call changed nothing. */
	already?: boolean;
}

/** `Compact(<focus>)`: what the summary must keep, when the call named something. */
export function compactHeader(theme: Theme, context: RenderContext, args: { focus?: unknown } | undefined): Component {
	const focus = typeof args?.focus === "string" ? args.focus.trim() : "";
	return toolHeader(theme, context, "Compact", focus ? clip(focus, 80) : "");
}

/** The sentence the model gets after a refusal; the row says why it was refused and stops there. */
const MODEL_ADVICE = /\s*Continue the task\.$/;

/**
 * The result row: what happened to the request. A refusal is not a failure (the model asked too early or too late), so it
 * draws as not run, in the warning colour, without an `Error:` prefix.
 */
export function compactResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	theme: Theme,
	context: RenderContext,
): Component {
	if (context.isError) {
		const text = oneLine(resultText(result)).replace(MODEL_ADVICE, "");
		return resultBlock(theme, context, {
			summary: text,
			body: "",
			stopped: text.startsWith("Compaction refused") || undefined,
		});
	}
	const details = result.details as Partial<CompactDetails> | undefined;
	return resultBlock(theme, context, {
		summary: `${details?.already ? "Already queued" : "Queued"} \u00b7 runs when this reply ends`,
		summaryColor: "customMessageText",
		body: "",
		max: 0,
		...timingOf(result.details),
	});
}
