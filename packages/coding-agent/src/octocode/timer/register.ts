import type { FeatureSetup, FeatureContext } from "../../core/features/index.ts";
import { defineTool } from "../../core/features/types/tools.ts";
import { formatCost } from "../shared/format.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { sharedAgentDb } from "../../storage/database.ts";
import { registeredWorkspace } from "../../storage/workspace-database.ts";
import { backlog, dbStamp, isBusy, machineSamples, timers, type TimerRow } from "../../../../db/src/api.ts";
import { BACKLOG_CHANGE_CHANNEL, type BacklogChange, type BacklogChangeNotice } from "../shared/backlog-change.ts";
import { backlogDeps } from "./backlog-deps.ts";
import { peerEnd } from "./peer-end.ts";
import { getAgentDir } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { say } from "../shared/commands.ts";
import { TIMER_TYPE } from "../shared/messages.ts";
import { runningWorkOf } from "../shared/running-work.ts";
import { STATUS } from "../shared/status.ts";
import { contentText } from "../shared/util.ts";
import { conditionChecker, conditionWatcher } from "./condition.ts";
import type { ConditionDeps } from "./conditions/types.ts";
import { CHECK_CAPS, Judge, type SmallModel } from "./judge.ts";
import { DatabaseFollower } from "../shared/database-follower.ts";
import { cronCommand, loopCommand } from "./cron-command.ts";
import { cronOf } from "./cron.ts";
import { cronOverspend, cronSettings, sessionCostUsd } from "./cron-guard.ts";
import { wakeDetails, wakeEvent, wakeText } from "./model.ts";
import { renderPrompt } from "../../core/prompt-template.ts";
import type { Subcommands } from "../shared/commands.ts";
import { wakeGateOf } from "../wake/gate.ts";
import { renderTimerMessage } from "./render.ts";
import { timerWorkRows } from "./work.ts";
import { TimerScheduler } from "./scheduler.ts";
import type { LiveJob } from "./job-poll.ts";
import { timerTool } from "../native/tools/notify/tool.ts";

/** The tool's name before it became `notify`; only saved sessions still carry it. */
const LEGACY_TOOL_NAME = "wait";

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
	/** A subagent may not set a cron schedule: it ends with its report. */
	isSubagent?: boolean;
	/** Where `/cron` and `/loop` register; without it neither exists (a session that owns no command line). */
	commands?: Subcommands;
	/** The background jobs whose end wakes this session (its own and those it joined): a `notify` polling one is refused. */
	jobs?: (ctx: FeatureContext) => readonly LiveJob[];
}

const itemSeq = (ref: string) => {
	const seq = /^\s*(?:[bB]|#)?(\d{1,9})\s*$/.exec(ref)?.[1];
	return seq === undefined ? undefined : Number(seq);
};

/**
 * The `notify` tool and its scheduler: each session loads its own active timers from the agent database at start, fires
 * them while it runs (a wake is a steer message: a busy session reads it at its next step, an idle one starts a turn; retried by `wake-retry.ts` like a job report),
 * and leaves them active at shutdown for a resumed session. `settle()` lets a headless run's hold wait for the next wake
 * of a timer this run set; timers from an earlier run never hold an exit.
 */
export function registerTimers(
	api: FeatureSetup,
	options: TimerOptions,
): { settle(): Promise<unknown>; endOwn(): number } {
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now;
	const db = () => sharedAgentDb(env);
	let current: FeatureContext | undefined;
	let scheduler: TimerScheduler | undefined;
	/** The user said yes to judging once this session, with `timer.check.enabled` off. */
	let approved = false;
	let approvalGeneration = 0;
	/** The user said yes to scheduled tasks once this session, with `timer.cron.enabled` off. */
	let cronApproved = false;
	/** Cron timers whose last run was sent and may still be queued or running: while the session is busy, a second due run of the same timer is not queued behind it. */
	const queuedRuns = new Set<number>();
	/** Read from the global settings only, as `bash.inheritProviderKeys` is: a project file must not start paid calls. */
	const checkAllowed = () => approved || checkEnabledSetting(options.agentDir);
	const follower = new DatabaseFollower(() => dbStamp(db().file), isBusy);
	const workspace = () => registeredWorkspace(current?.cwd ?? process.cwd(), db()).id;
	const small = options.small ?? NO_SMALL_MODEL;
	const judge = new Judge({
		ctx: () => current,
		now,
		sessionSpend: (sessionId) => timers.sessionSpend(db().db, sessionId),
		allowed: checkAllowed,
		small,
		recordUsage: (kind, provider, model, usage) => api.usage.record(kind, provider, model, usage),
	});
	// The main session's backlog feed announces every audited change here; a subagent runs no feed and polls the file instead.
	const changeListeners = new Set<(change: BacklogChange) => void>();
	if (!options.isSubagent)
		api.channels.on(BACKLOG_CHANGE_CHANNEL, (value) => {
			for (const listener of changeListeners) listener((value as BacklogChangeNotice).change);
		});
	const deps: ConditionDeps = {
		backlog: backlogDeps({
			db,
			workspace,
			own: (by) => by === current?.sessionManager.getSessionId() || by === options.agent(),
			...(options.isSubagent
				? {}
				: {
						subscribe: (listener) => {
							changeListeners.add(listener);
							return () => changeListeners.delete(listener);
						},
					}),
		}),
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
		agentEnd: (name) => peerEnd(db().db, workspace(), name),
		machine: (count) => machineSamples.recentLoads(db().db, count),
		watchDatabase: (poke) => follower.subscribe(poke),
		judge: (request) => judge.judge(request),
	};
	const check = conditionChecker(deps);
	const watch = conditionWatcher(deps);
	/** What `set` must settle before a `check` wait starts: the setting or the user's first-use answer, and a cheaper model. */
	const checkRefusal = async (ctx: FeatureContext): Promise<string | undefined> => {
		if (!checkAllowed()) {
			const generation = approvalGeneration;
			if (!ctx.hasUI)
				return "check spends money on a small model and is off: set timer.check.enabled to true, or use a deterministic event.";
			const caps = `at most ${CHECK_CAPS.perWaitChecks} judgments and $${CHECK_CAPS.perWaitUsd.toFixed(2)} per request, $${CHECK_CAPS.perSessionUsd.toFixed(2)} per session`;
			const yes = await ctx.ui.confirm(
				"Allow paid judging for notifications?",
				`A notification with check pays a cheaper model to judge its question once the event holds, ${caps}. Allow for this session?`,
			);
			if (generation !== approvalGeneration)
				return "The session changed while awaiting judging approval. Nothing was set.";
			if (!yes) return "The user declined judging by a small model; use a deterministic condition.";
			approved = true;
		}
		return small.label(ctx) ? undefined : "check needs a cheaper model than this session's, and none is available.";
	};
	/** What `set` with cron must settle first: subagents and screenless sessions are refused, and the user confirms once per session. */
	const cronRefusal = async (ctx: FeatureContext, schedule: string, firstRun: number): Promise<string | undefined> => {
		if (options.isSubagent) return renderPrompt("notices/timer/cron-subagent.md");
		const settings = cronSettings(options.agentDir);
		if (settings.enabled || cronApproved) return undefined;
		if (!ctx.hasUI) return renderPrompt("notices/timer/cron-headless.md");
		const generation = approvalGeneration;
		const yes = await ctx.ui.confirm(
			"Allow scheduled tasks?",
			`The agent wants to run a prompt on a schedule (cron ${schedule}, first run ${new Date(firstRun).toLocaleString()}). Each run is a model turn with nobody watching, once this session is idle, for at most 20 runs or 7 days, and stops past $${settings.maxUsd.toFixed(2)} of spending in this session. Allow scheduled tasks for this session?`,
		);
		if (generation !== approvalGeneration) return renderPrompt("notices/timer/cron-changed.md");
		if (!yes) return renderPrompt("notices/timer/cron-declined.md");
		cronApproved = true;
		return undefined;
	};
	const sessionUsd = (ctx: Pick<FeatureContext, "sessionManager">) => sessionCostUsd(ctx.sessionManager.getEntries());
	/** Why a due cron timer ends instead of running: the session spent more than its cap since the first cron timer. */
	const cronStop = (row: TimerRow): string | undefined => {
		if (!current) return undefined;
		const settings = cronSettings(options.agentDir);
		const rows = timers.forSession(db().db, row.session_id, true).filter((each) => cronOf(each));
		const spent = cronOverspend(rows, sessionUsd(current), settings.maxUsd);
		if (spent === undefined) return undefined;
		warn(
			current,
			renderPrompt("notices/timer/cron-budget.md", {
				id: row.id,
				spent: spent.toFixed(2),
				cap: settings.maxUsd.toFixed(2),
			}),
		);
		return "budget";
	};
	const warn = (ctx: FeatureContext | undefined, text: string) => {
		try {
			if (ctx) say(ctx, text, "warning");
		} catch {
			// The session was replaced.
		}
	};
	const wake = (row: TimerRow) => {
		const context = current;
		// A cron run is a standalone prompt: it waits for the session to be idle (followUp) instead of joining a turn (steer).
		const cron = cronOf(row) !== undefined;
		if (cron) {
			// An idle session has nothing queued ahead of this run; a busy one that still holds the timer's previous run takes no second.
			if (context?.isIdle()) queuedRuns.delete(row.id);
			else if (queuedRuns.has(row.id)) return;
			queuedRuns.add(row.id);
		}
		const failed = (error: unknown) => {
			queuedRuns.delete(row.id);
			warn(context, `Notification ${row.id} could not reach this session: ${errorMessage(error)}`);
		};
		try {
			const sending = wakeGateOf(api).emit(
				wakeEvent(row),
				{ customType: TIMER_TYPE, content: wakeText(row), display: true, details: wakeDetails(row) },
				{ triggerTurn: true, deliverAs: cron ? "followUp" : "steer" },
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
			current?.ui.setStatus(
				STATUS.timers,
				spent > 0 ? `notify judging ${formatCost({ cost: spent, unpriced: false })}` : undefined,
				"accent",
			);
		} catch {
			// The session was replaced.
		}
	};
	const refresh = (ctx?: FeatureContext) => {
		try {
			scheduler?.refresh();
		} catch (error) {
			warn(ctx ?? current, `Notifications are unavailable: ${errorMessage(error)}`);
		}
	};

	api.bus.on("session_start", async (_event, ctx) => {
		scheduler?.stop();
		approvalGeneration++;
		approved = false;
		cronApproved = false;
		queuedRuns.clear();
		current = ctx;
		const sessionId = ctx.sessionManager.getSessionId();
		// Waits whose deadline passed while their session was not running can no longer be met in time: end them now, not at a later session's check.
		try {
			timers.expireOverdue(db().db, now(), sessionId);
		} catch (error) {
			warn(ctx, `Overdue notifications were not expired: ${errorMessage(error)}`);
		}
		scheduler = new TimerScheduler({
			db,
			sessionId,
			now,
			check,
			watch,
			wrote: () => follower.rebase(),
			forget: (id) => judge.forget(id),
			wake,
			cronStop,
			cronEvent: (event) => {
				if (event.kind === "skipped")
					warn(
						current,
						renderPrompt("notices/timer/cron-skipped.md", {
							id: event.row.id,
							next: new Date(event.next).toLocaleString(),
						}),
					);
			},
			changed: showTimers,
			failed: (error) => warn(current, `A notification pass failed: ${errorMessage(error)}`),
		});
		refresh(ctx);
	});
	api.bus.on("session_shutdown", async () => {
		approvalGeneration++;
		work.set("timer", []);
		scheduler?.stop();
		scheduler = undefined;
		current = undefined;
	});
	api.renderers.message(TIMER_TYPE, (message, { expanded, outputPad }, theme) =>
		renderTimerMessage(message.details, contentText(message.content), expanded, theme, outputPad ?? 1),
	);
	const notify = timerTool({
		db,
		workspaceId: (ctx) => registeredWorkspace(ctx.cwd, db()).id,
		agent: options.agent,
		now,
		deps,
		jobs: options.jobs ?? (() => []),
		implicit: () => {
			const children = work.background();
			const jobs = work.all().filter((row) => row.kind === "bash");
			return [
				...(children.length ? [`children ${children.join(", ")} (report)`] : []),
				...(jobs.length ? [`${jobs.map((row) => row.id).join(", ")} (exit)`] : []),
			].join("; ");
		},
		checkRefusal,
		cronRefusal,
		cronCap: () => cronSettings(options.agentDir).maxUsd,
		sessionUsd: (ctx) => sessionUsd(ctx),
		changed: (ctx, set) => {
			if (set) scheduler?.hold(set.id);
			refresh(ctx);
		},
	});
	api.tools.register(notify);
	// Sessions saved before the rename hold `wait` calls: their rows keep rendering with the same renderers.
	const legacyRenderers = defineTool(notify);
	api.renderers.tool((name, next) => (name === LEGACY_TOOL_NAME ? legacyRenderers : next()));
	const commandHost = {
		db,
		workspaceId: (ctx: { cwd: string }) => registeredWorkspace(ctx.cwd, db()).id,
		agent: options.agent,
		now,
		sessionUsd,
		cap: () => cronSettings(options.agentDir).maxUsd,
		changed: (ctx: FeatureContext, row?: TimerRow) => {
			if (row) scheduler?.hold(row.id);
			refresh(ctx);
		},
	};
	// `/jobs kill #<id>` ends a cron or wait through the path `wait` off and `/cron delete` use.
	work.onCancel("timer", (id, ctx) => {
		const context = ctx as FeatureContext;
		const ended = timers.cancel(db().db, Number(id.slice(1)), context.sessionManager.getSessionId(), now());
		if (ended) commandHost.changed(context);
		return ended !== undefined;
	});
	if (options.commands && !options.isSubagent) {
		options.commands.add("cron", cronCommand(commandHost));
		options.commands.add("loop", loopCommand(commandHost));
	}
	return {
		settle: () => scheduler?.settle() ?? Promise.resolve(),
		/** Cancels every active wait of this session (a subagent that reported needs none) and releases the run's hold; returns how many. */
		endOwn() {
			const sessionId = current?.sessionManager.getSessionId();
			if (!sessionId) return 0;
			const ended = timers.cancelAll(db().db, sessionId, now());
			if (ended.length === 0) return 0;
			for (const row of ended) judge.forget(row.id);
			refresh();
			return ended.length;
		},
	};
}
