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

/**
 * What a browser MCP call hands the browser, from every place the package (`@octocodeai/octocode-chrome-devtools`)
 * reads it: raw CDP commands (the `cdp` tool, plan and step `cdp` operations), page actions (plan and step `act`
 * operations, and the legacy `dom-operations-check` recipe's `DOM_ACTION`/`DOM_VALUE` or `DOM_STEPS` options) and
 * launcher arguments (`args`, which the package appends to any command).
 */
export function browserMcpParts(input: Record<string, unknown>): {
	cdp: BrowserMcpCdp[];
	acts: Record<string, unknown>[];
	args: string[];
} {
	const cdp: BrowserMcpCdp[] = [];
	const acts: Record<string, unknown>[] = [];
	const addCdp = (method: unknown, params: unknown) => {
		if (typeof method === "string") cdp.push({ method, params: isRecord(params) ? params : {} });
	};
	const step = (value: unknown) => {
		if (!isRecord(value)) return;
		if (value.op === "cdp") addCdp(value.method, value.params);
		else if (value.op === "act") acts.push(value);
	};
	if (isRecord(input.plan) && Array.isArray(input.plan.steps)) input.plan.steps.forEach(step);
	step(input.step);
	addCdp(input.method, input.params);
	if (isRecord(input.options)) {
		const { DOM_ACTION, DOM_VALUE, DOM_STEPS, steps } = input.options;
		if (DOM_ACTION !== undefined) acts.push({ action: DOM_ACTION, value: DOM_VALUE });
		for (const listed of [DOM_STEPS, steps]) {
			let parsed = listed;
			if (typeof listed === "string")
				try {
					parsed = JSON.parse(listed);
				} catch {
					continue; // The recipe refuses steps that are not JSON.
				}
			if (Array.isArray(parsed)) for (const each of parsed) if (isRecord(each)) acts.push(each);
		}
	}
	const args = Array.isArray(input.args) ? input.args.filter((arg): arg is string => typeof arg === "string") : [];
	return { cdp, acts, args };
}

/**
 * The addresses a browser MCP call asks Chrome to open: `open`'s `url`, a connection's `newTab`, plan and step `goto`
 * URLs, and the URL of a navigating CDP command. Pages the opened page then loads, and links a click follows, are not
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
	const steps = [...(isRecord(input.plan) && Array.isArray(input.plan.steps) ? input.plan.steps : []), input.step];
	for (const value of steps) if (isRecord(value) && value.op === "goto") add(value.url);
	for (const { method, params } of browserMcpParts(input).cdp) if (NAVIGATING_CDP.has(method)) add(params.url);
	return [...new Set(urls)];
}
