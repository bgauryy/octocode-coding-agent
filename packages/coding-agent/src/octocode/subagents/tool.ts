import type { RunDetails } from "./run-types.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { withIdentity } from "../instructions/task.ts";
import type { Permission } from "../permission/ask.ts";
import { assignmentText, parentArchive } from "./identity-reminder.ts";
import { type Subcommand, notify } from "../shared/commands.ts";
import { timedTool } from "../shared/render/rows.ts";
import { modelLookup, settleWithin, textResult } from "../shared/util.ts";
import { UserQuestions } from "../team/asks.ts";
import { getMcpSessionHandoff } from "../../../../mcp/src/session-servers.ts";
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
import { SUBAGENT_STOP_GRACE_MS, type SubagentOutcome } from "./process/outcome.ts";
import { buildAgentArgs, type ChildSession, childSession } from "./process/session.ts";
import { type AgentProfile, askSpawn } from "./profiles.ts";
import { startGate } from "./rate-gate.ts";
import { staggeredLaunch } from "./stagger.ts";
import { admitResultSchema } from "./result-schema.ts";
import type { RelayHost } from "./relay.ts";
import { registerAgentMessageRenderer, renderAgentCall, renderAgentResult } from "./render.ts";
import { startNotices } from "./start-notices.ts";
import { pendingRefs, recordWorktreePid } from "./worktree.ts";
import { agentToolSpec } from "./agent-tool.ts";
import { FORK_NOTE_TYPE, forkNote, resumableChild, resumedTask, resumeText } from "./children.ts";
import { Isolation } from "./isolation.ts";
import { finishChildNotes } from "./child-tasks.ts";
import { itemLink } from "./item-link.ts";
import { routeSummary } from "./model.ts";
import { PERMISSION_STOP } from "./report-text.ts";
import { runForeground, startBackground } from "./run-execution.ts";
import { childCacheGroup, taskSkillPlan, taskSkillText } from "./task-skills.ts";
import { childTaskInput, taskReferences } from "./task-text.ts";
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
	/** Stop background agents and wait for their reports before shutdown. */
	stopAll(reason?: string): Promise<void>;
	/** Follow-up windows any session holds open for finished children (they live in session folders, not in memory). */
	parked: typeof Lingering.parkedChildren;
	/** `/agents`: list agents, tell, kill, merge; `index.ts` registers it and its `/agents` shortcut. */
	command: Subcommand;
}

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
	const runs: AgentRuns = {
		api,
		team,
		background: new Map(),
		foreground: new Map(),
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
		...(ctx.hasUI ? { ui: ctx.ui } : {}),
	});
	permission.onRevoke(() => {
		cancelLaunches();
		void stopRuns(PERMISSION_STOP);
	});
	api.on("agent_settled", async () => late.take());
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
		if (forked)
			void api.sendMessage(
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
		void startNotices(event, ctx)
			.then((notes) => {
				for (const note of notes) if (ctx.hasUI) notify(ctx.ui, note.text, note.level);
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
				// A continued child is one this session recorded, on its own transcript and profile (`children.ts`).
				const resumed = params.resume
					? resumableChild(ctx.sessionManager.getEntries(), params.resume, new Set(runs.running.keys()))
					: undefined;
				if (resumed && params.isolate)
					throw new Error("resume continues a child in this tree; isolate does not apply.");
				// Refusals first (an item this session does not hold, unknown profile, unavailable model), then a slot, then the
				// spawn ask: the user is never asked for a run that cannot start, and a denied spawn claims and starts nothing.
				const linked = itemLink(ctx, params.item);
				const plan = planRun(
					getProfiles(),
					resumed ? resumedTask(params, resumed.child, ctx.modelRegistry.getAvailable()) : params,
					ctx,
					getRefused?.(),
				);
				const skillPlan = taskSkillPlan(plan.profile, params.skills, api.getCommands());
				const skillResources = api.getSkillResourceSnapshot(skillPlan.names);
				const artifactAccess = plan.profile?.lean ? "none" : "local";
				const referenced = await taskReferences(params.task, team, ctx, artifactAccess);
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
						api.getSettings().defaultTools,
						{ toolCallId: id, goal },
					);
					// An isolated run's name must not repeat a saved ref: `/agents merge <name>` would be ambiguous.
					const refs = params.isolate ? await pendingRefs(ctx.cwd) : [];
					launchSignal.throwIfAborted();
					claimed = claimRun(
						runs,
						plan,
						{ ...params, goal, name: resumed?.child.id, sessionId: resumed?.session.id },
						ctx,
						refs,
					);
					if (resumed) lingering.forget(resumed.child.id);
				} finally {
					if (!claimed) runs.slots.give();
				}
				const run = claimed;
				const isolation = new Isolation(run.identity.id, linked?.ref);
				let finalized: Promise<string> | undefined;
				// With the report's outcome (the success paths), the item the child worked on gets the report noted on it.
				const finish = (outcome?: SubagentOutcome) =>
					(finalized ??= finishChildNotes(ctx, isolation, linked, outcome, run.identity.id).finally(run.release));
				let handedOff = false;
				// From the claim on, every failure goes through `finish`: the slot and the name are given back.
				try {
					if (resultContract) run.identity.resultContract = resultContract;
					if (linked) run.identity.item = linked.ref;
					// A lean child reads its skills inlined in the task; it loads none itself.
					if (!skillPlan.inline) run.identity.skillResources = skillResources;
					run.identity.skillsInTask = skillPlan.inTask;
					// Servers the model added with `mcp` (the user confirmed each), and the ones it stopped, reach the child as a transient file.
					const { servers: addedServers, stopped } = getMcpSessionHandoff(api.events);
					if (Object.keys(addedServers).length > 0) run.identity.mcpServers = addedServers;
					if (stopped.length > 0) run.identity.mcpStopped = stopped;
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
					const archive = parentArchive();
					const told = resumeText(resumed, params.task);
					const skillText = skillPlan.inTask && !told.prefix ? taskSkillText(skillResources, skillPlan.inline) : "";
					const parts = { referenced, browserMode: run.profile?.headless, skillText, resultContract };
					const assigned = { ...run.identity, background: params.background === true, why: params.reason };
					const own = withIdentity(`${told.prefix}${childTaskInput(told.text, parts)}`, assigned, archive);
					run.identity.assignment = assignmentText(assigned, archive, parts, skillPlan.inline); // re-read after compacting
					const task = run.identity.collaborate ? joinTeam(runs, run, own) : own;
					const session = resumed?.session ?? childSession(run.identity);
					const details = runDetails(run, session);
					const track = tracker(run.identity, details, modelLookup(ctx), ctx);
					// Only a background run that is not isolated (its worktree is gone) can stay reachable for a follow-up: for the linger setting, and after a `blocked` report whatever it is.
					const lingers = params.background === true && !params.isolate;
					const args = buildAgentArgs(run.profile, run.route.model, session, [], run.route.thinking);
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
					const prefix = childCacheGroup(run, skillPlan, ctx.sessionManager.getSessionId());
					const staggered = staggeredLaunch(prefix, run.identity.cacheTtlMs, launch);
					const stopping = () => {
						details.stopping = true;
						onUpdate?.({ content: [{ type: "text", text: "stopping…" }], details: { ...details } });
					};
					if (!params.background)
						return await runForeground(
							runs,
							run,
							details,
							staggered(onUpdate),
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
						staggered(),
						finish,
						ctx.sessionManager.getSessionId(),
						lingers ? lingering.window(run, ctx) : undefined,
					);
					handedOff = true;
					details.status = "background";
					return textResult(
						`Started ${run.identity.id} (${run.identity.role}: ${goal}) in the background; its report arrives as a message. Runs on ${routeSummary(run.route)}.${warning}`,
						details,
					);
				} finally {
					// A failure before the run started still removes the worktree.
					if (!handedOff) await finish();
				}
			},
			renderCall: renderAgentCall,
			renderResult: renderAgentResult,
		}),
	);
	team.setResumer((id, text, from, signal, request) => lingering.resume(id, text, from, signal, request));
	return {
		// A lingering run has nothing running: stopping it ends its window.
		stop: (id, by) => (lingering.forget(id) ? undefined : stopBackground(background, id, by)),
		// Reports still inside their batching window go out now: a held headless run hands them to its next turn.
		settle: () => Promise.all([...background.values()].map((entry) => entry.done)).then(() => runs.reports.flush()),
		background: () => background.size,
		running: () => [...runs.foreground.keys(), ...background.keys()],
		stopAll,
		parked: Lingering.parkedChildren,
		command: agentsCommand(team, background, runs.foreground, questions),
	};
}
