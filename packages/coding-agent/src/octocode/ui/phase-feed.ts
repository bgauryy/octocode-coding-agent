import type { FeatureSetup, FeatureContext } from "../../core/features/index.ts";
import { openBacklog } from "../backlog/context.ts";
import { promptTitle } from "../shared/locks.ts";
import { shortToolName } from "./activity-model.ts";
import { registerPhasePort } from "./phase-port.ts";
import { type PhaseOutcome, sessionPhaseOf } from "../shared/session-phase.ts";
import { firstLine } from "../shared/util.ts";

/** Ongoing items read to find this session's; the board lists the most urgent first. */
const SCAN = 50;

/** The ongoing backlog items assigned to this session (`subagents/idle-items.ts` reads them the same way). */
export function backlogOpenItems(ctx: FeatureContext): string[] {
	const backlog = openBacklog(ctx, { isSubagent: false });
	return backlog.store
		.list({ states: ["ongoing"], limit: SCAN })
		.items.filter((item) => item.assignee === backlog.session)
		.map((item) => item.ref);
}

/** How a settled run ended, in the phase's terms. */
function outcomeOf(event: { aborted: boolean; outcome?: { status: string; errorMessage?: string } }): PhaseOutcome {
	if (event.aborted || event.outcome?.status === "aborted") return { status: "aborted" };
	if (event.outcome?.status === "failed")
		return { status: "error", error: firstLine(event.outcome.errorMessage ?? "the run stopped with an error") };
	return { status: "done" };
}

const registered = new WeakSet<object>();

/**
 * Publishes the facts only the session's events know to its phase store (`sessionPhaseOf`): the run and its activity,
 * the dialogs that wait for the user, and, when a run settles, how it ended and which items it leaves open. Work and
 * wakes come from their own owners. Every reader of the phase calls this first; only the first call for an api registers,
 * so `registerUi` passes the reader of the open items (`backlogOpenItems`) and the others get none.
 * A queued message that continues a run is no settle: the run stays active.
 */
export function registerPhaseFeed(api: FeatureSetup, openItemsOf: (ctx: FeatureContext) => string[] = () => []): void {
	if (registered.has(api)) return;
	registered.add(api);
	const phase = sessionPhaseOf(api);
	/** Open dialogs by id: whether each blocks, and what it asks. */
	const dialogs = new Map<string | undefined, { blocking: boolean; title: string }>();
	const publishDialog = () => {
		// A dialog during the run waits for the user; one after it only when it blocks (a background child's approval).
		const waiting = [...dialogs.values()].filter((dialog) => dialog.blocking || phase.factsNow().run.active);
		phase.setDialog(waiting[0]?.title);
	};
	/** Top-level tool calls running now, by call id: a parallel batch is one activity until its last call ends. */
	const tools = new Map<string, string>();
	const publishActivity = () => {
		const names = [...tools.values()];
		phase.setActivity(
			names.length === 0 ? "Thinking" : names.length === 1 ? `Running ${names[0]}` : `Running ${names.length} tools`,
		);
	};
	api.bus.on("session_start", async () => {
		tools.clear();
		dialogs.clear();
		phase.reset();
	});
	// Release the job before teardown detaches its timers and wake sources. Otherwise removal can
	// announce completion and append a turn summary to the original transcript after a clone.
	api.bus.on("session_shutdown", async () => phase.reset());
	api.bus.on("agent_start", async () => {
		tools.clear();
		phase.startRun("Thinking");
		publishDialog();
	});
	api.bus.on("tool_execution_start", async (event) => {
		if (event.parentToolCallId) return;
		tools.set(event.toolCallId, shortToolName(event.toolName));
		publishActivity();
	});
	api.bus.on("tool_execution_end", async (event) => {
		if (event.parentToolCallId || !tools.delete(event.toolCallId)) return;
		publishActivity();
	});
	api.bus.on("ui_prompt_start", async (event) => {
		dialogs.set(event.id, {
			blocking: event.blocking === true,
			title: promptTitle(event) ?? "a question needs your answer",
		});
		publishDialog();
	});
	api.bus.on("ui_prompt_end", async (event) => {
		dialogs.delete(event.id);
		publishDialog();
	});
	api.bus.on("agent_settled", async (event, ctx) => {
		if (ctx.hasPendingMessages() && !event.aborted) return;
		// What the session recorded this run may have settled a queue's wake: ask the owners before the phase is derived.
		phase.refresh();
		let open: string[] = [];
		try {
			open = openItemsOf(ctx);
		} finally {
			// A backlog that cannot be read must not leave the run active for good; the error still reaches the host.
			phase.settleRun(outcomeOf(event), open);
			publishDialog();
		}
	});
	// Registered last: its session_start publishes the phase the handlers above just reset.
	registerPhasePort(api, phase);
}
