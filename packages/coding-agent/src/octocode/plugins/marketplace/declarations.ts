import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { inspectPluginHooks } from "../../../core/plugin-hooks.ts";
import { inspectPluginMcp } from "../../../core/plugin-mcp.ts";

/** The executable parts a plugin declares: what installing or enabling it approves. Reading runs nothing. */
export interface Declarations {
	/** One line per hook: `Event [matcher]: command`. */
	hooks: string[];
	/** One line per MCP server: `name: command args` or `name: url`. */
	mcp: string[];
	/** Why a part could not be read; such a part does not load. */
	errors: string[];
}

function hookLines(value: Record<string, unknown>): string[] {
	const events = isRecord(value.hooks) ? value.hooks : {};
	return Object.entries(events).flatMap(([event, groups]) =>
		(Array.isArray(groups) ? groups : []).flatMap((group: unknown) => {
			const matcher =
				isRecord(group) && typeof group.matcher === "string" && group.matcher ? ` [${group.matcher}]` : "";
			const hooks = isRecord(group) && Array.isArray(group.hooks) ? group.hooks : [];
			return hooks.map((hook: unknown) => {
				const fields = isRecord(hook) ? hook : {};
				const what = [fields.command, fields.url, fields.prompt].find((item) => typeof item === "string");
				return `${event}${matcher}: ${typeof what === "string" ? what : JSON.stringify(hook)}`;
			});
		}),
	);
}

function serverLine(name: string, config: unknown): string {
	const fields = isRecord(config) ? config : {};
	if (typeof fields.url === "string") return `${name}: ${fields.url}`;
	const args = Array.isArray(fields.args) ? fields.args.map(String) : [];
	return `${name}: ${[fields.command, ...args]
		.filter((item) => item !== undefined)
		.map(String)
		.join(" ")}`;
}

/** Hook and MCP declarations of the plugin directory `root`, as `/plugins` and the hook loader read them. */
export function readDeclarations(root: string): Declarations {
	const entry = { path: root, protocol: "claude" as const };
	const hooks = inspectPluginHooks(entry);
	const mcp = inspectPluginMcp(entry);
	return {
		hooks: hooks.definitions.flatMap((definition) => hookLines(definition.value)).sort(),
		mcp: mcp.servers.map((server) => serverLine(server.name, server.config)).sort(),
		errors: [...new Set([...hooks.errors, ...mcp.errors])],
	};
}

/** What an update adds or removes. Empty when the declarations are the same. */
export function declarationChanges(before: Declarations, after: Declarations): string[] {
	const diff = (kind: string, old: string[], next: string[]) => [
		...next.filter((line) => !old.includes(line)).map((line) => `+ ${kind} ${line}`),
		...old.filter((line) => !next.includes(line)).map((line) => `- ${kind} ${line}`),
	];
	return [...diff("hook", before.hooks, after.hooks), ...diff("MCP", before.mcp, after.mcp)];
}

/** The review text shown before an install: every hook command and MCP server. */
export function describeDeclarations(declarations: Declarations): string[] {
	return [...declarations.hooks.map((line) => `hook ${line}`), ...declarations.mcp.map((line) => `MCP ${line}`)];
}
