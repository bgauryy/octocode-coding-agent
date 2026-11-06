import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { sharedAgentDb } from "../../config/database.ts";
import { registeredWorkspace } from "../../config/workspace-database.ts";
import type { TimerRow } from "../../../../db/src/api.ts";
import { say } from "../shared/commands.ts";
import { TIMER_TYPE } from "../shared/messages.ts";
import { STATUS } from "../shared/status.ts";
import { contentText } from "../shared/util.ts";
import { conditionChecker } from "./condition.ts";
import { wakeDetails, wakeText } from "./model.ts";
import { renderTimerMessage } from "./render.ts";
import { TimerScheduler } from "./scheduler.ts";
import { timerTool } from "./tool.ts";

export interface TimerOptions {
	/** Why another agent's reservation keeps `absolute` from being changed, or undefined (`Team.reservation`). */
	reservation(absolute: string, display: string): string | undefined;
	/** This agent's team id, recorded on the timers it sets. */
	agent(): string | undefined;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
}

/**
 * The `timer` tool and its scheduler: each session loads its own active timers from the agent database at start, fires
 * them while it runs (a wake is a steer message: a busy session reads it at its next step, an idle one starts a turn; retried by `wake-retry.ts` like a job report),
 * and leaves them active at shutdown for a resumed session. `settle()` lets a headless run's hold wait for the next wake
 * of a timer this run set; timers from an earlier run never hold an exit.
 */
export function registerTimers(api: ExtensionAPI, options: TimerOptions): { settle(): Promise<unknown> } {
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now;
	const db = () => sharedAgentDb(env);
	let current: ExtensionContext | undefined;
	let scheduler: TimerScheduler | undefined;
	const check = conditionChecker({ reservation: options.reservation, context: () => current });
	const warn = (ctx: ExtensionContext | undefined, text: string) => {
		try {
			if (ctx) say(ctx, text, "warning");
		} catch {
			// The session was replaced.
		}
	};
	const wake = (row: TimerRow) => {
		const context = current;
		const failed = (error: unknown) =>
			warn(context, `Timer ${row.id} could not wake this session: ${errorMessage(error)}`);
		try {
			const sending = api.sendMessage(
				{ customType: TIMER_TYPE, content: wakeText(row), display: true, details: wakeDetails(row) },
				{ triggerTurn: true, deliverAs: "steer" },
			);
			if (sending && typeof sending.then === "function") void Promise.resolve(sending).catch(failed);
		} catch (error) {
			failed(error);
		}
	};
	const showCount = (active: number) => {
		try {
			current?.ui.setStatus(
				STATUS.timers,
				active > 0 ? `${active} timer${active === 1 ? "" : "s"}` : undefined,
				"accent",
			);
		} catch {
			// The session was replaced.
		}
	};
	const refresh = (ctx?: ExtensionContext) => {
		try {
			scheduler?.refresh();
		} catch (error) {
			warn(ctx ?? current, `Timers are unavailable: ${errorMessage(error)}`);
		}
	};

	api.on("session_start", async (_event, ctx) => {
		scheduler?.stop();
		current = ctx;
		scheduler = new TimerScheduler({
			db,
			sessionId: ctx.sessionManager.getSessionId(),
			now,
			check,
			wake,
			changed: showCount,
			failed: (error) => warn(current, `A timer pass failed: ${errorMessage(error)}`),
		});
		refresh(ctx);
	});
	api.on("session_shutdown", async () => {
		scheduler?.stop();
		scheduler = undefined;
		current = undefined;
	});
	api.registerMessageRenderer(TIMER_TYPE, (message, { expanded, outputPad }, theme) =>
		renderTimerMessage(message.details, contentText(message.content), expanded, theme, outputPad ?? 1),
	);
	api.registerTool(
		timerTool({
			db,
			workspaceId: (ctx) => registeredWorkspace(ctx.cwd, db()).id,
			agent: options.agent,
			now,
			changed: (ctx, set) => {
				if (set) scheduler?.hold(set.id);
				refresh(ctx);
			},
		}),
	);
	return { settle: () => scheduler?.settle() ?? Promise.resolve() };
}
