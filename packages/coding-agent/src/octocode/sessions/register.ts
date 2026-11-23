import { renderPrompt } from "../../core/prompt-template.ts";
import path from "node:path";
import { Text } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { sessions as sessionRows } from "../../../../db/src/api.ts";
import type { FeatureSetup, FeatureContext } from "../../core/features/index.ts";
import { sharedAgentDb, sharedAgentDbWriter } from "../../storage/database.ts";
import type { Subcommands } from "../shared/commands.ts";
import { notify } from "../shared/commands.ts";
import { recordProblem } from "../../core/diagnostics-log.ts";
import { reportSweep } from "./sweep-report.ts";
import { SpendScan } from "../shared/spend.ts";
import { currentSessionId } from "../shared/home.ts";
import { registeredWorkspace } from "../../storage/workspace-database.ts";
import { expandHint, plural } from "../shared/text.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import {
	addUsage,
	contentText,
	emptyUsage,
	isStaleSessionError,
	type Spend,
	modelLookup,
	spendOf,
	unpricedModel,
} from "../shared/util.ts";
import {
	type BriefInput,
	latestRequest,
	latestRequestIndex,
	openTasksBrief,
	RESUME_TAG,
	resumeBrief,
	type TeamNotes,
	teamBrief,
} from "./brief.ts";
import { recordSession, recordSessionLater, recordTitle } from "./catalog.ts";
import { SessionActivityRecord } from "./activity-record.ts";
import { registerSessionsCommand } from "./command.ts";
import { registerPurgeCommand } from "./purge-command.ts";
import { gitCommitsBetween, gitDirty, gitState, SessionIndex } from "./store.ts";
import { gitHeadStamp } from "./git-stamp.ts";
import { type CompleteTitle, createAutoTitler } from "./title.ts";
import { sweepSessions } from "./sweep.ts";
import { RUNNING_WORK_TYPE } from "../shared/context-notices.ts";
import {
	type Entry,
	branchOf,
	hasUserMessage,
	lastActive,
	pendingReportIds,
	registerGoalName,
	totals,
} from "./session-scan.ts";
import { danglingChildren, describeWork, unansweredCalls, unreportedWork } from "./work.ts";
import { compactionRequestBrief, keptAfterCompaction, lastReplyBrief } from "./compaction-brief.ts";
import { backlogIndex } from "../backlog/task-source.ts";

/** Custom message type of the resume brief. */
export const RESUME_MESSAGE_TYPE = "octocode-resume";
/** Custom message type of the running-work note added after a compaction. */
export { RUNNING_WORK_TYPE };

interface SessionsOptions {
	commands: Subcommands;
	/** A subagent keeps its output in its own session folder but gets no index row, sweep, command or brief. */
	isSubagent: boolean;
	/** Distinct files the agent changed in this session (the checkpoint journal). */
	filesChanged?: () => number;
	/** A subagent's goal: it names the child's session (`session_info` with source `goal`). */
	goal?: string;
	/** This agent's reservations and unanswered questions in its team, named in the note after a compaction. */
	team?: TeamNotes;
	/** The model call that writes an auto title, and how long it may take (tests replace both). */
	titleCall?: { complete?: CompleteTitle; timeoutMs?: number };
}

/**
 * After a compaction, a non-waking reorient brief: the backlog index of the new span (`backlogIndex`: counts, the
 * ongoing items with the active one's goal and next step, the most urgent open ones, each with its version), its open tasks, its path reservations and the questions waiting for its reply,
 * and the latest user request (left out when Octocode's summary keeps that request inline or the compaction kept it in
 * the retained tail).
 * The summary may have dropped them. The running jobs, subagents and timers are not repeated here: the summary's
 * Recovery block states them (`compaction/live-state.ts`). Every part is capped (see brief.ts).
 */
function registerRunningWork(api: FeatureSetup, team?: TeamNotes): void {
	api.bus.on("session_compact", async (event, ctx) => {
		const branch = branchOf(ctx);
		const source = ctx.sessionManager.getSessionFile();
		let ongoing: string[] = [];
		try {
			const agent = sharedAgentDb();
			const repo = registeredWorkspace(ctx.cwd, agent).id;
			const session = ctx.sessionManager.getSessionId();
			const index = backlogIndex(agent, repo, session);
			ongoing = [...(index ? [index] : []), ...openTasksBrief(agent, repo, session)];
		} catch {
			// The agent database is unavailable: the running work and the request alone still help.
		}
		const held = team ? teamBrief(team) : [];
		// The native summary keeps user messages within a budget; test for the actual copy before skipping this reminder.
		// A request in the retained tail is still in the context whole: an excerpt would only repeat it.
		const at = latestRequestIndex(branch);
		const latest = keptAfterCompaction(branch, at, event.compactionEntry) ? undefined : latestRequest(branch);
		const request = latest ? compactionRequestBrief(latest, event.compactionEntry, source) : undefined;
		const reply = request ? lastReplyBrief(branch, event.compactionEntry) : undefined;
		if (ongoing.length === 0 && held.length === 0 && !request) return;
		const lines = [...ongoing, ...held, ...(reply ? [reply] : []), ...(request ? [request] : [])];
		const content = renderPrompt("notices/compaction/session-state.md", { lines: lines.join("\n") });
		try {
			await api.session.sendMessage(
				{
					customType: RUNNING_WORK_TYPE,
					content,
					display: false,
					details: { compactionId: event.compactionEntry?.id ?? null },
				},
				{ triggerTurn: false, deliverAs: "followUp" },
			);
		} catch (error) {
			// The session was replaced; anything else reaches the bus's error report.
			if (!isStaleSessionError(error)) throw error;
		}
	});
}

/**
 * The session extras (`sessions` table of the agent database), its retention sweep, `/resume` (`/sessions`)
 * and the resume brief shown when a saved session is resumed. Octocode owns the sessions themselves (files, names, first
 * messages). Database failures never break the session: the feature warns once and stays out of the way. Git runs off
 * the event loop, so a slow repository never stalls a turn.
 */
export function registerSessions(api: FeatureSetup, options: SessionsOptions): void {
	registerRunningWork(api, options.team);
	if (options.isSubagent) {
		registerGoalName(api, options.goal);
		return;
	}
	let warned = false;
	/** A resumed session's record from before this start, briefed at the next prompt (not now: the user may come back later). */
	let pending: Omit<BriefInput, "git"> | undefined;
	/** This session's running cost and tokens, and whether part of it came from a model without pricing. */
	let usage = emptyUsage();
	const scan = new SpendScan();
	let unpriced = false;
	let gitRevision = 0;
	const index = () => new SessionIndex(sharedAgentDb(), () => sharedAgentDbWriter());
	const titler = createAutoTitler(api, {
		...options.titleCall,
		enabled: () => api.settings.get().sessions?.autoTitle !== false,
	});
	const warn = (ctx: FeatureContext, error: unknown) => {
		// A background git result can arrive after the host invalidates this
		// context. The optional warning must not turn that failure into a rejection.
		try {
			// With no UI the warning has no reader: every failure goes to stderr, as other headless features report theirs.
			if (!ctx.hasUI) {
				recordProblem("sessions", `Octocode session index unavailable: ${errorMessage(error)}`);
				process.stderr.write(`Octocode session index unavailable: ${errorMessage(error)}\n`);
				return;
			}
			if (warned) return;
			warned = true;
			notify(ctx.ui, `Octocode session index unavailable: ${errorMessage(error)}`, "warning");
		} catch {
			// The UI context was replaced while the background work completed.
		}
	};
	const safely = (ctx: FeatureContext, work: (sessions: SessionIndex) => void) => {
		try {
			if (ctx.sessionManager.getSessionFile()) work(index());
		} catch (error) {
			warn(ctx, error);
		}
	};
	/** `safely` for the per-turn writes, which go through the database writer (`SessionIndex` `…Later`). */
	const later = async (ctx: FeatureContext, work: (sessions: SessionIndex) => Promise<void>) => {
		try {
			if (ctx.sessionManager.getSessionFile()) await work(index());
		} catch (error) {
			warn(ctx, error);
		}
	};
	/** The context of the session the light follows: the tone it writes goes through that session's writer. */
	let lightCtx: FeatureContext | undefined;
	const light = new SessionActivityRecord((id, tone) => {
		if (lightCtx) void later(lightCtx, (sessions) => sessions.activityLater(id, tone));
	});
	/** The session, folder and git metadata of the last recorded git state: an unchanged turn runs no git. */
	let gitRecorded: string | undefined;
	/** Records where git stands now, without waiting for it; nothing runs when HEAD and its branch did not move. */
	const recordGit = (ctx: FeatureContext, id: string) => {
		const revision = ++gitRevision;
		const stamp = gitHeadStamp(ctx.cwd);
		const key = stamp === undefined ? undefined : `${id}\0${stamp}`;
		if (key !== undefined && key === gitRecorded) return Promise.resolve();
		return gitState(ctx.cwd).then(async (state) => {
			// A newer request or session shutdown makes this result stale, including its Octocode context.
			if (revision !== gitRevision) return;
			await later(ctx, async (sessions) => {
				await sessions.gitLater(id, state);
				gitRecorded = key;
			});
		});
	};

	api.renderers.message(RESUME_MESSAGE_TYPE, (message, { expanded }, theme) => {
		// The tag is for the model; the arrow already marks the brief for the person.
		const text = contentText(message.content).replace(`${RESUME_TAG} `, "");
		const [head = "", ...rest] = sanitizeTerminalText(text).split("\n");
		// Collapsed, the hidden lines get resultBlock's hint, so the brief reads as expandable like any tool row.
		const tail = !rest.length
			? ""
			: expanded
				? `\n  ${rest.join("\n  ")}`
				: [` … +${plural(rest.length, "line")}`, expandHint()].filter(Boolean).join(" ");
		return new Text(theme.fg("dim", `↻ ${head}${tail}`), 1, 0);
	});

	api.bus.on("session_start", async (event, ctx) => {
		gitRevision++;
		titler.cancel();
		pending = undefined;
		const id = ctx.sessionManager.getSessionId();
		// Read through the scan, so the first reply's look starts after these entries.
		scan.reset();
		const entries = scan.appended(ctx.sessionManager).entries as readonly Entry[];
		({ usage, unpriced } = totals(entries, ctx.sessionManager.getHeader?.(), modelLookup(ctx), scan));
		safely(ctx, (sessions) => {
			const previous = sessions.get(id);
			const resumed = event?.reason === "resume" || (event?.reason === "startup" && hasUserMessage(entries));
			const at = lastActive(entries);
			// Work the earlier process started and never reported: it stopped with that process (a crash, or a report lost).
			// A subagent whose report waits for this start is not one: its report is delivered as a message.
			const late = resumed ? pendingReportIds(id) : new Set<string>();
			const unreported = resumed
				? unreportedWork(branchOf(ctx))
						.filter((work) => work.kind !== "agent" || !late.has(work.id))
						.map((work) => describeWork(work))
				: [];
			if (resumed && at !== undefined) {
				const recorded = { branch: previous?.branch ?? null, head: previous?.head ?? null };
				const request = latestRequest(branchOf(ctx));
				const unanswered = unansweredCalls(branchOf(ctx));
				const children = unanswered.length > 0 ? danglingChildren(sessions.agent, id, branchOf(ctx)) : [];
				pending = {
					previous: recorded,
					lastActive: at,
					sessionId: id,
					repoKey: registeredWorkspace(ctx.cwd, sessions.agent).id,
					...(unreported.length > 0 ? { unreported } : {}),
					...(unanswered.length > 0 ? { unanswered } : {}),
					...(children.length > 0 ? { children } : {}),
					...(request ? { request } : {}),
				};
			}
			// The row keeps the dir its session runs from: the sweep keeps the session while that dir cannot be read.
			const sessionDir = ctx.sessionManager.getSessionDir?.();
			const dir = sessionDir ? path.resolve(sessionDir) : undefined;
			// One transaction: a bind that succeeds with no start would leave a row without the pid that marks it running.
			const workspaceId = registeredWorkspace(ctx.cwd, sessions.agent).id;
			sessions.agent.transaction(() => {
				sessionRows.bind(sessions.agent.db, id, workspaceId);
				sessions.start(id, dir);
			});
			recordSession(sessions, ctx.sessionManager);
			// Keep unreadable checkout and custom directories registered so retention never mistakes them for deletions.
			if (dir) sessions.addSessionDir(dir);
			// Off the start path; at most once per 6 h across all sessions.
			const env = { ...process.env };
			setImmediate(() => {
				void sweepSessions(sessions, currentSessionId(), { env, report: (line) => reportSweep(ctx, line) });
				return undefined;
			});
		});
		void recordGit(ctx, id);
		// After the start above, which made the row this process's and its light idle: only a change is written.
		lightCtx = ctx;
		light.follow(id, "idle");
	});

	const add = (spend: Spend | undefined, ctx: FeatureContext) => {
		if (!spend) return;
		addUsage(usage, spend.usage);
		unpriced ||= unpricedModel(spend, modelLookup(ctx)) !== undefined;
	};
	/** Spend recorded outside a reply (a compaction summary request, a cache refresh, a side question) since the last look. */
	const addRecorded = (ctx: FeatureContext) => {
		for (const spend of scan.recordedIn(ctx.sessionManager)) add(spend, ctx);
	};
	api.bus.on("message_end", async (event, ctx) => {
		add(spendOf(event.message), ctx);
		return undefined;
	});
	api.bus.on("session_compact", async (event, ctx) => {
		add(scan.entry(event.compactionEntry), ctx);
		addRecorded(ctx);
		return undefined;
	});
	api.bus.on("session_tree", async (event, ctx) => {
		add(scan.entry(event.summaryEntry), ctx);
		return undefined;
	});

	api.bus.on("before_agent_start", async (event, ctx) => {
		if (!pending) return undefined;
		const input = pending;
		pending = undefined;
		const [now, dirty] = await Promise.all([gitState(ctx.cwd), gitDirty(ctx.cwd)]);
		const from = input.previous.head;
		const commitsSince =
			from && now.head && from !== now.head ? await gitCommitsBetween(ctx.cwd, from, now.head) : undefined;
		let content: string | undefined;
		safely(ctx, (sessions) => {
			content = resumeBrief(sessions.agent, {
				...input,
				// Handler messages follow the message that starts the run (`prepareRun`), so a new prompt comes before this note.
				newPrompt: event.messageType !== "custom",
				git: { ...now, dirty, ...(commitsSince === undefined ? {} : { commitsSince }) },
			});
		});
		return content ? { message: { customType: RESUME_MESSAGE_TYPE, content, display: true } } : undefined;
	});

	api.bus.on("agent_end", async (_event, ctx) => {
		addRecorded(ctx);
		const id = ctx.sessionManager.getSessionId();
		const stats = {
			cost: usage.cost.total,
			tokens: usage.totalTokens,
			filesChanged: options.filesChanged?.() ?? 0,
			unpriced,
		};
		// Through the database writer, in this order: the turn's bookkeeping never waits on another process's lock here.
		await later(ctx, async (sessions) => {
			const written = sessions.statsLater(id, stats);
			await Promise.all([written, recordSessionLater(sessions, ctx.sessionManager)]);
		});
		void recordGit(ctx, id);
		// In the background: a turn never waits for its title.
		void titler.onAgentEnd(ctx);
	});

	// A session still unnamed when it is compacted gets one title from the summary's goal, in the background.
	api.bus.on("session_compact", async (event, ctx) => {
		void titler.onCompact(ctx, event);
	});

	api.bus.on("session_info_changed", async (event, ctx) => {
		await later(ctx, (sessions) => recordTitle(sessions, ctx.sessionManager, event.name, event.source));
	});

	api.bus.on("session_shutdown", async (_event, ctx) => {
		gitRevision++;
		titler.cancel();
		// No tone after the end below, which clears the row's light with its pid.
		light.close();
		// After the turn's writes still queued, so the row cannot be marked live again once it ended.
		await later(ctx, (sessions) => sessions.endLater(ctx.sessionManager.getSessionId()));
	});

	registerSessionsCommand(api, options.commands, { index, current: currentSessionId });
	registerPurgeCommand(api, options.commands, { index, current: currentSessionId });
}
