import { renderPrompt } from "../core/prompt-template.ts";
import { isRetryableErrorText } from "@octocodeai/octocode-ai";
import type { FeatureSetup, FeatureContext } from "../core/features/index.ts";
import { notify } from "./shared/commands.ts";
import { interactive } from "./shared/interactive.ts";
import {
	AGENT_RESULT_TYPE,
	EXTERNAL_MESSAGE_TYPE,
	GRAPH_NOTICE_TYPE,
	INTERNAL_MESSAGE_TYPE,
	JOB_TYPE,
	TIMER_TYPE,
} from "./shared/messages.ts";
import { sessionPhaseOf } from "./shared/session-phase.ts";
import { STATUS } from "./shared/status.ts";
import { sendWakeRetry } from "./wake/senders.ts";

/** The custom message that starts another attempt; the model reads it beside the report it never acted on. */
const WAKE_RETRY_TYPE = "octocode-wake-retry";

/** Waits between attempts; past the last the session stops trying and says so. */
export const WAKE_RETRY_MS = [1, 2, 5, 10, 30].map((minutes) => minutes * 60_000);

/** Messages that start a run with nobody at the keyboard: a report or mail recorded as delivered, whatever the turn then did. */
const WAKES = new Set<string>([
	AGENT_RESULT_TYPE,
	GRAPH_NOTICE_TYPE,
	INTERNAL_MESSAGE_TYPE,
	EXTERNAL_MESSAGE_TYPE,
	JOB_TYPE,
	TIMER_TYPE,
	WAKE_RETRY_TYPE,
]);

/**
 * A run started by a report or a wake that ends in a retryable provider error has already spent what woke it: the receipt
 * is durable, the model never acted on it, and if that was the last child nothing would ever start another turn. So it
 * tries again after a growing wait, with a visible status, until any new input cancels the wait or the waits run out.
 * A retry, not a deadline. Each layer keeps its own budget (the session retry inside each attempt, this one between).
 */
export function registerWakeRetry(api: FeatureSetup, isSubagent: boolean): void {
	let wokenRun = false;
	let attempts = 0;
	let timer: NodeJS.Timeout | undefined;
	let shown: FeatureContext | undefined;

	const showStatus = (ctx: FeatureContext | undefined, text: string | undefined) => {
		try {
			if (ctx?.hasUI) ctx.ui.setStatus(STATUS.wakeRetry, text, "warning");
		} catch {
			// The session was replaced: its status went with it.
		}
		shown = text ? ctx : undefined;
	};
	/** The wait is a pending wake: the session is not done while a retry will start its next turn. */
	const publishWait = (waiting: boolean) =>
		sessionPhaseOf(api).setWakes("retry", waiting ? ["retry after provider error"] : []);
	const clearWait = () => {
		clearTimeout(timer);
		timer = undefined;
		publishWait(false);
		showStatus(shown, undefined);
	};
	const cancel = () => {
		clearWait();
		attempts = 0;
		wokenRun = false;
	};
	const schedule = (ctx: FeatureContext, error: string | undefined) => {
		const delayMs = WAKE_RETRY_MS[attempts];
		if (delayMs === undefined) {
			cancel();
			try {
				notify(
					ctx.ui,
					`The provider kept failing, so the turn that a report or message started never ran: ${error ?? "unknown error"}. Send a message to continue.`,
					"warning",
				);
			} catch {
				// The session was replaced: nobody is left to tell.
			}
			return;
		}
		attempts++;
		showStatus(ctx, `provider error: retrying in ${delayMs / 60_000}m (a message cancels)`);
		publishWait(true);
		timer = setTimeout(() => {
			timer = undefined;
			showStatus(shown, undefined);
			void Promise.resolve(
				sendWakeRetry(api, WAKE_RETRY_TYPE, renderPrompt("notices/wake-retry.md"), attempts, error),
			).catch(() => schedule(ctx, error));
			// After the send: the gate counts the wake from there, so the phase never sees a gap.
			publishWait(false);
		}, delayMs);
		timer.unref?.();
	};

	api.bus.on("before_agent_start", async (event) => {
		clearWait();
		wokenRun = event.messageType === "custom" && WAKES.has(event.message.customType);
		if (!wokenRun) attempts = 0;
		// Until this run settles, a failed one may still be retried: its end is not the end of the job, whichever handler of
		// `agent_settled` runs first.
		else publishWait(true);
		return undefined;
	});
	api.bus.on("input", async () => {
		cancel();
		return { action: "continue" as const };
	});
	api.bus.on("agent_settled", async (event, ctx) => {
		if (!wokenRun) return;
		if (!interactive(ctx, isSubagent)) {
			publishWait(false);
			return;
		}
		wokenRun = false;
		const { outcome } = event;
		if (event.aborted || outcome?.status !== "failed" || !isRetryableErrorText(outcome.errorMessage ?? "")) {
			cancel();
			return;
		}
		schedule(ctx, outcome.errorMessage);
	});
	api.bus.on("session_start", async () => cancel());
	api.bus.on("session_shutdown", async () => cancel());
}
