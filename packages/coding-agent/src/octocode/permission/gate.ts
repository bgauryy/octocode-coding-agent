import { type JsonObject, validateToolArguments, type Tool } from "@octocodeai/octocode-ai";
import { rewriteClaudeBash } from "../shared/claude-bash.ts";
import { stateFolderRefusal, shellTargetAccess } from "./file-access.ts";
import { isolatedMainTree, isolatedTreeRefusal } from "./isolated-tree.ts";
import { readOnlyRole, readOnlyRoleRefusal } from "./read-only-role.ts";
import { shellParserReady } from "./shell/mutation.ts";
import { captureToolInvocation } from "../../core/tools/tool-invocation.ts";
import type {
	ExtensionContext,
	ToolAnnotations,
	ToolCallEvent,
	ToolCallEventResult,
} from "../../core/extensions/index.ts";
import { resolveToolPath } from "../shared/home.ts";
import { optionalString } from "../shared/util.ts";
import type { Classification } from "../shared/winclassify.ts";
import { classifyPowerShell } from "../shared/winhelper.ts";
import type { Permission } from "./ask.ts";
import type { AskReason } from "./mode.ts";
import type { PermissionRequest } from "./request.ts";
import type { SourceDecision } from "./source-policy.ts";
import { args, CHANGE_TOOLS, classify } from "./gate/classify.ts";

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

export { classify, readOnlyMcp } from "./gate/classify.ts";

export { runsLater, stateFolderRefusal } from "./file-access.ts";

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

interface PermissionGateOptions {
	permission: Permission;
	/** The provenance tripwire's check (`permission/provenance`). */
	provenance: {
		check(event: ToolCallEvent, ctx: { cwd: string }): { why: string } | undefined;
	};
	annotations: (toolName: string) => ToolAnnotations | undefined;
	/** Whether a PowerShell command is `shell.destructive`; the Windows helper's parse by default (replaceable in tests). */
	powershell?: (command: string) => Promise<boolean>;
	/** The environment that says whether this is a read-only subagent (`OCTOCODE_READ_ONLY`); `process.env` by default. */
	env?: NodeJS.ProcessEnv;
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
			// A read-only role (`readOnly: true` profile) is refused changes in every mode, before any dialog; so is an
			// isolated child (`isolate: true`) that would change the parent's main tree.
			if (readOnlyRole(options.env) || isolatedMainTree(ctx.cwd, options.env)) await shellParserReady();
			const roleRefusal =
				readOnlyRoleRefusal(event, ctx.cwd, options.env) ?? isolatedTreeRefusal(event, ctx.cwd, options.env);
			if (roleRefusal) {
				permission.refused([`${event.toolName} ${args(input)}`], roleRefusal, event.toolName);
				return { block: true, reason: roleRefusal };
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
					? async (updated: JsonObject) => {
							const owner = options.replacement!;
							if (!active || ctx.signal?.aborted) throw new Error("PermissionRequest replacement cancelled");
							const definition = owner.definition(originalEvent.toolName);
							if (!definition) throw new Error("Cannot validate replacement for unknown tool");
							const replacement = rewriteClaudeBash(originalEvent.input, updated);
							const validated = validateToolArguments(definition, {
								type: "toolCall",
								id: originalEvent.toolCallId,
								name: originalEvent.toolName,
								arguments: replacement as JsonObject,
							});
							const candidate: ToolCallEvent = {
								...originalEvent,
								input: validated,
							};
							await owner.refresh(ctx);
							if (!active || ctx.signal?.aborted) throw new Error("PermissionRequest replacement cancelled");
							const reservation = await owner.reserved(candidate, ctx);
							if (reservation?.block) throw new Error(reservation.reason ?? "Replacement target is reserved");
							const roleRefused =
								readOnlyRoleRefusal(candidate, ctx.cwd, options.env) ??
								isolatedTreeRefusal(candidate, ctx.cwd, options.env);
							if (roleRefused) throw new Error(roleRefused);
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
								commit: async (signal: AbortSignal, approvedSource: SourceDecision | undefined) => {
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
