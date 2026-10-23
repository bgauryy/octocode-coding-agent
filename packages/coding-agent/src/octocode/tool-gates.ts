import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "../core/extensions/index.ts";
import { agentOperation } from "./agent-tool.ts";
import type { Permission } from "./permission/ask.ts";
import { type GateVerdict, permissionGate } from "./permission/gate.ts";
import type { createProvenance } from "./permission/provenance.ts";
import type { registerSourcePolicy } from "./permission/source-policy-loader.ts";
import { userBashGate } from "./permission/user-bash.ts";
import type { registerHooks } from "./hooks/register.ts";
import { forgetCheck, recordCheck } from "./shared/locks.ts";
import { snapshotLocalReads } from "./shared/local-reads.ts";
import type { registerCollab } from "./team/tools.ts";
import type { registerActivity } from "./ui/activity.ts";

/** What the tool-call pipeline needs from the features `index.ts` composed before it. */
export interface ToolGatesOptions {
	permission: Permission;
	provenance: ReturnType<typeof createProvenance>;
	annotations: (name: string) => ReturnType<ExtensionAPI["getAllTools"]>[number]["annotations"];
	collab: ReturnType<typeof registerCollab>;
	hooks: ReturnType<typeof registerHooks>;
	sourcePolicy: ReturnType<typeof registerSourcePolicy>;
	activity: ReturnType<typeof registerActivity>;
	/** Local-read snapshots by tool call id, for the `tool_result` handler in `index.ts`. */
	localReads: Map<string, Awaited<ReturnType<typeof snapshotLocalReads>>>;
}

/** Registers, in this order, the `tool_call` pipeline, its `tool_execution_end` cleanup and the `user_bash` gate. */
export function registerToolGates(
	pi: ExtensionAPI,
	{ permission, provenance, annotations, collab, hooks, sourcePolicy, activity, localReads }: ToolGatesOptions,
): void {
	// The tool-call pipeline, cheapest and most certain first; the first block wins. Invariants (reservations) and user
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
	const gates: Gate[] = [
		audited(collab.reservationGate),
		audited(hooks.preToolUse),
		(event, ctx, prior) =>
			permissionGate({
				permission,
				provenance,
				annotations,
				replacement: {
					definition: (name) => pi.getAllTools().find((tool) => tool.name === name),
					refresh: (ctx) => sourcePolicy.refresh(ctx),
					reserved: collab.reservationGate,
				},
			})(agentOperation(event), ctx, prior, event),
	];
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
					const reserved = await audited(collab.reservationGate)(event, ctx);
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
		return userBashGate({ permission, preToolUse: hooks.preToolUse })(event, ctx);
	});
}
