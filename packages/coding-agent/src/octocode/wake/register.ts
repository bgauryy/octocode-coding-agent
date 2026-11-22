import type { FeatureSetup } from "../../core/features/index.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import { type WakeGate, wakeGateOf } from "./gate.ts";
import { installTicketResults } from "./ticket-results.ts";
import { installLive, type LiveHostOptions } from "./live-host.ts";
import { installShadow, type ShadowHostOptions } from "./shadow-host.ts";

/** The longest hold window the setting allows, in seconds: longer would make a report feel lost. */
const MAX_WAKE_HOLD_SECONDS = 10;

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

/** The hold window in milliseconds from the `subagents.wakeHoldSeconds` setting; unset or invalid means none. */
export function wakeHoldMs(setting: unknown): number {
	if (typeof setting !== "number" || !Number.isFinite(setting) || setting <= 0) return 0;
	return Math.min(setting, MAX_WAKE_HOLD_SECONDS) * 1000;
}

/**
 * Installs the session's wake gate (`gate.ts`): it learns which items each run wrote, draws the `⚡ woke` row
 * before a woken run's first request, and holds an idle session's wake for `subagents.wakeHoldSeconds` when that is set.
 * Wake sources send through `wakeGateOf(api)`.
 */
export function registerWake(
	api: FeatureSetup,
	loops: { shadow?: ShadowHostOptions; live?: LiveHostOptions } = {},
): WakeGate {
	const gate = wakeGateOf(api);
	gate.setHold(() =>
		wakeHoldMs(api.settings.get().subagents?.wakeHoldSeconds ?? SETTINGS_DEFAULTS.subagents.wakeHoldSeconds),
	);
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
	// Last: the shadow's shutdown handler compares what the gate just sent. Each is a no-op outside its own mode
	// (`runtime.eventLoop`: `shadow`, `new`).
	installShadow(api, gate, loops.shadow);
	installLive(api, gate, loops.live);
	installTicketResults(api, gate);
	return gate;
}
