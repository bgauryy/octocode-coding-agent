// Tool-list selection for profiles: selector validation and matching, the lean tool list and the specialist floor.
import { parseArgs } from "../../cli/args.ts";
import {
	CORE_TOOLS,
	DEFAULT_CHILD_TOOLS,
	LEAN_FLOOR,
	localResearchTools,
	MCP_ACCESS_TOOLS,
	mcpFloor,
	SHELL_TOOLS,
} from "./core-tools.ts";

/** A lean profile's tools when its front matter names none. */
const LEAN_DEFAULT_TOOLS = "bash,agent,file";

/** A profile's comma-separated tool list. */
export const toolList = (list: string | undefined): string[] =>
	(list ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);

/** Octocode owns selector validation. Its matcher is private; only `*` is special in a tool-name pattern. */
export function selectedTools(tools: string | undefined): string[] | undefined {
	if (!tools) return undefined;
	const parsed = parseArgs(["--tools", tools]);
	const error = parsed.diagnostics.find((diagnostic) => diagnostic.type === "error");
	if (error) throw new Error(error.message);
	return parsed.tools;
}

export const matchesTool = (patterns: readonly string[], name: string): boolean =>
	patterns.some((pattern) =>
		new RegExp(
			`^${pattern
				.split("*")
				.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
				.join(".*")}$`,
		).test(name),
	);

export const isRelative = (selected: readonly string[] | undefined): boolean =>
	selected?.some((name) => /^[+-]/.test(name)) === true;

/** A lean profile's tool list: explicit names only, since a relative selector would inherit the full default set; `LEAN_FLOOR` is added. */
export function leanTools(profile: string, tools: string | undefined): string {
	const list = tools ?? LEAN_DEFAULT_TOOLS;
	if (isRelative(selectedTools(list)))
		throw new Error(
			`Profile "${profile}" is lean: give it an explicit tool list such as ${LEAN_DEFAULT_TOOLS}, without + or - entries.`,
		);
	const selected = selectedTools(list);
	return [...toolList(list), ...LEAN_FLOOR.filter((name) => !matchesTool(selected ?? [], name))].join(",");
}

/**
 * A profile with an absolute tool list gains `backlog` when its child is started for an item: the child is told to note
 * progress there, and a list that does not name the tool would leave it without. A relative list or none keeps the
 * defaults, which declare `backlog` for such a child. A lean child never holds an item (`refuseLeanItem`).
 */
export function withBacklogTool<T extends { name: string; lean?: true; tools?: string } | undefined>(profile: T): T {
	if (!profile || profile.lean) return profile;
	const list = profile.tools;
	const selected = selectedTools(list);
	if (!list || isRelative(selected) || matchesTool(selected ?? [], "backlog")) return profile;
	return { ...profile, tools: [...toolList(list), "backlog"].join(",") };
}

export const mcpRequired = (name: string): string =>
	`Profile "${name}" disables MCP, but every specialist needs Octocode local research. Remove mcp: false.`;

/**
 * An absolute allowlist replaces the selection, so add missing shared capabilities. Relative lists are completed
 * by profileTools at launch, after the parent defaults have been resolved.
 */
export function withCoreTools(tools: string, selected: readonly string[] | undefined): string {
	if (isRelative(selected)) return tools;
	// An allowlist without MCP entries implicitly keeps all MCP servers. Preserve that reach when adding local tools.
	const required = [...SHELL_TOOLS, ...CORE_TOOLS, ...DEFAULT_CHILD_TOOLS, ...MCP_ACCESS_TOOLS, ...mcpFloor(selected)];
	return [...toolList(tools), ...required.filter((name) => !matchesTool(selected ?? [], name))].join(",");
}

/** Reject selectors that remove the shared specialist capabilities. */
export function refuseCoreRemoval(
	profile: string,
	selected: readonly string[] | undefined,
	excludeTools: string | undefined,
): void {
	const excluded = toolList(excludeTools);
	const removed = (selected ?? []).filter((entry) => entry.startsWith("-")).map((entry) => entry.slice(1));
	const named = [...CORE_TOOLS, ...MCP_ACCESS_TOOLS, ...localResearchTools()].filter(
		(name) => matchesTool(excluded, name) || removed.includes(name),
	);
	if (named.length === 0) return;
	throw new Error(
		`Profile "${profile}" removes ${named.join(", ")} with excludeTools or a "-" entry in tools, but every specialist keeps file, communication, history and Octocode local research. Remove ${named.length > 1 ? "them" : "it"} from the profile's excludeTools (a pattern such as "*" counts) or tools.`,
	);
}
