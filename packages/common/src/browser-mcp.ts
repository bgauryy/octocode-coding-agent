import { BROWSER_SERVER, mcpNamespace } from "./mcp-names.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

const PREFIX = `${mcpNamespace(BROWSER_SERVER)}__`;

/** The browser MCP server's tool name in `name` (`mcp__browser__run` → `run`), or undefined for any other tool. */
export const browserMcpTool = (name: string): string | undefined =>
	name.startsWith(PREFIX) ? name.slice(PREFIX.length) : undefined;

/** CDP methods whose `params.url` opens a page. */
const NAVIGATING_CDP = new Set(["Page.navigate", "Target.createTarget"]);

/** A raw CDP command a browser MCP call carries. */
export interface BrowserMcpCdp {
	method: string;
	params: Record<string, unknown>;
}

/** The parameters of a `flow` call that runs a flow (`name` and `params`, no CDP `method`): they fill a plan's placeholders. */
const flowParamsOf = (input: Record<string, unknown>): Record<string, unknown> =>
	input.action === "run" && input.method === undefined && isRecord(input.params) ? input.params : {};

/** A page script a browser MCP call runs: an `evaluate` plan step, or a flow's `trigger` parameter. */
export interface BrowserMcpScript {
	/** Where the script travels, for a person reading the ask. */
	source: string;
}

/**
 * What a browser MCP call hands the browser, from every place the package (`@octocodeai/octocode-chrome-devtools`)
 * reads it: raw CDP commands (the `cdp` tool, plan `cdp` steps), page actions (plan `act` steps), page scripts (plan
 * `evaluate` steps and a flow's `trigger` parameter, which a built-in flow runs as an `evaluate` step) and launch
 * fields (`open`'s `launch`, `attach`). Plans reach the package through `run` and through `flow` (`save` takes one).
 */
export function browserMcpParts(input: Record<string, unknown>): {
	cdp: BrowserMcpCdp[];
	acts: Record<string, unknown>[];
	scripts: BrowserMcpScript[];
	launch: Record<string, unknown>;
	attach: boolean;
} {
	const cdp: BrowserMcpCdp[] = [];
	const acts: Record<string, unknown>[] = [];
	const scripts: BrowserMcpScript[] = [];
	const addCdp = (method: unknown, params: unknown) => {
		if (typeof method === "string") cdp.push({ method, params: isRecord(params) ? params : {} });
	};
	if (isRecord(input.plan) && Array.isArray(input.plan.steps))
		for (const value of input.plan.steps) {
			if (!isRecord(value)) continue;
			if (value.op === "cdp") addCdp(value.method, value.params);
			else if (value.op === "act") acts.push(value);
			else if (value.op === "evaluate") scripts.push({ source: "an evaluate step" });
		}
	addCdp(input.method, input.params);
	const flowParams = flowParamsOf(input);
	if (flowParams.trigger !== undefined) scripts.push({ source: "the flow's trigger" });
	return {
		cdp,
		acts,
		scripts,
		launch: isRecord(input.launch) ? input.launch : {},
		attach: input.attach === true,
	};
}

/**
 * The addresses a browser MCP call asks Chrome to open: `open`'s `url`, a connection's `newTab`, a tab group's `urls`,
 * a flow's `url` parameter, plan `goto` URLs, and the URL of a navigating CDP command. Pages the opened page then loads, and links a click follows, are not
 * known before the call runs.
 */
export function browserMcpUrls(toolName: string, input: Record<string, unknown>): string[] {
	if (browserMcpTool(toolName) === undefined) return [];
	const urls: string[] = [];
	const add = (value: unknown) => {
		if (typeof value === "string" && value.trim()) urls.push(value.trim());
	};
	add(input.url);
	if (isRecord(input.connection)) add(input.connection.newTab);
	if (Array.isArray(input.urls)) input.urls.forEach(add);
	add(flowParamsOf(input).url);
	const steps = isRecord(input.plan) && Array.isArray(input.plan.steps) ? input.plan.steps : [];
	for (const value of steps) if (isRecord(value) && value.op === "goto") add(value.url);
	for (const { method, params } of browserMcpParts(input).cdp) if (NAVIGATING_CDP.has(method)) add(params.url);
	return [...new Set(urls)];
}
