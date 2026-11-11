import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ToolAnnotations, ToolCallEvent } from "../core/features/index.ts";
import { renderInstruction } from "../core/prompt-template.ts";
import { agentOperation } from "./agent-tool.ts";
import type { Permission } from "./permission/ask.ts";
import { permissionGate } from "./permission/gate.ts";
import { classify } from "./permission/gate/classify.ts";
import { decide } from "./permission/mode.ts";
import { type Gate, type GateStepBodies, type GateVerdict, judge } from "./permission/judge.ts";
import { gitStateGate } from "./permission/git-state.ts";
import type { createProvenance } from "./permission/provenance.ts";
import type { registerSourcePolicy } from "./permission/source-policy-loader.ts";
import { registerHookMcpGate } from "./hooks/mcp-gate.ts";
import { userBashGate } from "./permission/user-bash.ts";
import type { registerHooks } from "./hooks/register.ts";
import { envFlag, SUBAGENT_ENV, TEAM_WORKSPACE_ENV } from "../../../common/src/env.ts";
import { forgetCheck, recordCheck } from "./shared/locks.ts";
import type { snapshotLocalReads } from "./shared/local-reads.ts";
import { snapshotReadCall } from "./files/read-continuations.ts";
import { untilCommand } from "./shared/until-command.ts";
import { browserMcpRequest, browserMetadataRefusal } from "./web/browser-mcp.ts";
import { protectedBranch } from "./worktrees/default-branch.ts";

import type { registerCollab } from "./team/tools.ts";
import type { registerActivity } from "./ui/activity.ts";

/** What the tool-call pipeline needs from the features `index.ts` composed before it. */
export interface ToolGatesOptions {
	/** The loop guard's step (`loop-guard.ts` through `registerRunGuards`): it refuses a call repeated past its limit. */
	loop: Gate;
	planning?: { gate(event: ToolCallEvent): GateVerdict | undefined };
	permission: Permission;
	provenance: ReturnType<typeof createProvenance>;
	collab: ReturnType<typeof registerCollab>;
	hooks: ReturnType<typeof registerHooks>;
	sourcePolicy: ReturnType<typeof registerSourcePolicy>;
	activity: ReturnType<typeof registerActivity>;
	/** Local-read snapshots by tool call id, for the `tool_result` handler in `files/read-receipts.ts`. */
	localReads: Map<string, Awaited<ReturnType<typeof snapshotLocalReads>>>;
	/** Says whether this process is a subagent in the shared tree (`permission/git-state.ts`); `process.env` by default. */
	env?: NodeJS.ProcessEnv;
	/** Whether another live session works in this checkout (`permission/git-state.ts` asks before the main session discards uncommitted work). */
	peerSessions?: () => boolean;
	/** A tool's annotations (an MCP server's `destructiveHint`); the registered tool's own by default. */
	annotations?: (toolName: string) => ToolAnnotations | undefined;
}

/**
 * A `timer` call with an until-command (its own, or a `check`'s trigger) is decided as the `bash` call that command is: git
 * state, reservations, PreToolUse hooks (as `Bash`), the mode, source rules, a read-only role, the provenance tripwire and the
 * user's answer apply when it is set (`timer/conditions/command.ts` rechecks plan mode and the role each time it runs). Any
 * other timer call has no effect class.
 */
function timerOperation<T extends { toolName: string; input: Record<string, unknown> }>(event: T): T {
	if (event.toolName !== "timer") return event;
	const command = untilCommand(event.input);
	return command ? { ...event, toolName: "bash", input: { command } } : event;
}

/**
 * Runs `gate` on the bash form of a timer call (`timerOperation`). A rewrite of that command (a hook's `updatedInput`, the
 * reservation gate's Node confinement) is refused: it would change only the bash form, never the timer's condition.
 */
const asBash =
	(gate: Gate): Gate =>
	async (event, ctx, prior) => {
		const bash = timerOperation(event);
		if (bash === event) return gate(event, ctx, prior);
		const command = bash.input.command;
		const verdict = await gate(bash, ctx, prior);
		if (verdict?.block) return verdict;
		return verdict?.rewritten || bash.input.command !== command
			? { block: true, reason: renderInstruction("notices/timer/rewrite-refused.md") }
			: verdict;
	};

/** Registers, in this order, the `tool_call` pipeline, its `tool_execution_end` cleanup and the `user_bash` gate. */
export function registerToolGates(
	api: ExtensionAPI,
	{
		loop,
		permission,
		provenance,
		collab,
		hooks,
		sourcePolicy,
		activity,
		localReads,
		env,
		planning,
		annotations,
		peerSessions,
	}: ToolGatesOptions,
): void {
	// The tool-call pipeline: `GATE_STEPS` in `permission/judge.ts` is its order (the first block wins); this function
	// supplies each step's body. A refusal by an earlier step is audited here; the permission gate audits its own. A call's
	// check time is shown live on the working line, then in the row (`timed` reads `recordCheck`).
	const audited =
		(gate: Gate): Gate =>
		async (event, ctx, prior) => {
			const verdict = await gate(event, ctx, prior);
			if (verdict?.block)
				permission.refused(
					[`${event.toolName} ${JSON.stringify(event.input)}`],
					verdict.reason ?? "blocked",
					event.toolName,
				);
			return verdict;
		};
	// A registered tool by name, and a tool's annotations (the option's, else the registered tool's own).
	const toolDefinition = (name: string) => api.getAllTools().find((tool) => tool.name === name);
	const annotationsOf = annotations ?? ((name: string) => toolDefinition(name)?.annotations);
	// Only an isolated run's parent hands its child the team workspace (`subagents/tool.ts` `Isolation`): its cwd is a private worktree.
	const scope = env ?? process.env;
	const sharedTree = gitStateGate({
		subagent: envFlag(scope, SUBAGENT_ENV),
		isolated: Boolean(scope[TEAM_WORKSPACE_ENV]?.trim()),
		peers: peerSessions,
	});
	// The invariants and hooks see a timer's until-command as the bash call it is.
	const gitState = sharedTree && asBash(sharedTree);
	const reservation = asBash(collab.reservationGate);
	// A browser MCP call that opens a cloud metadata address: an invariant in every mode, on every entry path.
	const metadata: Gate = async (event) => {
		const reason = await browserMetadataRefusal(event.toolName, event.input);
		return reason ? { block: true, reason } : undefined;
	};
	// An ask of the git-state step is no invariant: only its refusals stop a rewritten command here.
	const blocking = (verdict: GateVerdict | undefined) => (verdict?.block ? verdict : undefined);
	// The invariants again for a command a hook rewrote.
	const invariants: Gate = async (event, ctx) =>
		planning?.gate(event) ??
		blocking(await gitState?.(event, ctx)) ??
		(await reservation(event, ctx)) ??
		metadata(event, ctx);
	// An early call's audit entries, by call id: written when it ends, dropped when it is discarded.
	const parked = new Map<string, Array<() => void>>();
	const permissionStep: Gate = (event, ctx, prior) =>
		permissionGate({
			early: { park: (id, record) => void parked.set(id, [...(parked.get(id) ?? []), record]) },
			permission,
			provenance,
			network: (toolName, input, cwd) => browserMcpRequest(toolName, input, undefined, cwd),
			annotations: annotationsOf,
			protectedBranch,
			replacement: {
				definition: toolDefinition,
				refresh: (ctx) => sourcePolicy.refresh(ctx),
				reserved: invariants,
			},
		})(timerOperation(agentOperation(event)), ctx, prior, event);
	const bodies: GateStepBodies = {
		loop,
		"plan-mode": async (event) => planning?.gate(event),
		"git-state": gitState,
		reservation,
		metadata,
		"pre-tool-use": asBash(hooks.preToolUse),
		"plan-recheck": async (event) => planning?.gate(event),
		permission: permissionStep,
	};
	const judgeOptions = { audited, invariants };
	// An `mcp_tool` hook's call is a tool call too (`hooks/mcp-gate.ts`): it passes the metadata invariant and the permission
	// step, which audits its own refusals. The other gates are skipped: PreToolUse hooks would run for the hook's own call and recurse.
	// A Notification hook fires for the ask this gate raises; its own MCP call would ask and notify again without end, so a
	// call made while a hook call is being decided is refused.
	const deciding = new AsyncLocalStorage<true>();
	registerHookMcpGate(api.events, async (call, ctx) => {
		if (deciding.getStore()) return "a hook MCP call made while another is being decided is refused";
		await sourcePolicy.refresh(ctx);
		const event: ToolCallEvent = {
			type: "tool_call",
			toolCallId: randomUUID(),
			origin: "hook",
			toolName: call.toolName,
			input: call.input,
		};
		// Only the decision of the call itself is marked as made inside a hook's call.
		const inside =
			(gate: Gate): Gate =>
			(event, ctx, prior) =>
				deciding.run(true, () => gate(event, ctx, prior));
		const verdict = await judge(
			"hook",
			{ ...bodies, "plan-recheck": inside(bodies["plan-recheck"]), permission: inside(bodies.permission) },
			event,
			ctx,
			judgeOptions,
		);
		return verdict?.block ? (verdict.reason ?? "blocked") : undefined;
	});
	api.on("tool_call", async (event, ctx) => {
		const started = Date.now();
		await sourcePolicy.refresh(ctx);
		activity.checking(event.toolCallId, true);
		let deferred = false;
		try {
			const refused = await judge("tool", bodies, event, ctx, judgeOptions);
			deferred = refused?.defer === true;
			if (refused) return refused;
			const snapshots = await snapshotReadCall(localReads, event.toolName, event.input, ctx.cwd);
			if (snapshots.size) localReads.set(event.toolCallId, snapshots);
			// An earlier call of the batch may change a file before this read runs (the `file` tool runs alone, in order): the
			// snapshot is retaken when the call starts executing, so the receipt credits the content the read returns.
			const retake: Gate | undefined = snapshots.size
				? async () => {
						const fresh = await snapshotReadCall(localReads, event.toolName, event.input, ctx.cwd);
						if (fresh.size) localReads.set(event.toolCallId, fresh);
						else localReads.delete(event.toolCallId);
						return undefined;
					}
				: undefined;
			// A shell call's targets (a timer's until-command included) are only checked above; the `file` tool checks its own at write time. Between this
			// point and the run, a batch's later approvals, a dialog or a peer's lock can change what the checks saw.
			return event.toolName === "bash" || event.toolName === "powershell" || timerOperation(event) !== event
				? { revalidate: () => audited(invariants)(event, ctx) }
				: retake
					? { revalidate: () => retake(event, ctx) }
					: undefined;
		} finally {
			// A deferred early attempt is judged again later: no timing belongs to it.
			if (!deferred) recordCheck(event.toolCallId, Date.now() - started);
			activity.checking(event.toolCallId, false);
		}
	});
	api.on("tool_execution_end", async (event) => {
		forgetCheck(event.toolCallId);
		// The early call was committed (its message ended and the batch ran it): its audit entries are written now.
		for (const record of parked.get(event.toolCallId) ?? []) record();
		parked.delete(event.toolCallId);
	});

	// Early start (`toolExecution.earlyStart`): only a call that changes nothing (a tool declaring `readOnlyHint`, or an MCP tool
	// whose trusted entry gives it the `readOnly` role, which is how a read is classed `mcp.read`: the client drops a server's
	// own `readOnlyHint`) and that the current mode allows without asking, so no dialog opens while the reply streams and a
	// discarded call changed nothing. Plan mode keeps its own verdict. A call a PreToolUse hook matches waits for its message
	// to end: the hook then runs once, and never for a call that is discarded.
	api.on("tool_call_early_start", (call, ctx) => {
		const event = { type: "tool_call" as const, ...call } as ToolCallEvent;
		if (planning?.gate(event)) return false;
		if (hooks.hasPreToolUse(call.toolName, call.input, ctx.cwd)) return false;
		const toolAnnotations = annotationsOf(call.toolName);
		const request = classify(event, { cwd: ctx.cwd }, false, toolAnnotations);
		// Anything else may change state or open a dialog the gate never sees (`ask`): the call may not start.
		const { action, also, reasons } = request ?? {};
		if (also?.length || reasons?.length) return false;
		if (request === undefined) return toolAnnotations?.readOnlyHint === true;
		if (action !== "mcp.read" && !(action === "read.outside" && toolAnnotations?.readOnlyHint === true)) return false;
		return decide(permission.mode, action) === "allow";
	});
	// A discarded early call never runs: drop what its checks recorded, so no receipt or timing is credited to it.
	api.on("tool_call_discarded", ({ toolCallId }) => {
		parked.delete(toolCallId);
		localReads.delete(toolCallId);
		forgetCheck(toolCallId);
	});

	// The user's own `!cmd`: the hooks and the permission check decide, as for an agent's `bash` call (`permission/user-bash`).
	api.on("user_bash", async (event, ctx) => {
		await sourcePolicy.refresh(ctx);
		return userBashGate({
			permission,
			preToolUse: async (call, ctx) => planning?.gate(call) ?? hooks.preToolUse(call, ctx),
		})(event, ctx);
	});
}
