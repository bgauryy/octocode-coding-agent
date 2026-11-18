import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { GLYPH } from "@octocodeai/octocode-tui/text";
import type { ToolDefinition } from "../../core/features/index.ts";
import { displayText, textResultDisplay } from "../render/display.ts";
import { itemTitle, withItemTitles } from "../render/item-titles.ts";
import { timingOf } from "../render/rows.ts";
import { resultBlock, toolHeader } from "../render/tool.ts";
import { clip } from "../shared/text.ts";
import { contentText } from "../shared/util.ts";
import { styleBacklogHeadline, styleBacklogLines, styleBacklogSummary } from "./tool-style.ts";
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
		args.state ? `${GLYPH.arrow} ${shown(args.state, 20)}` : "",
		origin ? `from ${shown(origin, 20)}` : "",
		args.title ? `"${shown(args.title, 80)}"` : "",
		words ? `"${shown(words, 80)}"` : "",
	]
		.filter(Boolean)
		.join(" ");
}

/**
 * What each row's result said about itself, for its header: `B561 → done · Title` heads the row, so the result draws
 * no `⎿` line saying it again. Keyed by the row's render state; the header reads it on its next draw.
 */
const headlines = new WeakMap<object, { summary: string; meta?: string }>();

type Renderers = Pick<ToolDefinition, "display" | "renderCall" | "renderResult">;

/** The transcript, web and export rendering both backlog tools share; `title` heads the row. */
export function backlogRenderers(title: string): Renderers {
	return {
		display(input) {
			const args = (input.args ?? {}) as Record<string, unknown>;
			const head = { title, summary: target(args), kind: "other" as const, blocks: [] };
			if (!input.result || input.status === "failed") return textResultDisplay(head, input);
			const text = displayText(input.result);
			const read = isRead(args.op);
			const body = (read ? text : text.split("\n").slice(1).join("\n")).trim();
			const summary = backlogSummary(args.op, input.result.details ?? {}, text);
			return {
				...head,
				// A change says its result once, as the summary; a read keeps the call as the summary and the count as the outcome.
				...(read ? { outcome: { text: summary } } : { summary }),
				blocks: body ? [{ type: "text" as const, text: body }] : [],
			};
		},
		renderCall(args, theme, context) {
			const call = (args ?? {}) as Record<string, unknown>;
			// The result's headline replaces the call once it is known: it names the operation, item and title.
			const headline = context.state && typeof context.state === "object" ? headlines.get(context.state) : undefined;
			return toolHeader(theme, context, title, target(call, 80), headline ? { styled: headline } : {});
		},
		renderResult(result, _options, theme, context) {
			const text = contentText(result.content);
			const details = (result.details ?? {}) as BacklogToolDetails;
			const op = (context.args as { op?: unknown } | undefined)?.op;
			const plain = context.isError ? undefined : backlogSummary(op, details, text);
			const styledSummary = plain === undefined ? undefined : styleBacklogSummary(theme, plain);
			const parts = plain === undefined ? undefined : styleBacklogHeadline(theme, plain);
			const summary =
				plain === undefined ? (text.split("\n", 1)[0] ?? "") : styledSummary ? plain : withItemTitles(plain, itemTitle);
			const body = context.isError || !isRead(op) ? text.split("\n").slice(1).join("\n") : text;
			// A successful change is told by the header: the `⎿` line stays for reads, errors and a result with no headline.
			const headline =
				context.isError || isRead(op) || plain === undefined
					? undefined
					: parts
						? { summary: parts.change, ...(parts.title ? { meta: parts.title } : {}) }
						: { summary: theme.fg("toolOutput", sanitizeTerminalText(plain).replace(/\s+/g, " ").trim()) };
			const key = context.state && typeof context.state === "object" ? context.state : undefined;
			if (key) {
				const before = headlines.get(key);
				if (headline === undefined) headlines.delete(key);
				else headlines.set(key, headline);
				// The header drew before this result: redraw it once with the headline.
				const changed = before?.summary !== headline?.summary || before?.meta !== headline?.meta;
				if (changed && context.invalidate) {
					const invalidate = context.invalidate;
					queueMicrotask(() => invalidate());
				}
			}
			const told = key !== undefined && headline !== undefined;
			return resultBlock(theme, context, {
				summary: told ? "" : summary,
				...(styledSummary && !told ? { styledSummary } : {}),
				// Item and task lines get the board's colours; the text is the one the model read.
				...(context.isError ? { body } : { lines: body ? styleBacklogLines(theme, body) : [] }),
				...timingOf(result.details),
			});
		},
	};
}
