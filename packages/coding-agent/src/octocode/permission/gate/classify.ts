import type { ExtensionContext, ToolCallEvent } from "../../../core/features/index.ts";
import { isMcpToolName } from "../../../../../mcp/src/servers.ts";
import { callReason, derivedReason, hasDerivedReason } from "../../shared/reason.ts";
import { optionalString } from "../../shared/util.ts";
import { takesCallReason } from "../native-tools.ts";
import type { PermissionRequest } from "../request.ts";
import { SHELL_TOOLS, simpleCommand } from "../shell.ts";
import { canonicalPath } from "../../shared/home/repo.ts";
import { catastrophicCommand } from "../shell/destructive.ts";

/** Whether `command` is a shell command a destructive pattern matches, relative targets resolved against `cwd`: a `shell.destructive` call, ask each time. */
const destructive = (command: string, cwd: string): boolean => catastrophicCommand(command, cwd) !== undefined;

/** The call's arguments, whole: the user approves exactly what is shown. */
export const args = (input: Record<string, unknown>): string => JSON.stringify(input);

/**
 * What a native call says it is for: its `reason` argument, as the request's `purpose` (ahead of the assistant's last
 * sentence). A reason made from the call's arguments (`derivedReason`), because the model gave none, is marked
 * `reasonDerived`; a native call whose input has none still gets one, so the card never shows an empty purpose.
 */
export function reasonPurpose(event: Pick<ToolCallEvent, "toolName" | "input">): {
	purpose?: string;
	reasonDerived?: true;
} {
	if (!takesCallReason(event.toolName)) return {};
	const stated = callReason(event.input);
	if (stated === undefined) return { purpose: derivedReason(event.toolName, event.input), reasonDerived: true };
	return hasDerivedReason(event.toolName, event.input) ? { purpose: stated, reasonDerived: true } : { purpose: stated };
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
