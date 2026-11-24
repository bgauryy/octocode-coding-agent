import { agentTaskDisplay } from "./display.ts";
import { desktopAvailable } from "../../../../mcp/src/api.ts";
import type { RunDetails } from "./run-types.ts";
import type { FeatureSetup, FeatureContext } from "../../core/features/index.ts";
import type { Permission } from "../permission/ask.ts";
import { type Subcommand, notify } from "../shared/commands.ts";
import { timedTool } from "../render/rows.ts";
import { modelLookup, settleWithin } from "../shared/util.ts";
import { UserQuestions } from "../team/asks.ts";
import { runningWorkOf } from "../shared/running-work.ts";
import { liveAgentsOf } from "../shared/team-spend.ts";
import { AgentsView } from "../team/panel.ts";
import type { Team } from "../team/session.ts";
import { RunningBudgets } from "./budget.ts";
import { type AgentRuns, type Run, Slots } from "./claim.ts";
import { agentsCommand, stopBackground } from "./command.ts";
import { ReadReports, scratchRoot, sweepScratch } from "./handoff/scratch.ts";
import { ReportQueue } from "./handoff.ts";
import { heldReports, ReportGroups } from "./report-groups.ts";
import { LateReports } from "./late.ts";
import { Lingering } from "./linger.ts";
import { GraphWake } from "./graph-wake.ts";
import { GraphWatch, linkedWhileWorking } from "./graph-watch.ts";
import { ChainQueue } from "./chain.ts";
import { PrerequisiteGate } from "./prerequisites.ts";
import { AGENT_CHAIN_CHANNEL, BACKLOG_ENDED_CHANNEL, type BacklogEnded } from "../shared/agent-chain.ts";
import { GRAPH_NOTICE_TYPE } from "../shared/messages.ts";
import { DatabaseFollower } from "../shared/database-follower.ts";
import { dbStamp } from "../../../../db/src/api.ts";
import { gateHost } from "./gate-host.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { type Backlog, openBacklog } from "../backlog/context.ts";
import { runSubagent } from "./process.ts";
import { SUBAGENT_STOP_GRACE_MS } from "./process/outcome.ts";
import { buildRouteArgs, type ChildSession, childSession } from "./process/session.ts";
import type { AgentProfile } from "./profiles.ts";
import type { RelayHost } from "./relay.ts";
import { registerAgentMessageRenderer, renderAgentCall, renderAgentResult } from "./render.ts";
import { registerIdleItems } from "./idle-items.ts";
import { sendGraphNotice } from "../wake/senders.ts";
import { startNotices } from "./start-notices.ts";
import { agentToolSpec } from "../native/tools/agent/spec.ts";
import type { Runners } from "./runner-port.ts";
import { FORK_NOTE_TYPE, forkNote, resumedChildren } from "./children.ts";
import { type MergeResult, mergeChild } from "./merge-child.ts";
import type { Handoff } from "../team/tools/hand.ts";
import { type ChildContext, contextOf, handItem } from "./hand-item.ts";
import { HandedItems } from "./handed-items.ts";
import { CHILD_EXPOSURE_EVENT, type ChildExposure } from "../permission/provenance/exposure.ts";
import { PERMISSION_STOP } from "./report-text.ts";
import { startBackground } from "./run-execution.ts";
import { messageResumer } from "./message-resume.ts";
import { spawnAgent } from "./spawn.ts";
import { startGate } from "./rate-gate.ts";
import type { SpawnEnv } from "./spawn-env.ts";
import { recordRun, runDetails, tracker } from "./tracking.ts";
import type { QaReviewer } from "../backlog/qa-gate.ts";
import { qaReviewer } from "./qa-review.ts";

/** What the rest of the feature may do with the subagents this session started. */
export interface AgentControl {
	/** Reviews an item's completion on the small tier before `done` writes it (`backlog.qa`). */
	review: QaReviewer;
	/** Stops a background subagent this session started; the refusal text when there is none by that id. */
	stop(id: string, by: string): string | undefined;
	/** Resolves once every background subagent has finished and sent its report. */
	settle(): Promise<unknown>;
	/** Resolves once the next background subagent has finished and sent its report (`session-lifecycle.ts` retries a failed run then). */
	nextReport(): Promise<unknown>;
	/** Lands an isolated child's saved ref in this tree (`coordinate merge`). */
	merge(id: string, ctx: FeatureContext, signal?: AbortSignal): Promise<MergeResult>;
	/** The request budgets of the children running now (`coordinate` `grant` and `list`). */
	budgets: RunningBudgets;
	/** The children queued behind prerequisites, one row each: what they wait on, or why they are held. */
	queued(): string[];
	/** Background subagents running now (a session switch would stop them). */
	background(): number;
	/** Names of the subagents running now, foreground and background (a narrowing permission change stops them). */
	running(): string[];
	/** The backlog item each running child works on, by child name (`done` waits for them). */
	serving(): Map<string, string>;
	/** Hands an item to a running child (`agent` `message` with `item`), and reads a running child's context fill. */
	handItem(child: string, ref: string, ctx: FeatureContext): Handoff;
	context(id: string): ChildContext | undefined;
	/** Stop background agents and wait for their reports before shutdown. */
	stopAll(reason?: string): Promise<void>;
	/** Follow-up windows any session holds open for finished children (they live in session folders, not in memory). */
	parked: typeof Lingering.parkedChildren;
	/** `/agents`: list agents, tell, kill, merge; `index.ts` registers it and its `/agents` shortcut. */
	command: Subcommand;
}

/** A note to the model that starts no turn, so its send settles at once: awaited, a failure reaches the bus's error report. */
const NOTE_SEND = { triggerTurn: false } as const;
/** Shutdown's wait for stopped background subagents: past the SIGTERM grace, after which they are killed. */
const SHUTDOWN_WAIT_MS = SUBAGENT_STOP_GRACE_MS + 1_000;
/** What the `agent` tool needs from the session that composes it. */
interface AgentToolOptions {
	/** The session's agent profiles, read at each call. */
	profiles: () => Map<string, AgentProfile>;
	team: Team;
	permission: Permission;
	/** Why each refused profile file was refused, by profile name, so an unknown profile's error names the cause. */
	refused?: () => ReadonlyMap<string, string>;
	/** Where the tool is declared (the `agent` tool's mode collector); `api.tools.register` by default. */
	registerTool?: FeatureSetup["tools"]["register"];
	/** Vendor CLIs that run `agent` tasks over ACP. */
	runners?: Runners;
}

export function registerAgentTool(api: FeatureSetup, options: AgentToolOptions): AgentControl {
	const { profiles: getProfiles, team, permission, refused: getRefused, runners } = options;
	const registerTool = options.registerTool ?? ((tool) => api.tools.register(tool));
	registerAgentMessageRenderer(api);
	// Per registration, not per module: a replaced session starts clean.
	const panel = new AgentsView(team, runningWorkOf(api), liveAgentsOf(api));
	const budgets = new RunningBudgets();
	let current: FeatureContext | undefined; // The current session, for graph wakes and the graph watch.
	let backlog: Backlog | undefined;
	const items = new Map<string, string>(); // The backlog item each child works on, by child id (`AgentRuns.items`).
	const runs: AgentRuns = {
		api,
		team,
		background: new Map(),
		foreground: new Map(),
		live: new Map(),
		// A report goes out at once unless a sibling of its own step is about to join it (`report-groups.ts`).
		reports: new ReportQueue(api, (q) => heldReports(runs.groups, q), items),
		groups: new ReportGroups(),
		read: new ReadReports(),
		running: new Map(),
		items,
		handed: new HandedItems(),
		slots: new Slots(),
		session: 0,
		changed: () => panel.setBackground([...runs.background.keys()]),
		ended: (id, end) => team.approvals.noteEnd(id, end),
		graph: new GraphWake(
			(content) => void sendGraphNotice(api, GRAPH_NOTICE_TYPE, content),
			() => {
				try {
					return current?.isIdle() ?? true;
				} catch {
					// The session was replaced: nothing runs in it.
					return true;
				}
			},
			team.wakePace,
		),
	};
	const follower = new DatabaseFollower(() => dbStamp(sharedAgentDb().file));
	// The prerequisites of queued children: items read from the backlog on each event, agents from the lifecycle channel and the parent's own record of each run's end.
	runs.chain = new ChainQueue(
		new PrerequisiteGate(
			gateHost({
				api,
				follower,
				item: (ref) => (backlog ??= current ? openBacklog(current, { isSubagent: false }) : undefined)?.store.get(ref),
				session: () => current?.sessionManager.getSessionId(),
			}),
		),
		(notice) => api.channels.emit(AGENT_CHAIN_CHANNEL, notice),
	);
	runs.chain.watch(() => panel.setQueued(runs.chain!.work(runs.items)));
	// The coordinator's own backlog write completed an item: queued children waiting on it start now, and its result names
	// no ready item they will start (`backlog/ended-signal.ts`).
	api.channels.on(BACKLOG_ENDED_CHANNEL, (value) => {
		for (const ref of runs.chain?.items() ?? []) (value as BacklogEnded).queued.add(ref);
		runs.chain?.gate.refresh();
	});
	const watch = new GraphWatch({
		queued: () => runs.chain?.items() ?? new Set(),
		backlog: () => (backlog ??= current ? openBacklog(current, { isSubagent: false }) : undefined),
		linked: (ref) => linkedWhileWorking(runs.items, (id) => runs.running.has(id) || runs.background.has(id), ref),
		tell: (notice) => runs.graph?.tell(notice),
		subscribe: (poke) => follower.subscribe(poke),
	});
	const { background } = runs;
	api.bus.on("tool_result", async (event, ctx) => {
		if (!event.isError && background.size > 0) runs.read.observe(event.toolName, event.input, ctx.cwd, event.details);
		return undefined;
	});
	// When this session asked the user: an answer the parent gives right after one may be the user's.
	const questions = new UserQuestions();
	const overlapWarned = new Set<string>(); // Live agent and goal pairs the launch result named (`team/overlap.ts`): once each.
	api.bus.on("tool_execution_start", async (event) => {
		if (event.toolName === "askUser") questions.begin(event.toolCallId);
		return undefined;
	});
	api.bus.on("tool_execution_end", async (event) => {
		if (event.toolName === "askUser") questions.end(event.toolCallId);
		return undefined;
	});
	/** Runs `work` and, once it ends, records the run's session file and its questions to this session's agent. */
	const record = <T>(run: Run, details: RunDetails, session: ChildSession, work: Promise<T>): Promise<T> =>
		recordRun(
			details,
			session,
			() =>
				run.identity.parentId
					? questions.mark(team.asks(run.identity.id, run.identity.parentId, details.startedAt))
					: [],
			work,
		);
	let launching = new AbortController();
	const cancelLaunches = () => {
		launching.abort();
		launching = new AbortController();
	};
	/** The caller's signal joined with the one a permission change or shutdown aborts. */
	const withLaunch = (signal?: AbortSignal) =>
		signal ? AbortSignal.any([signal, launching.signal]) : launching.signal;
	// Finished background runs still reachable (OCTOCODE_SUBAGENT_LINGER_SECONDS): a message resumes their saved conversation.
	const lingering = new Lingering(
		runs,
		permission,
		withLaunch,
		(run, ctx, { text, message }) => {
			const session = childSession(run.identity);
			const details = runDetails(run, session);
			const tracking = tracker(run.identity, details, modelLookup(ctx), ctx);
			const args = buildRouteArgs(run.profile, run.route, session, run.identity.mcpNamed);
			const host = relayHost(ctx);
			const onProgress = tracking(undefined);
			const child = { task: message, args, cwd: ctx.cwd, profile: run.profile, identity: run.identity, host };
			// Answered at once, its slot held: the child starts once its provider is not cooling down (`rate-gate.ts`).
			const launch = (signal: AbortSignal) =>
				record(
					run,
					details,
					session,
					tracking.withScreenshots(
						startGate.wait(run.route, signal).then(() => runSubagent({ ...child, signal, onProgress })),
					),
				);
			startBackground(
				runs,
				run,
				details,
				text,
				launch,
				() => Promise.resolve("").finally(run.release),
				ctx.sessionManager.getSessionId(),
				lingering.window(run, ctx),
			);
		},
		getProfiles,
	);
	const late = new LateReports(runs);
	const stopRuns = async (by: string): Promise<void> => {
		// Wait (bounded) for stopped children to file their reports; a named stop files them without starting a turn.
		for (const id of runs.foreground.keys()) stopBackground(runs.foreground, id, by, "subagent");
		const stopping = [...background].map(([id, entry]) => {
			stopBackground(background, id, by);
			return entry.done;
		});
		await settleWithin(Promise.all(stopping), SHUTDOWN_WAIT_MS);
		runs.reports.flush();
	};
	// A reload stops them without asking: their reports (now, or at the next start when late) say it was the reload.
	// Stopping every child (plan mode, leaving, shutdown) is the session's own act: those reports, however late, force no graph wake.
	const stopAll = async (reason?: string) => {
		runs.graph?.stopping(background.keys());
		await stopRuns(reason === "reload" ? "the /reload" : "session shutdown");
	};
	/** What this session offers a child: its permission state, its UI when a person can be asked, and its team's signature for the user's messages. */
	const relayHost = (ctx: Pick<FeatureContext, "hasUI" | "ui">): RelayHost => ({
		permission,
		exposure: (child, exposed) => api.channels.emit(CHILD_EXPOSURE_EVENT, { child, exposed } satisfies ChildExposure),
		vouch: (id, secret) => team.vouch(id, secret),
		awaitingApproval: (id, waiting) => team.awaitingApproval(id, waiting),
		tell: (notice) => runs.graph?.tell(notice),
		output: (id, at) => team.approvals.noteOutput(id, at),
		idleWait: (id, text) => team.approvals.noteIdleWait(id, text),
		budgets,
		...(ctx.hasUI ? { ui: ctx.ui } : {}),
	});
	permission.onRevoke(() => {
		cancelLaunches();
		void stopRuns(PERMISSION_STOP);
	});
	api.bus.on("turn_end", async (event) => {
		runs.groups.nextStep();
		if (event.toolResults.length > 0) runs.reports.stepEnded();
		return undefined;
	});
	const stopStalls = registerIdleItems(api, team, runs, lingering);
	api.bus.on("before_agent_start", async () => {
		runs.graph?.turnStarted();
		runs.groups.nextStep();
		return undefined;
	});
	api.bus.on("agent_settled", async () => {
		runs.reports.retryExhausted();
		// What the coordinator planned this turn: the items that wait, followed until an outside change ends a prerequisite.
		watch.sync();
		await late.take();
	});
	api.bus.on("session_shutdown", async (event, ctx) => {
		cancelLaunches();
		late.stop();
		stopStalls();
		// Reports still waiting in the batch window are saved for the next start, not lost with this runtime.
		runs.reports.persist();
		await stopAll(event.reason);
		overlapWarned.clear();
		runs.graph?.stop();
		watch.stop();
		runs.reports.persist();
		// A child still closing keeps its entry (and its slot) until it exits; its report waits for this session's next start.
		runs.session += 1;
		lingering.close();
		panel.stop(ctx);
	});
	// Worktrees left by an Octocode process that died: their changes are saved to the agent's ref, then the worktree goes (kept when saving fails).
	api.bus.on("session_start", async (event, ctx) => {
		const forked = event.reason === "fork" ? forkNote(ctx.sessionManager.getEntries()) : undefined;
		const tell = (content: string) =>
			api.session.sendMessage({ customType: FORK_NOTE_TYPE, content, display: false }, NOTE_SEND);
		if (forked) await tell(forked);
		await lingering.reopen(ctx);
		current = ctx;
		backlog = undefined;
		runs.graph?.start();
		watch.sync();
		panel.start(ctx);
		runs.reports.start(
			ctx.sessionManager,
			() => ctx.isIdle(),
			(text) => {
				if (ctx.hasUI) notify(ctx.ui, text, "warning");
			},
			(details, content) => ctx.replaceQueuedMessage(details, content),
		);
		await late.start(ctx.sessionManager.getSessionId());
		// After the reports waiting for this session were taken: a child that filed one is not gone without a word.
		if (event.reason === "resume" || event.reason === "startup") {
			const gone = resumedChildren(ctx.sessionManager.getEntries(), runs.reports.pendingIds(), runs.running, team);
			if (gone.note) await tell(gone.note);
			panel.restoreFinished(gone.rows);
		}
		// Off the start path: it lists and deletes directories.
		const root = scratchRoot(ctx.cwd);
		setImmediate(() => {
			void sweepScratch(root);
			return undefined;
		});
		void startNotices(event, ctx)
			.then((notes) => {
				for (const note of notes) if (ctx.hasUI) notify(ctx.ui, note.text, note.level);
			})
			// The session may have been replaced meanwhile (/new, /resume): its ctx then throws, and nobody is left to tell.
			.catch(() => undefined);
	});
	const spawnEnv: SpawnEnv = {
		api,
		runs,
		permission,
		getProfiles,
		...(getRefused ? { getRefused } : {}),
		lingering,
		overlapWarned,
		withLaunch,
		record,
		relayHost,
		...(runners ? { runners } : {}),
	};
	registerTool(
		timedTool({
			...agentToolSpec(runners?.ids, desktopAvailable()),
			execute: (id, params, signal, onUpdate, ctx) => spawnAgent(spawnEnv, id, params, signal, onUpdate, ctx),
			display: agentTaskDisplay,
			renderCall: renderAgentCall,
			renderResult: renderAgentResult,
		}),
	);
	team.setResumer(messageResumer(spawnEnv), runs.running);
	return {
		// A lingering run has nothing running: stopping it ends its window.
		stop: (id, by) => (lingering.forget(id) ? undefined : stopBackground(background, id, by)),
		// Reports still inside their batching window go out now: a held headless run hands them to its next turn.
		settle: () => Promise.all([...background.values()].map((entry) => entry.done)).then(() => runs.reports.flush()),
		nextReport: () =>
			Promise.race([...background.values()].map((entry) => entry.done)).then(() => runs.reports.flush()),
		merge: (id, ctx, signal) => mergeChild(team, permission, id, ctx, signal),
		review: qaReviewer(spawnEnv),
		budgets,
		queued: () => runs.chain?.rows() ?? [],
		background: () => background.size,
		running: () => [...runs.foreground.keys(), ...background.keys()],
		serving: () => new Map([...runs.items].filter(([id]) => runs.running.has(id))),
		handItem: (child, ref, ctx) => handItem(runs, lingering, child, ref, ctx),
		context: (id) => contextOf(runs, id),
		stopAll,
		parked: Lingering.parkedChildren,
		command: agentsCommand(team, background, runs.foreground, questions, (id) => budgets.usage(id)),
	};
}
