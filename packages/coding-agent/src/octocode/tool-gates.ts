import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "../core/extensions/index.ts";
import { agentOperation } from "./agent-tool.ts";
import type { Permission } from "./permission/ask.ts";
import { type GateVerdict, permissionGate } from "./permission/gate.ts";
import { gitStateGate } from "./permission/git-state.ts";
import type { createProvenance } from "./permission/provenance.ts";
import type { registerSourcePolicy } from "./permission/source-policy-loader.ts";
import { registerHookMcpGate } from "./hooks/mcp-gate.ts";
import { userBashGate } from "./permission/user-bash.ts";
import type { registerHooks } from "./hooks/register.ts";
import { envFlag, SUBAGENT_ENV, TEAM_WORKSPACE_ENV } from "./shared/env.ts";
import { forgetCheck, recordCheck } from "./shared/locks.ts";
import { snapshotLocalReads } from "./shared/local-reads.ts";

import type { registerCollab } from "./team/tools.ts";
import type { registerActivity } from "./ui/activity.ts";

/** What the tool-call pipeline needs from the features `index.ts` composed before it. */
export interface ToolGatesOptions {
	planning?: { gate(event: ToolCallEvent): GateVerdict | undefined };
	permission: Permission;
	provenance: ReturnType<typeof createProvenance>;
	collab: ReturnType<typeof registerCollab>;
	hooks: ReturnType<typeof registerHooks>;
	sourcePolicy: ReturnType<typeof registerSourcePolicy>;
	activity: ReturnType<typeof registerActivity>;
	/** Local-read snapshots by tool call id, for the `tool_result` handler in `index.ts`. */
	localReads: Map<string, Awaited<ReturnType<typeof snapshotLocalReads>>>;
	/** Says whether this process is a subagent in the shared tree (`permission/git-state.ts`); `process.env` by default. */
	env?: NodeJS.ProcessEnv;
}

/** Registers, in this order, the `tool_call` pipeline, its `tool_execution_end` cleanup and the `user_bash` gate. */
export function registerToolGates(
	pi: ExtensionAPI,
	{ permission, provenance, collab, hooks, sourcePolicy, activity, localReads, env, planning }: ToolGatesOptions,
): void {
	// The tool-call pipeline, cheapest and most certain first; the first block wins. Invariants (a subagent in the shared
	// tree leaves git state alone, then reservations) and user
	// hooks come first: user hooks spawn processes, so they run only for calls the reservation gate lets through; the
	// permission gate checks last (a hook's `ask` is handed to it), so the user is never asked about a call a hook would
	// deny. A refusal by an earlier gate is audited here; the permission gate audits its own. Octocode runs no call of a batch
	// before every call's checks ended, so their time is shown: live on the working line, then in the row (`timed` reads
	// `recordCheck`).
	type Gate = (event: ToolCallEvent, ctx: ExtensionContext, prior?: GateVerdict) => Promise<GateVerdict | undefined>;
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
	// Only an isolated run's parent hands its child the team workspace (`subagents/tool.ts` `Isolation`): its cwd is a private worktree.
	const scope = env ?? process.env;
	const gitState = gitStateGate({
		subagent: envFlag(scope, SUBAGENT_ENV),
		isolated: Boolean(scope[TEAM_WORKSPACE_ENV]?.trim()),
	});
	// The invariants again for a command a hook rewrote.
	const invariants: Gate = async (event, ctx) =>
		planning?.gate(event) ?? (await gitState?.(event, ctx)) ?? collab.reservationGate(event, ctx);
	const permissionStep: Gate = (event, ctx, prior) =>
		Promise.resolve(planning?.gate(event)).then(
			(refusal) =>
				refusal ??
				permissionGate({
					permission,
					provenance,
					replacement: {
						definition: (name) => pi.getAllTools().find((tool) => tool.name === name),
						refresh: (ctx) => sourcePolicy.refresh(ctx),
						reserved: invariants,
					},
				})(agentOperation(event), ctx, prior, event),
		);
	const gates: Gate[] = [
		audited(async (event) => planning?.gate(event)),
		...(gitState ? [audited(gitState)] : []),
		audited(collab.reservationGate),
		audited(hooks.preToolUse),
		(event, ctx, prior) => permissionStep(event, ctx, prior),
	];
	// An `mcp_tool` hook's call is a tool call too (`hooks/mcp-gate.ts`): it passes the permission step, which audits its own
	// refusals. The earlier gates are skipped: PreToolUse hooks would run for the hook's own call and recurse.
	// A Notification hook fires for the ask this gate raises; its own MCP call would ask and notify again without end, so a
	// call made while a hook call is being decided is refused.
	const deciding = new AsyncLocalStorage<true>();
	registerHookMcpGate(pi.events, async (call, ctx) => {
		if (deciding.getStore()) return "a hook MCP call made while another is being decided is refused";
		await sourcePolicy.refresh(ctx);
		const event: ToolCallEvent = {
			type: "tool_call",
			toolCallId: randomUUID(),
			origin: "hook",
			toolName: call.toolName,
			input: call.input,
		};
		const verdict = await deciding.run(true, () => permissionStep(event, ctx));
		return verdict?.block ? (verdict.reason ?? "blocked") : undefined;
	});
	pi.on("tool_call", async (event, ctx) => {
		const started = Date.now();
		await sourcePolicy.refresh(ctx);
		activity.checking(event.toolCallId, true);
		try {
			let prior: GateVerdict | undefined;
			for (const gate of gates) {
				const verdict = await gate(event, ctx, prior);
				if (verdict?.block) return verdict;
				if (verdict?.rewritten) {
					const reserved = await audited(invariants)(event, ctx);
					if (reserved?.block) return reserved;
				}
				if (verdict?.ask) prior = { ask: verdict.ask };
			}
			const snapshots = await snapshotLocalReads(event.toolName, event.input, ctx.cwd);
			if (snapshots.size) localReads.set(event.toolCallId, snapshots);
			return undefined;
		} finally {
			recordCheck(event.toolCallId, Date.now() - started);
			activity.checking(event.toolCallId, false);
		}
	});
	pi.on("tool_execution_end", async (event) => forgetCheck(event.toolCallId));

	// The user's own `!cmd`: the hooks and the permission check decide, as for an agent's `bash` call (`permission/user-bash`).
	pi.on("user_bash", async (event, ctx) => {
		await sourcePolicy.refresh(ctx);
		return userBashGate({
			permission,
			preToolUse: async (call, ctx) => planning?.gate(call) ?? hooks.preToolUse(call, ctx),
		})(event, ctx);
	});
}
