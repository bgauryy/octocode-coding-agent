import type { ToolDefinition } from "../../core/features/index.ts";
import { displayText, textResultDisplay } from "../render/display.ts";
import { itemTitle, withItemTitles } from "../render/item-titles.ts";
import { timingOf } from "../render/rows.ts";
import { resultBlock, toolHeader } from "../render/tool.ts";
import { clip } from "../shared/text.ts";
import { contentText } from "../shared/util.ts";
import { styleBacklogLines } from "./tool-style.ts";
import { type BacklogToolDetails, backlogSummary } from "./tool-text.ts";

/** The operations whose whole result is the body: the others start with a line the summary already says. */
const isRead = (op: unknown): boolean => op === "list" || op === "get";

/**
 * What a call names, for its row: operation, item, and the title or text it carries. It reads the arguments of both
 * tools and of calls stored before the split (`backlog` with `op` list, add or update and a `state`), so an old session
 * draws as it did.
 */
function target(call: Record<string, unknown>, limit?: number): string {
	const shown = (value: unknown, max: number) => (limit === undefined ? String(value) : clip(String(value), max));
	// `backlogPlan` writes the entries of `items`: one entry is named like a single call, several by their count.
	const items = Array.isArray(call.items) ? (call.items as unknown[]) : [];
	const only = items.length === 1 && items[0] !== null && typeof items[0] === "object" ? items[0] : {};
	const args: Record<string, unknown> = { ...call, ...only };
	const origin = args.from ?? args.derivedFrom;
	const words = args.query ?? args.inTitle;
	return [
		args.op,
		args.id,
		items.length > 1 ? `${items.length} items` : "",
		args.state ? `→ ${shown(args.state, 20)}` : "",
		origin ? `from ${shown(origin, 20)}` : "",
		args.title ? `"${shown(args.title, 80)}"` : "",
		words ? `"${shown(words, 80)}"` : "",
	]
		.filter(Boolean)
		.join(" ");
}

type Renderers = Pick<ToolDefinition, "display" | "renderCall" | "renderResult">;

/** The transcript, web and export rendering both backlog tools share; `title` heads the row. */
export function backlogRenderers(title: string): Renderers {
	return {
		display(input) {
			const args = (input.args ?? {}) as Record<string, unknown>;
			const head = { title, summary: target(args), kind: "other" as const, blocks: [] };
			if (!input.result || input.status === "failed") return textResultDisplay(head, input);
			const text = displayText(input.result);
			const body = (isRead(args.op) ? text : text.split("\n").slice(1).join("\n")).trim();
			return {
				...head,
				outcome: { text: backlogSummary(args.op, input.result.details ?? {}, text) },
				blocks: body ? [{ type: "text" as const, text: body }] : [],
			};
		},
		renderCall(args, theme, context) {
			const call = (args ?? {}) as Record<string, unknown>;
			return toolHeader(theme, context, title, withItemTitles(target(call, 80), itemTitle));
		},
		renderResult(result, _options, theme, context) {
			const text = contentText(result.content);
			const details = (result.details ?? {}) as BacklogToolDetails;
			const op = (context.args as { op?: unknown } | undefined)?.op;
			const summary = context.isError
				? (text.split("\n", 1)[0] ?? "")
				: withItemTitles(backlogSummary(op, details, text), itemTitle);
			const body = context.isError || !isRead(op) ? text.split("\n").slice(1).join("\n") : text;
			return resultBlock(theme, context, {
				summary,
				// Item and task lines get the board's colours; the text is the one the model read.
				...(context.isError ? { body } : { lines: body ? styleBacklogLines(theme, body) : [] }),
				...timingOf(result.details),
			});
		},
	};
}
