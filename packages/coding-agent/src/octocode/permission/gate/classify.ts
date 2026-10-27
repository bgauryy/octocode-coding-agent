import path from "node:path";
import type { ExtensionContext, ToolCallEvent } from "../../../core/extensions/index.ts";
import { readableHistory } from "../../shared/history.ts";
import { resolveToolPath, workspaceOctocodeDir } from "../../shared/home.ts";
import { isMcpToolName } from "../../../../../mcp/src/servers.ts";
import { callReason } from "../../shared/reason.ts";
import { optionalString } from "../../shared/util.ts";
import { runsLater } from "../file-access.ts";
import { isNativeTool } from "../native-tools.ts";
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

/** Whether `command` is a shell command a destructive pattern matches, relative targets resolved against `cwd`: a `shell.destructive` call, ask each time. */
const destructive = (command: string, cwd: string): boolean => catastrophicCommand(command, cwd) !== undefined;

/** The call's arguments, whole: the user approves exactly what is shown. */
export const args = (input: Record<string, unknown>): string => JSON.stringify(input);

/** The folder grant for `file`: "changes under <dir>". */
const dirGrant = (file: string, verb: string) => {
	const dir = path.dirname(file);
	return { key: dir, label: `${verb} under ${dir}` };
};

/** What a native call says it is for: its `reason` argument, as the request's `purpose` (ahead of the assistant's last sentence). */
export function reasonPurpose(event: Pick<ToolCallEvent, "toolName" | "input">): { purpose?: string } {
	const reason = isNativeTool(event.toolName) ? callReason(event.input) : undefined;
	return reason ? { purpose: reason } : {};
}

/** `request` as this call's: its purpose, tool call, folder and nesting. */
export function callRequest(
	request: PermissionRequest,
	event: ToolCallEvent,
	ctx: Pick<ExtensionContext, "cwd">,
): PermissionRequest {
	return {
		...request,
		...(request.purpose === undefined ? reasonPurpose(event) : {}),
		toolCallId: event.toolCallId,
		cwd: ctx.cwd,
		...(event.parentToolCallId ? { nested: true } : {}),
	};
}

/** What a call is, as a permission request; undefined when no mode asks about it. */
export function classify(
	event: ToolCallEvent,
	ctx: Pick<ExtensionContext, "cwd">,
	forceDestructive = false,
): PermissionRequest | undefined {
	const request = classOf(event.toolName, event.input, ctx.cwd, forceDestructive);
	return request ? callRequest(request, event, ctx) : undefined;
}

function classOf(
	tool: string,
	input: Record<string, unknown>,
	cwd: string,
	forceDestructive: boolean,
): PermissionRequest | undefined {
	if (tool === "graphBuild")
		return {
			action: "file.workspace",
			title: "Build a workspace graph snapshot?",
			what: [args(input), `Storage: ${path.join(workspaceOctocodeDir(cwd), "graph")}`],
			grant: { key: "graphBuild", label: "derived graph snapshots in this workspace" },
		};
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
	if (isMcpToolName(tool)) {
		return {
			action: "mcp.write",
			title: "Run this MCP tool?",
			what: [tool, args(input)],
			grant: { key: tool, label: tool },
		};
	}
	return undefined;
}
