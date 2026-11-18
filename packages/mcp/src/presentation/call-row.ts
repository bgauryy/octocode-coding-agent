import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { hostRender } from "../host.ts";
import type { McpToolRenderers } from "../host/types.ts";

/** Keys whose text the call's purpose line shows, so the call row never repeats it. */
const PURPOSE_KEYS = ["reason", "mainGoal", "reasoning"] as const;
/** Characters of the title's argument summary. */
const SUMMARY_CHARS = 60;

function withoutPurpose(record: Record<string, unknown>): Record<string, unknown> {
	const copy = { ...record };
	for (const key of PURPOSE_KEYS) if (typeof copy[key] === "string" && copy[key].trim()) delete copy[key];
	return copy;
}

/** The call's arguments without its purpose text, top level and inside each query. */
function callArguments(args: unknown): unknown {
	if (!isRecord(args)) return args;
	const copy = withoutPurpose(args);
	if (Array.isArray(copy.queries))
		copy.queries = copy.queries.map((query: unknown) => (isRecord(query) ? withoutPurpose(query) : query));
	return copy;
}

const scalar = (value: unknown): string | undefined =>
	typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;

/** A short title summary: the number of queries, else the first scalar arguments as `key=value`. */
function callSummary(args: unknown): string {
	if (!isRecord(args)) return "";
	const queries = Array.isArray(args.queries) ? args.queries.length : 0;
	if (queries > 0) return `${queries} ${queries === 1 ? "query" : "queries"}`;
	return Object.entries(args)
		.flatMap(([key, value]) => {
			const text = scalar(value);
			return text === undefined ? [] : [`${key}=${text}`];
		})
		.join(" ")
		.replace(/\s+/g, " ")
		.slice(0, SUMMARY_CHARS);
}

/** A `server/tool` label as a row names it: the tool is the title, the server its metadata; another label is the title. */
export function labelParts(label: string): { title: string; server?: string } {
	const slash = label.lastIndexOf("/");
	if (slash <= 0 || slash === label.length - 1) return { title: label };
	return { title: label.slice(slash + 1), server: label.slice(0, slash) };
}

/**
 * The call row of an MCP tool labeled `server/tool`: the shared tool header, `localSearch(…) · octocode`, with the
 * arguments below it when expanded.
 */
export function renderMcpCall(label: string): NonNullable<McpToolRenderers["renderCall"]> {
	const { title, server } = labelParts(label);
	return (args, theme, context) => {
		const shown = callArguments(args);
		const detail = context.expanded
			? hostRender().formatToolCallWithArgs("", shown, theme, true).split("\n").slice(1)
			: [];
		return hostRender().toolHeader(theme, context, title, callSummary(shown), {
			lines: detail,
			...(server ? { meta: server } : {}),
		});
	};
}
