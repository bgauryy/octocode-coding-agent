import path from "node:path";
import type { ExtensionContext, ToolAnnotations, ToolCallEvent } from "../../../core/extensions/index.ts";
import { readableHistory, readableSessionFolder } from "../../shared/history.ts";
import { resolveToolPath, sessionsRoot } from "../../shared/home.ts";
import { isMcpTool } from "../../shared/octocode-tools.ts";
import { optionalString } from "../../shared/util.ts";
import { runsLater } from "../file-access.ts";
import type { PermissionRequest } from "../request.ts";
import { SHELL_TOOLS, simpleCommand } from "../shell.ts";
import { canonicalPath, isWithin, workspaceRoot } from "../../shared/home/repo.ts";
import { catastrophicCommand } from "../shell/destructive.ts";

/** Tools named like the removed core readers (Octocode ships none now) that a custom tool or SDK caller may still register: `read` takes `path`; `grep`, `find` and `ls` default to the working directory. They stay classified so a same-named tool cannot read outside the workspace unasked. */
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
/** Same-named custom file changers (Octocode ships no `edit` or `write`); Octocode's `file` tool checks itself. */
export const CHANGE_TOOLS = new Set(["edit", "write"]);
/** Browser actions that act on the page; the others read the page or manage tabs. `navigate`, `tab` with a `url` and `upload` are checked by the browser tool, which knows the host and the paths. */
const BROWSER_ACTS = new Set(["click", "hover", "drag", "type", "fill", "press", "download", "dialog"]);
/** Browser actions that take control of a browser: the user's own Chrome, arbitrary script in the page. Each is a `browser.control` ask. */
const BROWSER_CONTROL = new Set(["evaluate", "attach"]);

/** Conflicting hints keep the consequential classification in both permission and provenance checks. */
export const readOnlyMcp = (hint: ToolAnnotations | undefined): boolean =>
	hint?.readOnlyHint === true && hint.destructiveHint !== true;

/** Whether `command` is a shell command a destructive pattern matches, relative targets resolved against `cwd`: a `shell.destructive` call, ask each time. */
const destructive = (command: string, cwd: string): boolean => catastrophicCommand(command, cwd) !== undefined;

/** The paths an MCP call names: its `path` and each of its `queries[].path`. */
const mcpPaths = (input: Record<string, unknown>): string[] =>
	[input, ...(Array.isArray(input.queries) ? input.queries : [])].flatMap((query) =>
		query && typeof query === "object" && typeof (query as Record<string, unknown>).path === "string"
			? [(query as Record<string, string>).path]
			: [],
	);
/** The call's arguments, whole: the user approves exactly what is shown. */
export const args = (input: Record<string, unknown>): string => JSON.stringify(input);

/** The folder grant for `file`: "changes under <dir>". */
const dirGrant = (file: string, verb: string) => {
	const dir = path.dirname(file);
	return { key: dir, label: `${verb} under ${dir}` };
};

/** What a call is, as a permission request; undefined when no mode asks about it. */
export function classify(
	event: ToolCallEvent,
	ctx: Pick<ExtensionContext, "cwd">,
	annotations: (toolName: string) => ToolAnnotations | undefined,
	forceDestructive = false,
): PermissionRequest | undefined {
	const request = classOf(event.toolName, event.input, ctx.cwd, annotations, forceDestructive);
	return request
		? { ...request, toolCallId: event.toolCallId, cwd: ctx.cwd, ...(event.parentToolCallId ? { nested: true } : {}) }
		: undefined;
}

function classOf(
	tool: string,
	input: Record<string, unknown>,
	cwd: string,
	annotations: (toolName: string) => ToolAnnotations | undefined,
	forceDestructive: boolean,
): PermissionRequest | undefined {
	const inRepo = (raw: string) => {
		const file = canonicalPath(resolveToolPath(cwd, raw));
		const root = workspaceRoot(cwd);
		return { file, root, inside: root !== undefined && isWithin(file, root) };
	};
	// Inspection can execute adapter getters; all debugger operations share process authorization.
	if (tool === "debug")
		return input.action === "terminate"
			? undefined
			: { action: "shell", title: "Run this debugger operation?", what: [args(input), `cwd: ${cwd}`] };
	if (SHELL_TOOLS.has(tool)) {
		const command = optionalString(input.command) ?? "";
		const simple = simpleCommand(command);
		if (forceDestructive || destructive(command, cwd))
			return { action: "shell.destructive", title: "Run this destructive command?", what: [command, `cwd: ${cwd}`] };
		const grant = simple
			? {
					key: JSON.stringify([tool, input.type ?? "bash", canonicalPath(cwd), simple]),
					label: `\`${simple}\` with ${tool} in ${cwd}`,
				}
			: undefined;
		return {
			action: "shell",
			title: "Run this command?",
			what: [command, `cwd: ${cwd}`],
			...(grant ? { grant } : {}),
		};
	}
	if (CHANGE_TOOLS.has(tool) && optionalString(input.path)) {
		const { file, root, inside } = inRepo(optionalString(input.path)!);
		if (inside && runsLater(file, root!)) {
			return {
				action: "file.outside",
				title: "Change a file that runs in later sessions?",
				what: [`${tool} ${file}`],
				reason: "it loads code, hooks or instructions in later sessions",
				grant: dirGrant(file, "file changes"),
			};
		}
		return inside
			? {
					action: "file.workspace",
					title: "Change this file?",
					what: [`${tool} ${file}`],
					grant: dirGrant(file, "file changes"),
				}
			: {
					action: "file.outside",
					title: "Change a file outside the workspace?",
					what: [`${tool} ${file}`],
					grant: dirGrant(file, "file changes"),
				};
	}
	if (READ_TOOLS.has(tool)) {
		const { file, inside } = inRepo(optionalString(input.path) ?? cwd);
		// History the session may read (its own, its forks' sources, its parent's, its repository's) is read like the workspace (`shared/history.ts`).
		if (inside || readableHistory(file, cwd)) return undefined;
		return {
			action: "read.outside",
			title: "Read outside the workspace?",
			what: [`${tool} ${file}`],
			grant: dirGrant(file, "reads"),
		};
	}
	if (tool === "web") {
		// A URL is checked by the web tool, which resolves its host: public is `web`, private is `net.private`.
		if (optionalString(input.url)) return undefined;
		return {
			action: "web",
			title: "Search the web?",
			what: [optionalString(input.query) ?? ""],
			grant: { key: "search", label: "web searches" },
		};
	}
	if (tool === "browser") {
		const action = optionalString(input.action) ?? "";
		if (BROWSER_CONTROL.has(action))
			return {
				action: "browser.control",
				title: action === "attach" ? "Attach to a browser?" : "Run script in the page?",
				what: [`${action} ${args(input)}`],
			};
		if (!BROWSER_ACTS.has(action)) return undefined;
		// A page action is granted per kind: the gate cannot see the page's host.
		return {
			action: "browser",
			title: "Act on the page?",
			what: [`${action} ${args(input)}`],
			grant: { key: `page ${action}`, label: `browser ${action} on any page` },
		};
	}
	if (isMcpTool(tool)) {
		const hint = annotations(tool);
		if (readOnlyMcp(hint)) {
			// Octocode MCP may read the Octocode home; a session folder there that is not this session's or its repository's
			// (another repository's, or all of them) asks like Octocode's read.
			const foreign = mcpPaths(input)
				.map((raw) => canonicalPath(resolveToolPath(cwd, raw)))
				.find((file) => isWithin(file, canonicalPath(sessionsRoot())) && !readableSessionFolder(file, cwd));
			return foreign
				? {
						action: "read.outside",
						title: "Read another repository's session history?",
						what: [tool, args(input)],
						grant: dirGrant(foreign, "reads"),
					}
				: undefined;
		}
		// Only an explicit `destructiveHint: true` is destructive (asks each time, in workspace too). MCP's own default calls an
		// unannotated tool destructive; treating it so would ask on every call with no session grant (FEATURES: known limits).
		const marked = hint?.destructiveHint === true;
		return {
			action: marked ? "mcp.destructive" : "mcp.write",
			title: marked ? "Run this destructive MCP tool?" : "Run this MCP tool?",
			what: [tool, args(input)],
			grant: { key: tool, label: tool },
		};
	}
	return undefined;
}
