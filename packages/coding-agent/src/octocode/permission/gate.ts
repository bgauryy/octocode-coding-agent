import { isolatedMainTree, isolatedTreeRefusal } from "./isolated-tree.ts";
import { type FindProtectedBranch, landingRequest } from "./landing.ts";
import { readOnlyRole, readOnlyRoleRefusal } from "./read-only-role.ts";
import { shellParserReady } from "./shell/mutation.ts";
import { captureToolInvocation } from "../../core/tools/tool-invocation.ts";
import type { FeatureContext, ToolAnnotations, ToolCallEvent, ToolCallEventResult } from "../../core/features/index.ts";
import { optionalString } from "../shared/util.ts";
import type { Classification } from "../../utils/windows/winclassify/types.ts";
import { classifyPowerShell } from "../../utils/windows/winhelper.ts";
import type { Permission } from "./ask.ts";
import type { AskReason } from "./mode.ts";
import type { PermissionRequest, SourceGrant } from "./request.ts";
import type { AllowedSource, CheckContext } from "./provenance/ignorable.ts";
import { grantedSource, isGranted, sourceGrant } from "./provenance/grant.ts";
import { credentialAsk, credentialHit } from "./credential-store.ts";
import { args, callRequest, classify, reasonPurpose } from "./gate/classify.ts";
import { prepareReplacement, type ReplacementOwner } from "./gate/replacement.ts";
import { runPermissionSteps, type Decision, type GateVerdict, type PermissionStepBodies } from "./judge.ts";

/**
 * The permission step of the `tool_call` pipeline, after the invariants and the PreToolUse hooks. A provenance hit
 * and a hook's `ask` are reasons that tighten the call's effect: one dialog names that effect, and one yes covers the
 * call. In full no reason asks, but each is recorded with the call. A call with no effect class still asks when a
 * reason forces it. Octocode's own tools that need data only they have (the `file` review, memory scope, a web URL's or
 * browser page's host, an upload's paths, the subagent profile) call `Permission.check` from inside their `execute`
 * instead, so nothing is asked twice. The order of its steps is `PERMISSION_STEPS` in `judge.ts`; this file holds their bodies.
 */

export type { GateVerdict };

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
		check(
			event: ToolCallEvent,
			ctx: CheckContext,
			allowed?: AllowedSource,
		): { why: string; agent?: string } | undefined;
	};
	/** Whether a PowerShell command is `shell.destructive`; the Windows helper's parse by default (replaceable in tests). */
	powershell?: (command: string) => Promise<boolean>;
	/**
	 * The request for a call whose class depends on the hosts it reaches or the arguments it carries (a browser MCP
	 * navigation to a private address, an upload from outside `cwd`'s workspace), resolved before the call runs;
	 * undefined leaves the call to `classify`.
	 */
	network?: (toolName: string, input: Record<string, unknown>, cwd: string) => Promise<PermissionRequest | undefined>;
	/** The tool's annotations (`destructiveHint` makes an MCP call `mcp.destructive`); none by default. */
	annotations?: (toolName: string) => ToolAnnotations | undefined;
	/** Says whether a `bash` git call reaches the protected branch, which then asks as `worktree.merge` (`landing.ts`); unset leaves `bash` to `classify`. */
	protectedBranch?: FindProtectedBranch;
	/** The environment that says whether this is a read-only subagent (`OCTOCODE_READ_ONLY`); `process.env` by default. */
	env?: NodeJS.ProcessEnv;
	replacement?: ReplacementOwner;
	/** Where an early call's audit entries wait until the call is committed or discarded (`PermissionRequest.early`). */
	early?: { park(toolCallId: string, record: () => void): void };
}

/** What the steps of one call share: the call, and what the earlier steps worked out. */
interface Call {
	event: ToolCallEvent;
	ctx: FeatureContext;
	input: Record<string, unknown>;
	prior?: GateVerdict;
	/** The event as the model made it (before `wait` or `agent` were read as the call they stand for). */
	originalEvent: ToolCallEvent;
	/** False once the gate's call ended. */
	active: () => boolean;
	invocation: ReturnType<typeof captureToolInvocation>;
	classified?: PermissionRequest;
	request?: PermissionRequest;
	hit?: { why: string; agent?: string };
	call?: PermissionRequest;
}

const blockWith = (reason: string | undefined): Decision => ({ result: { block: true, reason } });

/** The `tool_call` gate: every call with an effect class (or a reason) reaches `Permission.check`, which applies the mode, records the call and asks when it must. A user's yes covers the call. */
export function permissionGate(options: PermissionGateOptions) {
	const { permission, provenance, powershell = powershellDestructive } = options;
	// Text from a subagent the user allowed for this session is no provenance hit; the grant is revoked with the others.
	const allowedSource = grantedSource(permission);
	// A vendor credential store the user allowed for this session asks no more than Octocode's own (`credentialAsk`).
	const granted = (grant: SourceGrant) => isGranted(permission, grant);
	const steps: PermissionStepBodies<Call> = {
		"source-projection": ({ originalEvent, invocation }) => {
			if (invocation) return;
			const source = permission.unprojectedSourceDecision(originalEvent.toolName);
			if (source?.decision !== "unsupported") return;
			permission.noted([originalEvent.toolName], source.message ?? "Cannot project source policy input", {
				allowed: false,
				via: "policy",
			});
			return blockWith(source.message);
		},
		role: async ({ event, ctx, input }) => {
			// A read-only role (`readOnly: true` profile) is refused changes in every mode, before any dialog; so is an
			// isolated child (`isolate: true`) that would change the parent's main tree.
			// The shell parse decides a read-only role's and an isolated child's refusals, and every bash call's write targets.
			if (event.toolName === "bash" || readOnlyRole(options.env) || isolatedMainTree(ctx.cwd, options.env))
				await shellParserReady();
			const roleRefusal =
				readOnlyRoleRefusal(event, ctx.cwd, options.env) ?? isolatedTreeRefusal(event, ctx.cwd, options.env);
			if (!roleRefusal) return;
			permission.refused([`${event.toolName} ${args(input)}`], roleRefusal, event.toolName);
			return blockWith(roleRefusal);
		},
		classify: async (state) => {
			const { event, ctx, input } = state;
			// PowerShell's grammar is parsed by the Windows helper (async); classify itself stays synchronous.
			const forceDestructive =
				event.toolName === "bash" &&
				input.type === "powershell" &&
				(await powershell(optionalString(input.command) ?? ""));
			const network = await options.network?.(event.toolName, input, ctx.cwd);
			state.classified = network
				? callRequest(network, event, ctx)
				: classify(event, ctx, forceDestructive, options.annotations?.(event.toolName));
		},
		landing: async (state) => {
			state.request = options.protectedBranch
				? await landingRequest(
						state.event,
						state.ctx,
						state.classified,
						options.protectedBranch,
						permission.kindGranted("worktree.merge"),
					)
				: state.classified;
		},
		provenance: (state) => {
			state.hit = provenance.check(state.event, state.ctx, allowedSource);
		},
		reasons: (state) => {
			const { event, input, hit, prior, request } = state;
			const credential = credentialAsk(credentialHit(event.toolName, input, state.ctx.cwd), granted);
			const reasons: AskReason[] = [
				...(hit ? (["provenance"] as const) : []),
				...(prior?.ask ? (["hook.ask"] as const) : []),
				...(credential?.reasons ?? []),
			];
			const reason = [hit?.why, prior?.ask, credential?.reason].filter(Boolean).join("\n");
			const grant = hit?.agent ? sourceGrant(hit.agent) : credential?.grant;
			state.call =
				reasons.length > 0
					? {
							...(request ?? {
								title: `Run ${event.toolName}?`,
								what: [`${event.toolName} ${args(input)}`],
								...reasonPurpose(event),
								toolCallId: event.toolCallId,
								...(event.parentToolCallId ? { nested: true } : {}),
							}),
							reasons,
							...(grant ? { sourceGrant: grant } : {}),
							...(reason
								? {
										reason: [request?.reason, reason].filter(Boolean).join("\n"),
									}
								: {}),
						}
					: request;
		},
		"no-effect": ({ call }) => {
			if (!call && !permission.hasSourcePolicy) return { result: undefined };
		},
		"source-policy-file": ({ call, originalEvent, invocation, ctx }) => {
			if (call || originalEvent.toolName !== "file") return;
			const source = invocation && permission.sourceDecision(invocation, ctx.cwd);
			if (source?.decision === "deny" || source?.decision === "unsupported") {
				permission.noted([originalEvent.toolName], source.message ?? "Source policy refused this call", {
					allowed: false,
					via: "policy",
				});
				return blockWith(source.message ?? "Source policy refused this call");
			}
			return { result: undefined };
		},
		check: async (state) => {
			const { event, ctx, call, invocation, originalEvent } = state;
			const checkedRequest: PermissionRequest = {
				...(call ?? {
					title: `Run ${event.toolName}?`,
					what: [event.toolName],
					...reasonPurpose(event),
					toolCallId: event.toolCallId,
				}),
				invocation,
				...(ctx.signal ? { signal: ctx.signal } : {}),
				...(originalEvent.early
					? {
							early: {
								park: (record: () => void) =>
									options.early ? options.early.park(originalEvent.toolCallId, record) : record(),
							},
						}
					: {}),
			};
			const owner = options.replacement;
			const verdict =
				owner && originalEvent.toolName === "bash" && originalEvent.origin !== "user"
					? await permission.checkWithReplacement(
							ctx,
							checkedRequest,
							prepareReplacement({
								owner,
								permission,
								provenance,
								allowedSource,
								env: options.env,
								ctx,
								originalEvent,
								prior: state.prior,
								active: state.active,
							}),
						)
					: await permission.check(ctx, checkedRequest);
			if (!verdict.allowed && verdict.via === "deferred") return { result: { defer: true } };
			return { result: verdict.allowed ? undefined : { block: true, reason: verdict.message } };
		},
	};
	return async (
		event: ToolCallEvent,
		ctx: FeatureContext,
		prior?: GateVerdict,
		originalEvent: ToolCallEvent = event,
	): Promise<ToolCallEventResult | undefined> => {
		let active = true;
		try {
			const isActive = () => active;
			return await runPermissionSteps(steps, {
				event,
				ctx,
				input: event.input,
				prior,
				originalEvent,
				active: isActive,
				invocation: captureToolInvocation(
					originalEvent.toolCallId,
					originalEvent.toolName,
					originalEvent.input,
					isActive,
				),
			});
		} finally {
			active = false;
		}
	};
}
