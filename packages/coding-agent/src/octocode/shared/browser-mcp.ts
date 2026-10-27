import { BROWSER_SERVER } from "../../../../mcp/src/presets/browser/names.ts";
import { mcpNamespace } from "../../../../mcp/src/servers.ts";
import { isRecord } from "../../utils/guards.ts";

const PREFIX = `${mcpNamespace(BROWSER_SERVER)}__`;

/** The browser MCP server's tool name in `name` (`mcp__browser__run` → `run`), or undefined for any other tool. */
export const browserMcpTool = (name: string): string | undefined =>
	name.startsWith(PREFIX) ? name.slice(PREFIX.length) : undefined;

/** CDP methods whose `params.url` opens a page. */
const NAVIGATING_CDP = new Set(["Page.navigate", "Target.createTarget"]);

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
	const cdp = (method: unknown, params: unknown) => {
		if (typeof method === "string" && NAVIGATING_CDP.has(method) && isRecord(params)) add(params.url);
	};
	const step = (value: unknown) => {
		if (!isRecord(value)) return;
		if (value.op === "goto") add(value.url);
		if (value.op === "cdp") cdp(value.method, value.params);
	};
	add(input.url);
	if (isRecord(input.connection)) add(input.connection.newTab);
	if (isRecord(input.plan) && Array.isArray(input.plan.steps)) input.plan.steps.forEach(step);
	step(input.step);
	cdp(input.method, input.params);
	return [...new Set(urls)];
}
