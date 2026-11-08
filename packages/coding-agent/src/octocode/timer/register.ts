import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { sharedAgentDb } from "../../config/database.ts";
import { registeredWorkspace } from "../../config/workspace-database.ts";
import { agentEvents, backlog, dbStamp, timers, type TimerRow } from "../../../../db/src/api.ts";
import { getAgentDir } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { workspacePaths } from "../shared/home.ts";
import { say } from "../shared/commands.ts";
import { TIMER_TYPE } from "../shared/messages.ts";
import { runningWorkOf } from "../shared/running-work.ts";
import { STATUS } from "../shared/status.ts";
import { contentText } from "../shared/util.ts";
import { conditionChecker, conditionWatcher } from "./condition.ts";
import type { ConditionDeps } from "./conditions/types.ts";
import { CHECK_CAPS, Judge, type SmallModel } from "./judge.ts";
import { DatabaseFollower } from "./poke.ts";
import { wakeDetails, wakeText } from "./model.ts";
import { renderTimerMessage } from "./render.ts";
import { timerWorkRows } from "./work.ts";
import { TimerScheduler } from "./scheduler.ts";
import { timerTool } from "./tool.ts";

/** `timer.check.enabled` from the global settings; unreadable settings keep it off. */
function checkEnabledSetting(agentDir: string = getAgentDir()): boolean {
	try {
		return (
			SettingsManager.create(agentDir, agentDir, { projectTrusted: false }).getSettings().timer?.check?.enabled === true
		);
	} catch {
		// Unreadable settings: judging stays off, which costs nothing.
		return false;
	}
}

const NO_SMALL_MODEL: SmallModel = {
	call: async () => ({ error: "no judging model route is configured" }),
	label: () => undefined,
};

export interface TimerOptions {
	/** Why another agent's reservation keeps `absolute` from being changed, or undefined (`Team.reservation`). */
	reservation(absolute: string, display: string): string | undefined;
	/** This agent's team id, recorded on the timers it sets. */
	agent(): string | undefined;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	/** Where the global settings live; the user's agent directory by default. */
	agentDir?: string;
	/** The route of a `check`'s judging model (`subagents/`'s `small` purpose); without it a `check` cannot be set. */
	small?: SmallModel;
}

const itemSeq = (ref: string) => {
	const seq = /^\s*(?:[bB]|#)?(\d{1,9})\s*$/.exec(ref)?.[1];
	return seq === undefined ? undefined : Number(seq);
};

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
	/** The user said yes to judging once this session, with `timer.check.enabled` off. */
	let approved = false;
	/** Read from the global settings only, as `bash.inheritProviderKeys` is: a project file must not start paid calls. */
	const checkAllowed = () => approved || checkEnabledSetting(options.agentDir);
	const follower = new DatabaseFollower(() => dbStamp(db().file));
	const workspace = () => registeredWorkspace(current?.cwd ?? process.cwd(), db()).id;
	const small = options.small ?? NO_SMALL_MODEL;
	const judge = new Judge({
		ctx: () => current,
		now,
		sessionSpend: (sessionId) => timers.sessionSpend(db().db, sessionId),
		allowed: checkAllowed,
		small,
		recordUsage: (kind, provider, model, usage) => api.recordUsage(kind, provider, model, usage),
	});
	const deps: ConditionDeps = {
		reservation: options.reservation,
		context: () => current,
		item(ref) {
			const seq = itemSeq(ref);
			const item = seq === undefined ? undefined : backlog.itemBySeq(db().db, workspace(), seq);
			return item ? (item.closed === null ? item.state : "closed") : undefined;
		},
		blockers(ref) {
			const seq = itemSeq(ref);
			return seq === undefined ? undefined : backlog.openPrerequisites(db().db, workspace(), seq);
		},
		agentEnd(name) {
			const [event] = agentEvents.list(db().db, workspace(), Number.MAX_SAFE_INTEGER, 1, {
				agentId: name,
				eventType: "delete",
			});
			if (!event) return undefined;
			const { reason, detail } = event.data;
			return {
				reason: typeof reason === "string" ? reason : "ended",
				...(typeof detail === "string" ? { detail } : {}),
			};
		},
		watchDatabase: (poke) => follower.subscribe(poke),
		roots: (cwd) => {
			const paths = workspacePaths(cwd);
			return [paths.root, paths.dir, paths.tmp];
		},
		judge: (request) => judge.judge(request),
	};
	const check = conditionChecker(deps);
	const watch = conditionWatcher(deps);
	/** What `set` must settle before a `check` wait starts: the setting or the user's first-use answer, and a cheaper model. */
	const checkRefusal = async (ctx: ExtensionContext): Promise<string | undefined> => {
		if (!checkAllowed()) {
			if (!ctx.hasUI)
				return "until.check spends money on a small model and is off: set timer.check.enabled to true, or use a deterministic condition.";
			const caps = `at most ${CHECK_CAPS.perWaitChecks} judgments and $${CHECK_CAPS.perWaitUsd.toFixed(2)} per wait, $${CHECK_CAPS.perSessionUsd.toFixed(2)} per session`;
			const yes = await ctx.ui.confirm(
				"Let timers ask a small model?",
				`A timer wait with until.check calls a cheaper model to judge a condition, ${caps}. Allow for this session?`,
			);
			if (!yes) return "The user declined judging by a small model; use a deterministic condition.";
			approved = true;
		}
		return small.label(ctx)
			? undefined
			: "until.check needs a cheaper model than this session's, and none is available.";
	};
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
	const work = runningWorkOf(api);
	/** Publishes the active timers to the footer's typed counts and the work rows above it; what judging spent keeps its own status. */
	const showTimers = () => {
		try {
			const sessionId = current?.sessionManager.getSessionId();
			if (!sessionId) return;
			work.set("timer", timerWorkRows(timers.forSession(db().db, sessionId)));
			const spent = timers.sessionSpend(db().db, sessionId);
			current?.ui.setStatus(STATUS.timers, spent > 0 ? `timer judging $${spent.toFixed(3)}` : undefined, "accent");
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
			watch,
			wrote: () => follower.rebase(),
			forget: (id) => judge.forget(id),
			wake,
			changed: showTimers,
			failed: (error) => warn(current, `A timer pass failed: ${errorMessage(error)}`),
		});
		refresh(ctx);
	});
	api.on("session_shutdown", async () => {
		work.set("timer", []);
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
			deps,
			checkRefusal,
			changed: (ctx, set) => {
				if (set) scheduler?.hold(set.id);
				refresh(ctx);
			},
		}),
	);
	return { settle: () => scheduler?.settle() ?? Promise.resolve() };
}
