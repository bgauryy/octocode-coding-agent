import type { RunDetails } from "./run-types.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import type { Permission } from "../permission/ask.ts";
import { type Subcommand, notify } from "../shared/commands.ts";
import { timedTool } from "../shared/render/rows.ts";
import { modelLookup, settleWithin } from "../shared/util.ts";
import { UserQuestions } from "../team/asks.ts";
import { AgentsView } from "../team/panel.ts";
import type { BudgetStanding } from "../team/model.ts";
import type { Team } from "../team/session.ts";
import { RunningBudgets } from "./budget.ts";
import { type AgentRuns, type Run, Slots } from "./claim.ts";
import { agentsCommand, stopBackground } from "./command.ts";
import { ReadReports, scratchRoot, sweepScratch } from "./handoff/scratch.ts";
import { ReportQueue } from "./handoff.ts";
import { LateReports } from "./late.ts";
import { Lingering } from "./linger.ts";
import { runSubagent } from "./process.ts";
import { SUBAGENT_STOP_GRACE_MS } from "./process/outcome.ts";
import { buildAgentArgs, type ChildSession, childSession } from "./process/session.ts";
import type { AgentProfile } from "./profiles.ts";
import type { RelayHost } from "./relay.ts";
import { registerAgentMessageRenderer, renderAgentCall, renderAgentResult } from "./render.ts";
import { startNotices } from "./start-notices.ts";
import { agentToolSpec } from "./agent-tool.ts";
import { FORK_NOTE_TYPE, forkNote, resumeNote } from "./children.ts";
import { type MergeResult, mergeChild } from "./merge-child.ts";
import { PERMISSION_STOP } from "./report-text.ts";
import { startBackground } from "./run-execution.ts";
import { spawnAgent, type SpawnEnv } from "./spawn.ts";
import { recordRun, runDetails, tracker } from "./tracking.ts";

/** What the rest of the extension may do with the subagents this session started. */
export interface AgentControl {
	/** Stops a background subagent this session started; the refusal text when there is none by that id. */
	stop(id: string, by: string): string | undefined;
	/** Resolves once every background subagent has finished and sent its report. */
	settle(): Promise<unknown>;
	/** Resolves once the next background subagent has finished and sent its report (`session-lifecycle.ts` retries a failed run then). */
	nextReport(): Promise<unknown>;
	/** Lands an isolated child's saved ref in this tree (`coordinate merge`). */
	merge(id: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<MergeResult>;
	/** The request budgets of the children running now (`coordinate` `grant` and `list`). */
	budgets: RunningBudgets;
	/** Background subagents running now (a session switch would stop them). */
	background(): number;
	/** Names of the subagents running now, foreground and background (a narrowing permission change stops them). */
	running(): string[];
	/** Stop background agents and wait for their reports before shutdown. */
	stopAll(reason?: string): Promise<void>;
	/** Follow-up windows any session holds open for finished children (they live in session folders, not in memory). */
	parked: typeof Lingering.parkedChildren;
	/** `/agents`: list agents, tell, kill, merge; `index.ts` registers it and its `/agents` shortcut. */
	command: Subcommand;
}

/** `coordinate merge` for a registration that reaches the agent tool later (`index.ts` builds the team tools first). */
export const mergeThrough =
	(agents: () => AgentControl | undefined) =>
	async (id: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<MergeResult> =>
		(await agents()?.merge(id, ctx, signal)) ?? { ok: false, text: "Agent controls are unavailable." };

/** `coordinate` `grant` and `list` for a registration that reaches the agent tool later, like `mergeThrough`. */
export const budgetsThrough = (agents: () => AgentControl | undefined) => ({
	grant: (id: string, requests: number): BudgetStanding | string =>
		agents()?.budgets.grant(id, requests) ?? "Agent controls are unavailable.",
	usage: (id: string): BudgetStanding | undefined => agents()?.budgets.usage(id),
});

/** How long shutdown waits for stopped background subagents: past the SIGTERM grace, after which they are killed. */
const SHUTDOWN_WAIT_MS = SUBAGENT_STOP_GRACE_MS + 1_000;

export function registerAgentTool(
	api: ExtensionAPI,
	getProfiles: () => Map<string, AgentProfile>,
	team: Team,
	permission: Permission,
	getRefused?: () => ReadonlyMap<string, string>,
	registerTool: ExtensionAPI["registerTool"] = (tool) => api.registerTool(tool),
): AgentControl {
	registerAgentMessageRenderer(api);
	// Per registration, not per module: a replaced session starts clean.
	const panel = new AgentsView(team);
	const budgets = new RunningBudgets();
	const runs: AgentRuns = {
		api,
		team,
		background: new Map(),
		foreground: new Map(),
		live: new Map(),
		reports: new ReportQueue(api),
		read: new ReadReports(),
		running: new Map(),
		slots: new Slots(),
		session: 0,
		changed: () => panel.setBackground(runs.background.size),
	};
	const { background } = runs;
	api.on("tool_result", async (event, ctx) => {
		if (!event.isError && background.size > 0) runs.read.observe(event.toolName, event.input, ctx.cwd, event.details);
		return undefined;
	});
	// When this session asked the user: an answer the parent gives right after one may be the user's.
	const questions = new UserQuestions();
	// Live agent and goal pairs the launch result already named (`team/overlap.ts`): each is named once.
	const overlapWarned = new Set<string>();
	api.on("tool_execution_start", async (event) => {
		if (event.toolName === "askUser") questions.begin(event.toolCallId);
		return undefined;
	});
	api.on("tool_execution_end", async (event) => {
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
			const track = tracker(run.identity, details, modelLookup(ctx), ctx);
			const args = buildAgentArgs(run.profile, run.route.model, session, [], run.route.thinking);
			const host = relayHost(ctx);
			const launch = (signal: AbortSignal) =>
				record(
					run,
					details,
					session,
					runSubagent(
						message,
						args,
						ctx.cwd,
						run.profile,
						run.identity,
						signal,
						track(undefined),
						undefined,
						undefined,
						host,
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
	const stopAll = (reason?: string) => stopRuns(reason === "reload" ? "the /reload" : "session shutdown");
	/** What this session offers a child: its permission state, its UI when a person can be asked, and its team's signature for the user's messages. */
	const relayHost = (ctx: Pick<ExtensionContext, "hasUI" | "ui">): RelayHost => ({
		permission,
		vouch: (id, secret) => team.vouch(id, secret),
		awaitingApproval: (id, waiting) => team.awaitingApproval(id, waiting),
		output: (id, at) => team.approvals.noteOutput(id, at),
		budgets,
		...(ctx.hasUI ? { ui: ctx.ui } : {}),
	});
	permission.onRevoke(() => {
		cancelLaunches();
		void stopRuns(PERMISSION_STOP);
	});
	api.on("turn_end", async (event) => {
		if (event.toolResults.length > 0) runs.reports.stepEnded();
		return undefined;
	});
	api.on("agent_settled", async () => {
		runs.reports.retryExhausted();
		await late.take();
	});
	api.on("session_shutdown", async (event, ctx) => {
		cancelLaunches();
		late.stop();
		// Reports still waiting in the batch window are saved for the next start, not lost with this runtime.
		runs.reports.persist();
		await stopAll(event.reason);
		runs.reports.persist();
		// A child still closing keeps its entry (and its slot) until it exits; its report waits for this session's next start.
		runs.session += 1;
		lingering.close();
		panel.stop(ctx);
	});
	// Worktrees left by a Octocode process that died: their changes are saved to the agent's ref, then the worktree goes (kept when saving fails).
	api.on("session_start", async (event, ctx) => {
		const forked = event.reason === "fork" ? forkNote(ctx.sessionManager.getEntries()) : undefined;
		const tell = (content: string) =>
			void api.sendMessage(
				{ customType: FORK_NOTE_TYPE, content, display: false },
				{ triggerTurn: false, deliverAs: "followUp" },
			);
		if (forked) tell(forked);
		lingering.reopen(ctx);
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
			const gone = resumeNote(ctx.sessionManager.getEntries(), runs.reports.pendingIds(), new Set(runs.running.keys()));
			if (gone) tell(gone);
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
	};
	registerTool(
		timedTool({
			...agentToolSpec(),
			execute: (id, params, signal, onUpdate, ctx) => spawnAgent(spawnEnv, id, params, signal, onUpdate, ctx),
			renderCall: renderAgentCall,
			renderResult: renderAgentResult,
		}),
	);
	team.setResumer(
		(id, text, from, signal, request) => lingering.resume(id, text, from, signal, request),
		(id) => runs.running.has(id),
	);
	return {
		// A lingering run has nothing running: stopping it ends its window.
		stop: (id, by) => (lingering.forget(id) ? undefined : stopBackground(background, id, by)),
		// Reports still inside their batching window go out now: a held headless run hands them to its next turn.
		settle: () => Promise.all([...background.values()].map((entry) => entry.done)).then(() => runs.reports.flush()),
		nextReport: () =>
			Promise.race([...background.values()].map((entry) => entry.done)).then(() => runs.reports.flush()),
		merge: (id, ctx, signal) => mergeChild(team, permission, id, ctx, signal),
		budgets,
		background: () => background.size,
		running: () => [...runs.foreground.keys(), ...background.keys()],
		stopAll,
		parked: Lingering.parkedChildren,
		command: agentsCommand(team, background, runs.foreground, questions),
	};
}
