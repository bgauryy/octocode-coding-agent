import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import type { Static } from "typebox";
import type { FeatureContext } from "../../core/features/index.ts";
import { withIdentity } from "../native/prompts/task.ts";
import { assignmentText, parentArchive } from "./identity-reminder.ts";
import { modelLookup, textResult } from "../shared/util.ts";
import { configureIdentity } from "./run-identity.ts";
import { checkGoal } from "../team/identity.ts";
import { launchOverlap } from "../team/overlap.ts";
import { claimRun, planRun, type Run } from "./claim.ts";
import { runSubagent } from "./process.ts";
import { buildRouteArgs, childSession } from "./process/session.ts";
import { forkedContext, writeForkedSession } from "./context-fork.ts";
import { askSpawn } from "./profiles.ts";
import { spawnStillAllowed } from "./spawn-recheck.ts";
import { startGate } from "./rate-gate.ts";
import { type StaggerTurn, staggeredLaunch } from "./stagger.ts";
import { admitResultSchema } from "./result-schema.ts";
import { awaitSiblings, planReservation, type ReservationPlan, takeReservation, waitingText } from "./reservation.ts";
import { pendingRefs, recordWorktreePid } from "./worktree.ts";
import type { agentToolSpec } from "../native/tools/agent/spec.ts";
import { resumeChild, resumedTask, resumeText } from "./children.ts";
import { Isolation } from "./isolation.ts";
import { refuseLinkedIsolation } from "./worktree-create.ts";
import { nestingRefusal } from "./process/child-env.ts";
import { createChildFinish } from "./run-finish.ts";
import {
	chainHandoff,
	chainPlan,
	type QueuedRun,
	queuedResult,
	queuedText,
	queueRun,
	startedText,
	startHeld,
} from "./spawn-chain.ts";
import { holdItem, refuseLeanItem, refuseSecondChild as refuseSecond } from "./second-child.ts";
import { runRunnerChild } from "./runner-child.ts";
import type { SpawnEnv } from "./spawn-env.ts";
import { runnerOf, runnerPlan } from "./runner-task.ts";
import { foregroundHandOver } from "./foreground-handover.ts";
import { reportInFlight, runForeground, startBackground } from "./run-execution.ts";
import type { RunDetails } from "./run-types.ts";
import { refuseOverLimit } from "./spawn-limits.ts";
import { childCacheGroup, taskSkillPlan, taskSkillText } from "./task-skills.ts";
import { childTaskInput, taskReferences } from "./task-text.ts";
import { withItems } from "./task-items.ts";
import { resolveTaskServers } from "./task-servers.ts";
import { joinTeamPatiently } from "./team-join.ts";
import { type AgentUpdate, runDetails, tracker, waitingUpdate } from "./tracking.ts";

type AgentParams = Static<ReturnType<typeof agentToolSpec>["parameters"]>;
/**
 * One `agent` task call. Foreground calls past the limit wait for a slot; background calls claim detached; foreground calls
 * exceeding the foreground budget hand over to the background unless `holdTurn` is set.
 */
export async function spawnAgent(
	env: SpawnEnv,
	id: string,
	params: AgentParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentUpdate | undefined,
	ctx: FeatureContext,
	mail = false,
	holdTurn = false,
): Promise<AgentToolResult<RunDetails>> {
	const { api, runs, permission, lingering } = env;
	const team = runs.team;
	const generation = runs.session;
	const current = () => generation === runs.session;
	const launchSignal = env.withLaunch(signal);
	const joined = await joinTeamPatiently(team); // first, so one batch's calls still check and claim in order
	launchSignal.throwIfAborted();
	const tooDeep = nestingRefusal();
	if (tooDeep) throw new Error(tooDeep);
	if (params.isolate) refuseLinkedIsolation(ctx.cwd);
	if (params.workingCopy && !params.isolate) throw new Error("workingCopy requires isolate: true.");
	const resultContract = params.resultSchema === undefined ? undefined : admitResultSchema(params.resultSchema);
	const startedHeld = params.resume ? startHeld(runs, params.resume) : undefined;
	if (startedHeld) return startedHeld;
	// A continued child is one this session recorded (`children.ts`); it keeps its goal unless the call names a new one.
	const resumed = params.resume ? resumeChild(ctx, params.resume, runs) : undefined;
	if (resumed && params.isolate) throw new Error("resume continues a child in this tree; isolate does not apply.");
	const forked = forkedContext(params, ctx.sessionManager); // frozen at dispatch: a queued child too
	const refuseOverSpend = () => refuseOverLimit(api, ctx, runs, resumed?.child.id);
	refuseOverSpend();
	// Refusals first (an item this session cannot hold, unknown profile, unavailable model), then a slot, then the
	// spawn ask: the user is never asked for a run that cannot start, and a refused or denied spawn claims nothing.
	const { linked, after, handoff } = chainPlan(runs, api.settings.get(), params, ctx, resumed !== undefined);
	const goal = checkGoal(params.goal ?? resumed?.child.goal ?? linked?.title); // an item's title names the work
	const chained = after.length > 0;
	// One child per item (`second-child.ts`); the call that resumes a child passes for it.
	const refuseSecondChild = (self?: string) => refuseSecond(runs, lingering, linked, [resumed?.child.id, self]);
	refuseSecondChild();
	const runner = runnerOf(params.runner, resumed?.child);
	const plan = runner
		? runnerPlan({ ...params, runner }, env.runners)
		: planRun(
				env.getProfiles(),
				resumed ? resumedTask(params, resumed.child, ctx.modelRegistry.getAvailable()) : params,
				ctx,
				env.getRefused?.(),
				api.settings.get().limits,
			);
	refuseLeanItem(plan.profile, linked);
	// An unknown or disabled server name refuses the task before it claims anything. A resumed child is planned the same
	// way: its first start's list is not recorded, so a server its task named is named again on resume.
	const taskServers = resolveTaskServers(api.channels, params.mcp, plan.profile);
	let reserving = planReservation(team, plan.profile, params);
	const replan = () => planReservation(team, plan.profile, params);
	const waitingRow = (waiting: ReservationPlan) => {
		const row = waitingUpdate(params.profile, goal, 0);
		onUpdate?.({ ...row, content: [{ type: "text", text: waitingText(waiting) }] });
	};
	const skillPlan = taskSkillPlan(plan.profile, params.skills, api.resources.getCommands());
	// The named skills are checked (unknown, ambiguous and model-barred names fail here); a lean child reads only those,
	// any other child inherits the whole list its `skill` tool declares.
	const namedSkills = skillPlan.names && api.resources.getSkillResourceSnapshot(skillPlan.names);
	const skillResources = skillPlan.inline && namedSkills ? namedSkills : api.resources.getSkillResourceSnapshot();
	const artifactAccess = plan.profile?.lean ? "none" : "local";
	const unhold = holdItem(runs, linked, id); // before any await, so one batch's calls hold their items in call order
	// Held in the turn of the `chainPlan` check (nothing awaits between), so calls started together see each other's place.
	const place = chained ? runs.chain!.reserve(linked?.ref, after) : undefined;
	const slot = { held: false };
	const held = startGate.holds(plan.route); // a slot goes to this start only once its provider is not cooling down
	let referenced = "";
	let claimed: Run | undefined;
	let grants: Awaited<ReturnType<typeof askSpawn>>;
	let approvedVia: string | undefined;
	try {
		referenced = withItems(await taskReferences(params.task, team, ctx, artifactAccess), params, ctx);
		// A child that starts at once still gets the results of prerequisites that ended before the call.
		if (!chained)
			referenced = [referenced, await chainHandoff(runs, handoff, ctx, artifactAccess)].filter(Boolean).join("\n\n");
		if (params.background) {
			// Its provider cools down from a rate limit (`rate-gate.ts`): the start would meet it too, so this one queues.
			// So does one that waits for the reservations of a running child: it holds no slot and no lease until then.
			slot.held = !chained && reserving.waitOn.length === 0 && runs.slots.tryTake(held);
		} else {
			// Before a slot: a start that waits for a sibling's paths must not keep others from theirs.
			reserving = await awaitSiblings(team, reserving, replan, launchSignal, waitingRow, (clear) => clear);
			await runs.slots.take(launchSignal, (running) => onUpdate?.(waitingUpdate(params.profile, goal, running)), held);
			slot.held = true;
		}
		grants = await askSpawn(permission, ctx, plan.profile, params.task, launchSignal, api.settings.get().defaultTools, {
			toolCallId: id,
			goal,
			apps: params.apps,
			answered: (via) => (approvedVia = via),
		});
		const refs = params.isolate ? await pendingRefs(ctx.cwd) : []; // an isolated name repeating one: merge is ambiguous
		launchSignal.throwIfAborted();
		// Siblings started meanwhile hold paths; past this loop nothing awaits, so the claim reserves against what it finds.
		reserving = replan();
		while (reserving.waitOn.length > 0 && !params.background) {
			waitingRow(reserving);
			await team.childLeases.released(reserving.waitOn, launchSignal);
			reserving = replan();
		}
		if (reserving.waitOn.length > 0 && slot.held) {
			runs.slots.give();
			slot.held = false;
		}
		// Spend and children changed while this call waited; the item is claimed once the run is (a queued child: when it starts).
		refuseOverSpend();
		refuseSecondChild();
		claimed = claimRun(
			runs,
			plan,
			{
				...params,
				goal,
				name: resumed?.child.id,
				sessionId: resumed?.session.id,
				// A resumed child keeps the hook mode its earlier call named unless this call names one.
				hooks: params.hooks ?? resumed?.child.hooks,
			},
			ctx,
			refs,
			undefined,
			slot,
			joined,
		);
		if (resumed) lingering.forget(resumed.child.id);
		runs.groups.join(claimed.identity.id, params.background === true);
	} finally {
		unhold();
		if (!claimed) place?.();
		if (!claimed && slot.held) runs.slots.give();
	}
	const run = claimed;
	const queued = !slot.held;
	const isolation = new Isolation(run.identity.id, linked?.ref, resumed?.worktree);
	/** A queued run's worktree warning, which came too late for the start result. */
	let lateNote = "";
	/** The run's place in the queue of children waiting for prerequisites. */
	let queuedChild: QueuedRun | undefined;
	let detailsRef: RunDetails | undefined;
	const isBackground = () => params.background === true || detailsRef?.status === "background";
	const finish = createChildFinish({
		ctx,
		runs,
		run,
		isolation,
		linked,
		current,
		isBackground,
		lateNote: () => lateNote,
		onFinally: () => queuedChild?.finish(),
	});
	let handedOff = false;
	// Failures go through `finish`. The item: registered before the reservation (one batch, one child), claimed after it.
	const waitsForSiblings = reserving.waitOn.length > 0;
	try {
		configureIdentity(run, runs, api, permission, ctx, {
			resultContract,
			linked,
			skillPlan,
			skillResources,
			taskServers,
			grants,
			background: params.background,
		});
		const reserved = chained
			? ""
			: waitsForSiblings
				? `\n\n(${waitingText(reserving)}.)`
				: await takeReservation(team, run, reserving, launchSignal);
		if (!chained && linked) await linked.claim(launchSignal);
		const host = env.relayHost(ctx);
		const session = resumed && !resumed.runnerSession ? resumed.session : childSession(run.identity);
		const details = runDetails(run, session);
		detailsRef = details;
		run.identity.runId = details.runId;
		runs.live.set(run.identity.id, details);
		const tracking = tracker(run.identity, details, modelLookup(ctx), ctx);
		// A background or handed-over non-isolated run can stay reachable for a follow-up; a runner's conversation lives in its own CLI.
		const isolated = params.isolate === true || resumed?.worktree !== undefined;
		const canLinger = !runner && !isolated;
		const lingers = canLinger && params.background === true;
		const args = buildRouteArgs(run.profile, run.route, session, run.identity.mcpNamed);
		const prefix = childCacheGroup(run, run.model);
		const notes = `${run.teamNote}${reserved}${launchOverlap(team, run.identity.id, goal, env.overlapWarned)}`;
		/** The part of a start that needs its slot: a worktree exists only for a run that can use it, and the teammates are those of the moment it starts. */
		const begin = async (beginSignal: AbortSignal) => {
			const cwd = isolated ? await isolation.start(ctx, run.identity, params.workingCopy, beginSignal) : ctx.cwd;
			beginSignal.throwIfAborted();
			if (forked) writeForkedSession(session, cwd, sessionId, forked);
			const worktree = isolation.worktree;
			const onSpawn = worktree ? (pid: number) => void recordWorktreePid(worktree, pid) : undefined;
			const archive = parentArchive();
			const told = resumeText(resumed, params.task);
			const skillText = told.prefix || !namedSkills ? "" : taskSkillText(namedSkills, skillPlan.inline);
			const parts = { referenced, browserMode: run.profile?.headless, skillText, resultContract };
			const assigned = { ...run.identity, background: params.background === true, why: params.reason };
			const task = withIdentity(`${mail ? "" : told.prefix}${childTaskInput(told.text, parts)}`, assigned, archive);
			run.identity.assignment = assignmentText(assigned, archive, parts, skillPlan.inline); // re-read after compacting
			const launch = (runSignal: AbortSignal | undefined, update: AgentUpdate | undefined, turn: StaggerTurn) => {
				const tracked = tracking(update);
				const progress: typeof tracked = (change) => {
					if (!current()) return;
					if (change.responding) turn.warm();
					tracked(change);
				};
				const onRunner = async (name: string) => {
					const outcome = await runRunnerChild(env.runners!, {
						runner: name,
						model: params.model,
						// Referenced messages and reports, and the result contract, travel in the text: the runner reads nothing here.
						task: childTaskInput(params.task, { referenced, browserMode: undefined, skillText: "", resultContract }),
						cwd,
						identity: run.identity,
						signal: runSignal,
						onProgress: progress,
						onSpawn,
						ctx,
						team: runs.team,
						...(resumed?.runnerSession ? { resume: resumed.runnerSession } : {}),
					});
					details.billing = outcome.billing;
					if (outcome.runnerSession) details.runnerSession = outcome.runnerSession;
					else if (resumed?.runnerSession) details.runnerSession = resumed.runnerSession;
					return outcome;
				};
				const work = runner
					? onRunner(runner)
					: runSubagent({
							task,
							args,
							cwd,
							profile: run.profile,
							identity: run.identity,
							signal: runSignal,
							onProgress: progress,
							onSpawn,
							host,
							ready: turn.ready,
							exited: turn.lost,
							// A background (or handed-over) child that settled has its report in flight: sibling reports wait for it (`ReportQueue`).
							settled: () => {
								if (isBackground()) reportInFlight(runs, run.identity.id);
							},
							working: (probe) => runs.groups.working(run.identity.id, probe),
							workingChanged: () => runs.reports.reportingChanged(),
						});
				return env.record(run, details, session, tracking.withScreenshots(work));
			};
			return {
				staggered: staggeredLaunch(prefix, run.identity.cacheTtlMs, launch, run.identity.staggers === true && !runner),
				warning: worktree?.warning ? `\n\n${worktree.warning}` : "",
			};
		};
		const window = lingers ? lingering.window(run, ctx) : undefined;
		const sessionId = ctx.sessionManager.getSessionId();
		if (queued) {
			const whenFree = async (queueSignal: AbortSignal) => {
				if (queuedChild) {
					const handed = await queuedChild.start(queueSignal, ctx, artifactAccess);
					lateNote = handed.note;
					if (handed.referenced) referenced = [referenced, handed.referenced].filter(Boolean).join("\n\n");
				}
				if (waitsForSiblings || queuedChild) {
					// Leases first, then the slot: the run holds no lease while it waits here, and takes them in one step.
					lateNote += await awaitSiblings(team, reserving, replan, queueSignal, undefined, (clear) =>
						takeReservation(team, run, clear, queueSignal),
					);
				}
				await runs.slots.take(queueSignal, undefined, held);
				slot.held = true;
				queueSignal.throwIfAborted();
				const started = await begin(queueSignal);
				lateNote = `${lateNote}${started.warning}`;
				team.approvals.noteStarted(run.identity.id, (details.startedAt = Date.now()));
				delete details.queued;
				delete details.after;
				queuedChild?.started();
				return started.staggered()(queueSignal);
			};
			if (chained)
				queuedChild = queueRun(
					runs,
					run,
					{ goal, item: linked?.ref, after, handoff, details },
					() =>
						spawnStillAllowed(permission, ctx, plan.profile, params.task, api.settings.get().defaultTools, approvedVia),
					async (signal) => {
						reserving = replan();
						refuseOverSpend();
						refuseSecondChild(run.identity.id);
						await linked?.claim(signal);
					},
				);
			place?.(); // the child is in the queue now: it counts there
			startBackground(runs, run, details, params.task, whenFree, finish, sessionId, window);
			handedOff = true;
			details.status = "background";
			details.queued = true;
			if (chained) return queuedResult(runs, run, after, details, notes);
			return textResult(queuedText(runs, run, waitsForSiblings, notes), details);
		}
		const started = await begin(launchSignal);
		const warning = `${started.warning}${notes}`;
		if (!params.background) {
			const linger = canLinger ? lingering.window(run, ctx) : undefined;
			const onHandOver = () => host.budgets?.enableAsk(run.identity.id);
			const handing = foregroundHandOver(
				{ runs, run, details, task: params.task, finish, sessionId, warning, onUpdate, linger, onHandOver },
				holdTurn,
			);
			const launch = started.staggered(handing?.onUpdate ?? onUpdate);
			// A handed-over child still runs: its background run keeps the slot and worktree, and calls `finish` when it ends.
			return await runForeground(
				runs,
				run,
				details,
				launch,
				finish,
				warning,
				launchSignal,
				onUpdate,
				handing?.handOver,
			).finally(() => (handedOff = details.status === "background"));
		}
		startBackground(runs, run, details, params.task, started.staggered(), finish, sessionId, window);
		handedOff = true;
		details.status = "background";
		return textResult(startedText(run, isolation.worktree, warning), details);
	} finally {
		// A failure before the run started still removes the worktree, and leaves the step's group it joined.
		if (!handedOff) {
			place?.();
			runs.groups.leave(run.identity.id);
			runs.reports.reportingChanged();
			await finish();
		}
	}
}
