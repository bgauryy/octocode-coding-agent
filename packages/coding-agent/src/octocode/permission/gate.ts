import { validateToolArguments, type Tool } from "@octocodeai/octocode-ai";
import { rewriteClaudeBash } from "../shared/claude-bash.ts";
import { runsLater, stateFolderRefusal, shellTargetAccess } from "./file-access.ts";
import { captureToolInvocation } from "../../core/tools/tool-invocation.ts";
import path from "node:path";
import type {
	ExtensionContext,
	ToolAnnotations,
	ToolCallEvent,
	ToolCallEventResult,
} from "../../core/extensions/index.ts";
import { readableHistory, readableSessionFolder } from "../shared/history.ts";
import { canonicalPath, isWithin, resolveToolPath, sessionsRoot, workspaceRoot } from "../shared/home.ts";
import { isMcpTool } from "../shared/octocode-tools.ts";
import { optionalString } from "../shared/util.ts";
import type { Classification } from "../shared/winclassify.ts";
import { classifyPowerShell } from "../shared/winhelper.ts";
import type { Permission } from "./ask.ts";
import type { AskReason } from "./mode.ts";
import type { PermissionRequest } from "./request.ts";
import { catastrophicCommand, SHELL_TOOLS, simpleCommand } from "./shell.ts";

/**
 * The permission step of the `tool_call` pipeline, after the invariants and the PreToolUse hooks. A provenance hit
 * and a hook's `ask` are reasons that tighten the call's effect: one dialog names that effect, and one yes covers the
 * call. In full no reason asks, but each is recorded with the call. A call with no effect class still asks when a
 * reason forces it. Octocode's own tools that need data only they have (the `file` review, memory scope, a web URL's or
 * browser page's host, an upload's paths, the subagent profile) call `Permission.check` from inside their `execute`
 * instead, so nothing is asked twice.
 */

/** A gate's result: a block, or an `ask` a later gate turns into a question (PreToolUse `permissionDecision: "ask"`). */
export type GateVerdict = ToolCallEventResult & { ask?: string; rewritten?: true };

/** Octocode's tools that read a path: `read` takes `path`; `grep`, `find` and `ls` default to the working directory. */
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
/** Octocode's own file changers (active with `--tools edit,write`); Octocode's `file` tool checks itself. */
const CHANGE_TOOLS = new Set(["edit", "write"]);
/** Browser actions that act on the page; the others read the page or manage tabs. `navigate`, `tab` with a `url` and `upload` are checked by the browser tool, which knows the host and the paths. */
const BROWSER_ACTS = new Set(["click", "hover", "drag", "type", "fill", "press", "download", "dialog"]);
/** Browser actions that take control of a browser: the user's own Chrome, arbitrary script in the page. Each is a `browser.control` ask. */
const BROWSER_CONTROL = new Set(["evaluate", "attach"]);

/** Conflicting hints keep the consequential classification in both permission and provenance checks. */
export const readOnlyMcp = (hint: ToolAnnotations | undefined): boolean =>
	hint?.readOnlyHint === true && hint.destructiveHint !== true;

export { runsLater, stateFolderRefusal } from "./file-access.ts";

/** Whether `command` is a shell command a destructive pattern matches, relative targets resolved against `cwd`: a `shell.destructive` call, ask each time. */
const destructive = (command: string, cwd: string): boolean => catastrophicCommand(command, cwd) !== undefined;

/**
 * Whether a `powershell` command is `shell.destructive`: the helper flagged it, or could not parse it (no PowerShell, a
 * syntax error), which fails closed. A command it parsed cleanly and did not flag is an ordinary `shell` call.
 */
export async function powershellDestructive(
	command: string,
	classifier: (command: string) => Promise<Classification> = classifyPowerShell,
): Promise<boolean> {
	const verdict = await classifier(command);
	return !verdict.parsed || verdict.destructive !== undefined;
}

/** The paths an MCP call names: its `path` and each of its `queries[].path`. */
const mcpPaths = (input: Record<string, unknown>): string[] =>
	[input, ...(Array.isArray(input.queries) ? input.queries : [])].flatMap((query) =>
		query && typeof query === "object" && typeof (query as Record<string, unknown>).path === "string"
			? [(query as Record<string, string>).path!]
			: [],
	);
/** The call's arguments, whole: the user approves exactly what is shown. */
const args = (input: Record<string, unknown>): string => JSON.stringify(input);

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
	const request = classOf(
		event.toolName,
		event.input as Record<string, unknown>,
		ctx.cwd,
		annotations,
		forceDestructive,
	);
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

interface PermissionGateOptions {
	permission: Permission;
	/** The provenance tripwire's check (`permission/provenance`). */
	provenance: {
		check(event: ToolCallEvent, ctx: { cwd: string }): { why: string } | undefined;
	};
	annotations: (toolName: string) => ToolAnnotations | undefined;
	/** Whether a PowerShell command is `shell.destructive`; the Windows helper's parse by default (replaceable in tests). */
	powershell?: (command: string) => Promise<boolean>;
	replacement?: {
		definition: (name: string) => Tool | undefined;
		refresh: (ctx: ExtensionContext) => Promise<void>;
		reserved: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<GateVerdict | undefined>;
	};
}

/** The `tool_call` gate: every call with an effect class (or a reason) reaches `Permission.check`, which applies the mode, records the call and asks when it must. A user's yes covers the call. */
export function permissionGate(options: PermissionGateOptions) {
	const { permission, provenance, annotations, powershell = powershellDestructive } = options;
	return async (
		event: ToolCallEvent,
		ctx: ExtensionContext,
		prior?: GateVerdict,
		originalEvent: ToolCallEvent = event,
	): Promise<ToolCallEventResult | undefined> => {
		const input = event.input as Record<string, unknown>;
		let active = true;
		try {
			const capturedInvocation = captureToolInvocation(
				originalEvent.toolCallId,
				originalEvent.toolName,
				originalEvent.input,
				() => active,
			);
			if (!capturedInvocation) {
				const source = permission.unprojectedSourceDecision(originalEvent.toolName);
				if (source?.decision === "unsupported") {
					permission.noted([originalEvent.toolName], source.message ?? "Cannot project source policy input", {
						allowed: false,
						via: "policy",
					});
					return { block: true, reason: source.message };
				}
			}
			const target = CHANGE_TOOLS.has(event.toolName) ? optionalString(input.path) : undefined;
			const refused =
				target && stateFolderRefusal(resolveToolPath(ctx.cwd, target), target, `Octocode ${event.toolName}`);
			if (refused) {
				permission.refused([`${event.toolName} ${target}`], refused, event.toolName);
				return { block: true, reason: refused };
			}
			// PowerShell's grammar is parsed by the Windows helper (async); classify itself stays synchronous.
			const forceDestructive =
				(event.toolName === "powershell" || (event.toolName === "bash" && input.type === "powershell")) &&
				(await powershell(optionalString(input.command) ?? ""));
			const request = classify(event, ctx, annotations, forceDestructive);
			const hit = provenance.check(event, ctx);
			const reasons: AskReason[] = [
				...(hit ? (["provenance"] as const) : []),
				...(prior?.ask ? (["hook.ask"] as const) : []),
			];
			const reason = [hit?.why, prior?.ask].filter(Boolean).join("\n");
			const call: PermissionRequest | undefined =
				reasons.length > 0
					? {
							...(request ?? {
								title: `Run ${event.toolName}?`,
								what: [`${event.toolName} ${args(input)}`],
								toolCallId: event.toolCallId,
								...(event.parentToolCallId ? { nested: true } : {}),
							}),
							reasons,
							...(reason
								? {
										reason: [request?.reason, reason].filter(Boolean).join("\n"),
									}
								: {}),
						}
					: request;
			if (!call && !permission.hasSourcePolicy) return undefined;
			if (!call && originalEvent.toolName === "file") {
				const invocation = capturedInvocation;
				const source = invocation && permission.sourceDecision(invocation, ctx.cwd);
				if (source?.decision === "deny" || source?.decision === "unsupported") {
					permission.noted([originalEvent.toolName], source.message ?? "Source policy refused this call", {
						allowed: false,
						via: "policy",
					});
					return {
						block: true,
						reason: source.message ?? "Source policy refused this call",
					};
				}
				return undefined;
			}
			const checkedRequest: PermissionRequest = {
				...(call ?? {
					title: `Run ${event.toolName}?`,
					what: [event.toolName],
					toolCallId: event.toolCallId,
				}),
				invocation: capturedInvocation,
				...(ctx.signal ? { signal: ctx.signal } : {}),
			};
			const prepare =
				options.replacement && originalEvent.toolName === "bash" && originalEvent.toolCallId !== "user-bash"
					? async (updated: import("@octocodeai/octocode-ai").JsonObject) => {
							const owner = options.replacement!;
							if (!active || ctx.signal?.aborted) throw new Error("PermissionRequest replacement cancelled");
							const definition = owner.definition(originalEvent.toolName);
							if (!definition) throw new Error("Cannot validate replacement for unknown tool");
							const replacement = rewriteClaudeBash(originalEvent.input, updated);
							const validated = validateToolArguments(definition, {
								type: "toolCall",
								id: originalEvent.toolCallId,
								name: originalEvent.toolName,
								arguments: replacement as import("@octocodeai/octocode-ai").JsonObject,
							});
							const candidate: ToolCallEvent = {
								...originalEvent,
								input: validated,
							};
							await owner.refresh(ctx);
							if (!active || ctx.signal?.aborted) throw new Error("PermissionRequest replacement cancelled");
							const reservation = await owner.reserved(candidate, ctx);
							if (reservation?.block) throw new Error(reservation.reason ?? "Replacement target is reserved");
							const classified = classify(candidate, ctx, annotations, false);
							if (!classified) throw new Error("Cannot classify Bash replacement");
							const candidateHit = provenance.check(candidate, ctx);
							const nextInvocation = captureToolInvocation(
								candidate.toolCallId,
								candidate.toolName,
								validated,
								() => active,
							);
							if (!nextInvocation) throw new Error("Cannot capture replacement invocation");
							const request: PermissionRequest = {
								...classified,
								invocation: nextInvocation,
								signal: ctx.signal,
								...(candidateHit || prior?.ask
									? {
											reasons: [
												...(candidateHit ? ["provenance" as const] : []),
												...(prior?.ask ? ["hook.ask" as const] : []),
											],
											reason: [candidateHit?.why, prior?.ask].filter(Boolean).join("\n"),
										}
									: {}),
							};
							let committed = false;
							return {
								request,
								commit: async (
									signal: AbortSignal,
									approvedSource: import("./source-policy.ts").SourceDecision | undefined,
								) => {
									if (committed || !active || signal.aborted || ctx.signal?.aborted)
										throw new Error("PermissionRequest replacement cancelled or already committed");
									await owner.refresh(ctx);
									const finalReservation = await owner.reserved(candidate, ctx);
									if (finalReservation?.block)
										throw new Error(finalReservation.reason ?? "Replacement target is reserved");
									const source = permission.sourceDecision(nextInvocation, ctx.cwd);
									if (
										source?.decision === "deny" ||
										source?.decision === "unsupported" ||
										(source?.decision === "ask" && approvedSource?.decision !== "ask")
									)
										throw new Error(source.message ?? "Replacement refused by current source policy");
									for (const target of source?.shellTargets ?? []) {
										const access = shellTargetAccess(target, ctx.cwd);
										if (access.refusal) throw new Error(access.refusal);
									}
									if (!active || ctx.signal?.aborted) throw new Error("PermissionRequest replacement cancelled");
									if (signal.aborted) throw new Error("PermissionRequest replacement cancelled");
									for (const key of Object.keys(originalEvent.input))
										delete (originalEvent.input as Record<string, unknown>)[key];
									Object.assign(originalEvent.input, validated);
									committed = true;
								},
							};
						}
					: undefined;
			const verdict = prepare
				? await permission.checkWithReplacement(ctx, checkedRequest, prepare)
				: await permission.check(ctx, checkedRequest);
			return verdict.allowed ? undefined : { block: true, reason: verdict.message };
		} finally {
			active = false;
		}
	};
}
