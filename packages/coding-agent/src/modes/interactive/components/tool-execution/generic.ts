import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { queryTarget } from "../../../../../../common/src/clip.ts";
import { sanitizeTerminalText } from "../../../../../../common/src/sanitize.ts";
import type { ToolRenderers } from "../../../../core/features/types.ts";
import { resultBlock, resultText, toolHeader } from "../../../../octocode/render/tool.ts";
import { outputLanguage } from "../../../../theme/output-style.ts";
import { toolArgsForDisplay } from "../../../../octocode/ui/reason-row.ts";

/** Arguments that state why the call is made: the reason rows show them, the header does not repeat them. */
const PURPOSE_KEYS = new Set(["mainGoal", "reasoning", "reason"]);

/** Whether `value` carries nothing a header could show: an empty object or array, or an array of such (queries that held only a purpose). */
function isEmpty(value: unknown): boolean {
	if (Array.isArray(value)) return value.every(isEmpty);
	return isRecord(value) && Object.keys(value).length === 0;
}

/** The call's arguments as one header line: what each query looks for and where, else `key=value` pairs. */
function argsSummary(toolName: string, args: unknown): string {
	if (args === undefined || args === null) return "";
	if (!isRecord(args)) return JSON.stringify(args) ?? "";
	// The purpose strings (also inside `queries`) have their own `↳` row: the header does not repeat them.
	const shown = toolArgsForDisplay(toolName, args);
	const entries = Object.entries(isRecord(shown) ? shown : args).filter(
		([key, value]) => !PURPOSE_KEYS.has(key) && !isEmpty(value),
	);
	const queries = args.queries;
	if (Array.isArray(queries)) {
		const targets = queries.map((query) => (isRecord(query) ? queryTarget(query) : "")).filter(Boolean);
		if (targets.length > 0) return [...new Set(targets)].join(", ");
	}
	const target = queryTarget(Object.fromEntries(entries));
	if (target) return target;
	return entries
		.map(
			([key, value]) =>
				`${sanitizeTerminalText(key)}=${typeof value === "string" ? value : (JSON.stringify(value) ?? "")}`,
		)
		.join(" ");
}

/**
 * `renderers` when it draws the call or its result; else the native `Name(summary)` header and `⎿` result block, so a
 * tool without a renderer (every external MCP tool) looks like every other row.
 */
export function withGenericRenderers(renderers: ToolRenderers | undefined, toolName: string): ToolRenderers {
	if (renderers?.renderCall ?? renderers?.renderResult) return renderers;
	return {
		...renderers,
		// Nothing wraps this tool in `timed`, so no run start is recorded for its call id: the row times itself from its first drawn frame.
		renderCall: (args, theme, context) =>
			toolHeader(theme, { ...context, toolCallId: undefined }, toolName, argsSummary(toolName, args)),
		renderResult: (result, options, theme, context) => {
			const body = resultText(result);
			const language = context.isError ? undefined : outputLanguage(body);
			return resultBlock(theme, context, {
				summary: "",
				body,
				expanded: options.expanded,
				...(language ? { language } : {}),
			});
		},
	};
}
