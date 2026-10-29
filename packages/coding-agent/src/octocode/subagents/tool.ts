import type { RunDetails } from "./run-types.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/index.ts";
import { withIdentity } from "../instructions/task.ts";
import type { Permission } from "../permission/ask.ts";
import { existingLibrary } from "../shared/archive.ts";
import { type Subcommand, notify } from "../shared/commands.ts";
import { timedTool } from "../shared/render/rows.ts";
import { errorMessage } from "../../utils/guards.ts";
import { modelLookup, settleWithin } from "../shared/util.ts";
import { UserQuestions } from "../team/asks.ts";
import { getMcpAddedServers } from "../../../../mcp/src/session-servers.ts";
import { checkGoal } from "../team/identity.ts";
import { AgentsView } from "../team/panel.ts";
import { launchOverlap } from "../team/overlap.ts";
import type { Team } from "../team/session.ts";
import { type AgentRuns, claimRun, joinTeam, planRun, type Run, Slots } from "./claim.ts";
import { agentsCommand, stopBackground } from "./command.ts";
import { ReadReports, scratchRoot, sweepScratch } from "./handoff/scratch.ts";
import { ReportQueue } from "./handoff.ts";
import { LateReports } from "./late.ts";
import { Lingering } from "./linger.ts";
import { runSubagent } from "./process.ts";
import { SUBAGENT_STOP_GRACE_MS } from "./process/outcome.ts";
import { buildAgentArgs, type ChildSession, childSession } from "./process/session.ts";
import { type AgentProfile, askSpawn } from "./profiles.ts";
import { startGate } from "./rate-gate.ts";
import { childStagger } from "./stagger.ts";
import { admitResultSchema } from "./result-schema.ts";
import type { RelayHost } from "./relay.ts";
import { registerAgentMessageRenderer, renderAgentCall, renderAgentResult } from "./render.ts";
import { describePrune, pendingRefs, pruneWorktrees, recordWorktreePid } from "./worktree.ts";
import { agentToolSpec } from "./agent-tool.ts";
import { FORK_NOTE_TYPE, forkNote, resumableChild, resumedTask } from "./children.ts";
import { Isolation } from "./isolation.ts";
import { PERMISSION_STOP } from "./report-text.ts";
import { runForeground, startBackground } from "./run-execution.ts";
import { type AgentUpdate, recordRun, runDetails, tracker, waitingUpdate } from "./tracking.ts";

/** What the rest of the extension may do with the subagents this session started. */
export interface AgentControl {
	/** Stops a background subagent this session started; the refusal text when there is none by that id. */
	stop(id: string, by: string): string | undefined;
	/** Resolves once every background subagent has finished and sent its report. */
	settle(): Promise<unknown>;
	/** Background subagents running now (a session switch would stop them). */
	background(): number;
	/** Names of the subagents running now, foreground and background (a narrowing permission change stops them). */
	running(): string[];
	/**
	 * Session shutdown's first step: stops every background subagent and waits (bounded) for their reports. Idempotent.
	 * `reason`: the shutdown's (`reload`, `quit`…), named in the reports of the runs it stopped.
	 */
	stopAll(reason?: string): Promise<void>;
	/** `/agents`: list agents, tell, kill, merge; `index.ts` registers it and its `/agents` shortcut. */
	command: Subcommand;
}

/** How long shutdown waits for stopped background subagents: past the SIGTERM grace, after which they are killed. */
const SHUTDOWN_WAIT_MS = SUBAGENT_STOP_GRACE_MS + 1_000;

export function registerAgentTool(
	pi: ExtensionAPI,
	getProfiles: () => Map<string, AgentProfile>,
	team: Team,
	permission: Permission,
	getRefused?: () => ReadonlyMap<string, string>,
	registerTool: ExtensionAPI["registerTool"] = (tool) => pi.registerTool(tool),
): AgentControl {
	registerAgentMessageRenderer(pi);
	// Per registration, not per module: a replaced session starts clean.
	const panel = new AgentsView(team);
	const runs: AgentRuns = {
		pi,
		team,
		background: new Map(),
		foreground: new Map(),
		reports: new ReportQueue(pi),
		read: new ReadReports(),
		running: new Map(),
		slots: new Slots(),
		session: 0,
		changed: () => panel.setBackground(runs.background.size),
	};
	const { background } = runs;
	pi.on("tool_result", async (event, ctx) => {
		if (!event.isError && background.size > 0) runs.read.observe(event.toolName, event.input, ctx.cwd, event.details);
		return undefined;
	});
	// When this session asked the user: an answer the parent gives right after one may be the user's.
	const questions = new UserQuestions();
	// Live agent and goal pairs the launch result already named (`team/overlap.ts`): each is named once.
	const overlapWarned = new Set<string>();
	pi.on("tool_execution_start", async (event) => {
		if (event.toolName === "askUser") questions.begin(event.toolCallId);
		return undefined;
	});
	pi.on("tool_execution_end", async (event) => {
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
			const track = tracker(run.identity, details, modelLookup(ctx));
			const args = buildAgentArgs(run.profile, run.route.model, session, []);
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
		...(ctx.hasUI ? { ui: ctx.ui } : {}),
	});
	permission.onRevoke(() => {
		cancelLaunches();
		void stopRuns(PERMISSION_STOP);
	});
	pi.on("agent_settled", async () => late.take());
	pi.on("session_shutdown", async (event, ctx) => {
		cancelLaunches();
		late.stop();
		// Usually done already: index.ts runs it before the team leaves.
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
	pi.on("session_start", async (event, ctx) => {
		// A fork's in-flight children stopped with the session it forked from: the model learns which, and how to continue them.
		const forked = event.reason === "fork" ? forkNote(ctx.sessionManager.getEntries()) : undefined;
		if (forked)
			void pi.sendMessage(
				{ customType: FORK_NOTE_TYPE, content: forked, display: false },
				{ triggerTurn: false, deliverAs: "followUp" },
			);
		lingering.reopen(ctx);
		panel.start(ctx);
		runs.reports.start(ctx.sessionManager, () => ctx.isIdle());
		await late.start(ctx.sessionManager.getSessionId());
		// Off the start path: it lists and deletes directories.
		const root = scratchRoot(ctx.cwd);
		setImmediate(() => {
			void sweepScratch(root);
			return undefined;
		});
		void pruneWorktrees(ctx.cwd)
			.then(describePrune, (error: unknown) => ({
				text: `Could not prune orphaned subagent worktrees: ${errorMessage(error)}`,
				level: "warning" as const,
			}))
			.then((note) => {
				if (note && ctx.hasUI) notify(ctx.ui, note.text, note.level);
			})
			// The session may have been replaced meanwhile (/new, /resume): its ctx then throws, and nobody is left to tell.
			.catch(() => undefined);
	});
	registerTool(
		timedTool({
			...agentToolSpec(),
			async execute(id, params, signal, onUpdate, ctx) {
				const launchSignal = withLaunch(signal);
				launchSignal.throwIfAborted();
				if (params.workingCopy && !params.isolate) throw new Error("workingCopy requires isolate: true.");
				const resultContract = params.resultSchema === undefined ? undefined : admitResultSchema(params.resultSchema);
				const goal = checkGoal(params.goal);
				const skillResources = pi.getSkillResourceSnapshot(params.skills);
				// A continued child is one this session recorded, on its own transcript and profile (`children.ts`).
				const resumed = params.resume
					? resumableChild(ctx.sessionManager.getEntries(), params.resume, new Set(runs.running.keys()))
					: undefined;
				if (resumed && params.isolate)
					throw new Error("resume continues a child in this tree; isolate does not apply.");
				// Refusals first (unknown profile, unavailable model), then a slot, then the spawn ask: the user is never asked
				// for a run that cannot start, and a denied spawn claims and starts nothing.
				const plan = planRun(
					getProfiles(),
					resumed ? resumedTask(params, resumed.child, ctx.modelRegistry.getAvailable()) : params,
					ctx,
					getRefused?.(),
				);
				await startGate.wait(launchSignal); // a child just failed on a rate limit: the next start would meet it too
				await runs.slots.take(launchSignal, (running) => onUpdate?.(waitingUpdate(params.profile, goal, running)));
				let claimed: Run | undefined;
				let grants: Awaited<ReturnType<typeof askSpawn>>;
				try {
					grants = await askSpawn(
						permission,
						ctx,
						plan.profile,
						params.task,
						launchSignal,
						pi.getSettings().defaultTools,
						{ toolCallId: id, goal },
					);
					// An isolated run's name must not repeat a saved ref: `/agents merge <name>` would be ambiguous.
					const refs = params.isolate ? await pendingRefs(ctx.cwd) : [];
					launchSignal.throwIfAborted();
					claimed = claimRun(runs, plan, { ...params, goal, name: resumed?.child.id }, ctx, refs);
					// Its follow-up window, if one is open, ends: this call continues it.
					if (resumed) lingering.forget(resumed.child.id);
				} finally {
					// From here the run's `release` gives the slot back.
					if (!claimed) runs.slots.give();
				}
				const run = claimed;
				const isolation = new Isolation(run.identity.id);
				let finalized: Promise<string> | undefined;
				const finish = () => {
					finalized ??= isolation.finish().finally(run.release);
					return finalized;
				};
				let handedOff = false;
				// From the claim on, every failure goes through `finish`: the slot and the name are given back.
				try {
					if (resultContract) run.identity.resultContract = resultContract;
					run.identity.skillResources = skillResources;
					// Servers the model added with `mcp` (the user confirmed each) reach the child as a transient file.
					const addedServers = getMcpAddedServers(pi.events);
					if (Object.keys(addedServers).length > 0) run.identity.mcpServers = addedServers;
					// A child cannot ask anyone, so it gets the mode, the reach the user's spawn approval named (for the whole run: that
					// approval is the consent, `askSpawn`) and every kind the user allowed for this session. Never a class that always asks.
					run.identity.permission = {
						mode: permission.mode,
						grants: [...new Set([...grants, ...permission.childGrants()])],
					};
					// With a person to ask, the child's approval dialogs come here (this tool exists only in the main session).
					run.identity.relay = ctx.hasUI;
					const host = relayHost(ctx);
					const cwd = params.isolate ? await isolation.start(ctx, run.identity, params.workingCopy) : ctx.cwd;
					launchSignal.throwIfAborted();
					const worktree = isolation.worktree;
					const warning = `${worktree?.warning ? `\n\n${worktree.warning}` : ""}${run.teamNote}${launchOverlap(team, run.identity.id, goal, overlapWarned)}`;
					const onSpawn = worktree ? (pid: number) => recordWorktreePid(worktree, pid) : undefined;
					const library = existingLibrary();
					const browserMode = run.profile?.headless;
					const taskInput =
						browserMode === undefined ? params.task : `${params.task}\n\nBrowser mode: headless=${browserMode}.`;
					const contractTask = resultContract
						? `${taskInput}\n\nResult contract (SHA-256 ${resultContract.hash}): Return the requested result in your final answer, after the ordinary report, as exactly one final block:\nStructured result:\n\`\`\`json\n<JSON matching the schema>\n\`\`\`\nSchema: ${JSON.stringify(resultContract.schema)}`
						: taskInput;
					const own = withIdentity(
						resumed ? `Follow-up from your parent:\n${contractTask}` : contractTask,
						run.identity,
						library ? { library } : undefined,
					);
					const task = run.identity.collaborate ? joinTeam(runs, run, own) : own;
					const session = resumed?.session ?? childSession(run.identity);
					const details = runDetails(run, session);
					const track = tracker(run.identity, details, modelLookup(ctx));
					// Only a background run that is not isolated (its worktree is gone) can stay reachable for a follow-up: for the linger setting, and after a `blocked` report whatever it is.
					const lingers = params.background === true && !params.isolate;
					const args = buildAgentArgs(run.profile, run.route.model, session, []);
					const launch = (runSignal: AbortSignal | undefined, update: AgentUpdate | undefined, warm?: () => void) => {
						const tracked = track(update);
						const progress: typeof tracked = (change) => {
							if (change.responding) warm?.();
							tracked(change);
						};
						return record(
							run,
							details,
							session,
							runSubagent(task, args, cwd, run.profile, run.identity, runSignal, progress, onSpawn, undefined, host),
						);
					};
					// Siblings with the same profile and model share a prompt prefix: the later ones wait (bounded) for the first one's reply, which writes the cache.
					const prefix = [run.identity.role, run.route.model ?? run.route.parent, params.skills?.join(",")].join("\0");
					const stopping = () => {
						details.stopping = true;
						onUpdate?.({ content: [{ type: "text", text: "stopping…" }], details: { ...details } });
					};
					if (!params.background)
						return await runForeground(
							runs,
							run,
							details,
							(runSignal) => launch(runSignal, onUpdate),
							finish,
							warning,
							launchSignal,
							stopping,
						);
					startBackground(
						runs,
						run,
						details,
						params.task,
						(runSignal) => childStagger.run(prefix, runSignal, (warm) => launch(runSignal, undefined, warm)),
						finish,
						ctx.sessionManager.getSessionId(),
						lingers ? lingering.window(run, ctx) : undefined,
					);
					handedOff = true;
					details.status = "background";
					return {
						content: [
							{
								type: "text",
								text: `Started ${run.identity.id} (${run.identity.role}: ${goal}) in the background; its report arrives as a message.${warning}`,
							},
						],
						details,
					};
				} finally {
					// A failure before the run started still removes the worktree.
					if (!handedOff) await finish();
				}
			},
			renderCall: renderAgentCall,
			renderResult: renderAgentResult,
		}),
	);
	team.setResumer((id, text, from, signal) => lingering.resume(id, text, from, signal));
	return {
		// A lingering run has nothing running: stopping it ends its window.
		stop: (id, by) => (lingering.forget(id) ? undefined : stopBackground(background, id, by)),
		// Reports still inside their batching window go out now: a held headless run hands them to its next turn.
		settle: () => Promise.all([...background.values()].map((entry) => entry.done)).then(() => runs.reports.flush()),
		background: () => background.size,
		running: () => [...runs.foreground.keys(), ...background.keys()],
		stopAll,
		command: agentsCommand(team, background, runs.foreground, questions),
	};
}
