import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { beginRun, resetRun, settleRun } from "../../utils/run-clock.ts";
import { dialogsWaiting, onDialogsChange, promptTitle } from "../shared/locks.ts";
import { setRowsAnimate } from "./chrome.ts";
import { isStaleSessionError } from "../shared/util.ts";
import { Activity } from "./activity-model.ts";

/**
 * Feed `Activity` from Octocode's events. `onChange` hears the line without elapsed time whenever it changes (the team panel
 * shows it to the parent and teammates). The TUI shows the activity detail; its working indicator counts the run's
 * elapsed time from the clock started here. Settlement clears the display.
 */
interface ActivityControl {
	activity: Activity;
	/** The gate pipeline (src/index.ts) reports a call's `tool_call` checks starting and ending. */
	checking(id: string, active: boolean): void;
	/** A call the permission check let through (`onAction` of the permission state). */
	consequential(action: string, what: string, warn: boolean): void;
}

/** Whether `ctx` still belongs to a live session: its getters throw once the runner is invalidated. */
function isLive(ctx: ExtensionContext): boolean {
	try {
		void ctx.hasUI;
		return true;
	} catch (error) {
		if (isStaleSessionError(error)) return false;
		throw error;
	}
}

export function registerActivity(
	api: ExtensionAPI,
	options: { onChange?: (line: string | undefined) => void; workingLine: boolean },
): ActivityControl {
	const activity = new Activity();
	let ctx: ExtensionContext | undefined;
	let shown: string | undefined;
	let reported: string | undefined;
	/** Repaints when interactions queue behind an open dialog; held per session. */
	let unsubscribe: (() => void) | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	const clearHeartbeat = () => {
		clearInterval(heartbeat);
		heartbeat = undefined;
	};

	const paint = () => {
		// The queue is process-wide: a session disposed without `session_shutdown` leaves this listener with a stale ctx.
		if (ctx && !isLive(ctx)) {
			clearHeartbeat();
			unsubscribe?.();
			[unsubscribe, ctx] = [undefined, undefined];
			return;
		}
		const line = activity.describe(dialogsWaiting());
		if (line !== reported) {
			reported = line;
			options.onChange?.(line);
		}
		// Only the TUI draws a working line (its indicator counts the run's time itself): RPC's setWorkingMessage is a no-op.
		if (!options.workingLine || !ctx?.hasUI || ctx.mode !== "tui") return;
		let working = activity.ticking() ? activity.working(dialogsWaiting()) : undefined;
		const silence = activity.modelSilenceMs(Date.now());
		if (working && silence !== undefined && silence >= 30_000)
			working += ` · no model event for ${Math.floor(silence / 1000)}s`;
		setRowsAnimate(ctx, activity.toolsRunning());
		if (working !== shown) {
			shown = working;
			try {
				ctx.ui.setWorkingMessage(working);
			} catch {
				// The session was replaced.
			}
		}
	};
	const stop = () => {
		clearHeartbeat();
		activity.end();
		paint();
	};

	api.on("session_start", async (_event, next) => {
		ctx = next;
		shown = undefined;
		unsubscribe?.();
		unsubscribe = onDialogsChange(paint);
		if (options.workingLine) resetRun();
		stop();
	});
	api.on("session_shutdown", async () => {
		unsubscribe?.();
		unsubscribe = undefined;
		if (options.workingLine) resetRun();
		stop();
		ctx = undefined;
	});
	api.on("agent_start", async (_event, next) => {
		ctx = next;

		const now = Date.now();
		activity.start(now);
		clearHeartbeat();
		if (options.workingLine && next.hasUI && next.mode === "tui") {
			heartbeat = setInterval(paint, 1000);
			heartbeat.unref();
		}
		if (options.workingLine) beginRun(now);
		paint();
	});
	api.on("message_update", async (event) => {
		if (event.message.role !== "assistant" || !activity.ticking()) return;
		const update = event.assistantMessageEvent;
		if (activity.stream(update.type, Date.now(), update.type === "thinking_delta" ? update.delta : undefined)) paint();
	});
	api.on("message_end", async (event) => {
		if (!activity.ticking()) return;
		if (event.message.role === "assistant") activity.messageDone(Date.now());
		paint();
	});
	api.on("tool_execution_start", async (event) => {
		if (event.parentToolCallId) return;
		activity.toolStart(event.toolCallId, event.toolName, event.args, Date.now());
		paint();
	});
	api.on("tool_execution_end", async (event) => {
		if (event.parentToolCallId) return;
		activity.toolEnd(event.toolCallId, Date.now());
		paint();
	});
	// A dialog over another (an input after "type my own") is one wait, not two.
	api.on("ui_prompt_start", async (event) => {
		if (event.nested) return;
		activity.promptStart(promptTitle(event), Date.now());
		paint();
	});
	api.on("ui_prompt_end", async (event) => {
		if (event.nested) return;
		activity.promptEnd();
		paint();
	});
	api.on("agent_settled", async (event, next) => {
		// A queued message continues the run: the working line resumes on the same clock.
		if (options.workingLine) settleRun(Date.now(), next.hasPendingMessages() && !event.aborted);
		stop();
	});
	return {
		activity,
		consequential: (action, what, warn) => {
			activity.consequential(action, what, warn, Date.now());
			paint();
		},
		checking: (id, active) => {
			activity.checking(id, active, Date.now());
			paint();
		},
	};
}
