import type { FeatureSetup } from "../../core/features/index.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { type WakeGate, wakeGateOf } from "./gate.ts";
import { installTicketResults } from "./ticket-results.ts";
import { installLive, type LiveHostOptions } from "./live-host.ts";

/** The `backlog` operations that write an item, and the other tools' arguments that name the item they serve. */
const WRITING_OPS = new Set(["note", "done", "claim", "close", "step"]);

/** The item refs a call of `tool` writes (a note, a completion, a claim, a delegation to that item). */
export function writtenRefs(tool: string, args: unknown): string[] {
	if (!isRecord(args)) return [];
	if (tool === "backlog")
		return typeof args.id === "string" && typeof args.op === "string" && WRITING_OPS.has(args.op) ? [args.id] : [];
	if (tool === "agent" && typeof args.item === "string") return [args.item];
	return [];
}

/**
 * Installs the session's wake gate (`gate.ts`) and the event loop that delivers its wakes (`live-host.ts`): the gate
 * learns which items each run wrote and draws the `⚡ woke` row before a woken run's first request. Wake sources send
 * through `wakeGateOf(api)`.
 */
export function registerWake(api: FeatureSetup, loops: { live?: LiveHostOptions } = {}): WakeGate {
	const gate = wakeGateOf(api);
	api.bus.on("agent_start", async (_event, ctx) => {
		gate.segmentStarted(ctx.hasUI);
	});
	api.bus.on("tool_execution_start", async (event) => {
		gate.toolStarted(event.toolCallId, writtenRefs(event.toolName, event.args));
	});
	api.bus.on("tool_execution_end", async (event) => {
		gate.toolEnded(event.toolCallId, event.isError);
	});
	api.bus.on("agent_settled", async (event, ctx) => {
		gate.settled(ctx.hasPendingMessages() && !event.aborted);
	});
	api.bus.on("agent_settle_end", async () => {
		gate.settleEnded();
	});
	api.bus.on("session_shutdown", async () => {
		gate.dispose();
	});
	installLive(api, gate, loops.live);
	installTicketResults(api, gate);
	return gate;
}
