import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import type { Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { withIdentity } from "../instructions/task.ts";
import type { Permission } from "../permission/ask.ts";
import { assignmentText, parentArchive } from "./identity-reminder.ts";
import { modelLookup, textResult } from "../shared/util.ts";
import { getMcpSessionHandoff } from "../../../../mcp/src/session-servers.ts";
import { checkGoal } from "../team/identity.ts";
import { launchOverlap } from "../team/overlap.ts";
import { type AgentRuns, claimRun, planRun, type Run } from "./claim.ts";
import type { Lingering } from "./linger.ts";
import { runSubagent } from "./process.ts";
import type { SubagentOutcome } from "./process/outcome.ts";
import { buildAgentArgs, type ChildSession, childSession } from "./process/session.ts";
import { type AgentProfile, askSpawn } from "./profiles.ts";
import { startGate } from "./rate-gate.ts";
import { staggeredLaunch } from "./stagger.ts";
import { admitResultSchema } from "./result-schema.ts";
import type { RelayHost } from "./relay.ts";
import { awaitSiblings, planReservation, type ReservationPlan, takeReservation, waitingText } from "./reservation.ts";
import { pendingRefs, recordWorktreePid } from "./worktree.ts";
import { REF_PREFIX } from "./worktree-base.ts";
import { worktreeName } from "../worktree-paths/member-worktree.ts";
import type { agentToolSpec } from "./agent-tool.ts";
import { resumableChild, resumedTask, resumeText } from "./children.ts";
import { Isolation } from "./isolation.ts";
import { nestingRefusal } from "./process/child-env.ts";
import { finishChildNotes } from "./child-tasks.ts";
import { itemLink } from "./item-link.ts";
import { routeSummary } from "./model.ts";
import { runForeground, startBackground } from "./run-execution.ts";
import type { RunDetails } from "./run-types.ts";
import { spawnRefusal } from "./spawn-limits.ts";
import { childCacheGroup, taskSkillPlan, taskSkillText, withRoleSkills } from "./task-skills.ts";
import { childTaskInput, taskReferences } from "./task-text.ts";
import { resolveTaskServers } from "./task-servers.ts";
import { type AgentUpdate, runDetails, tracker, waitingUpdate } from "./tracking.ts";

/** What starting a subagent reads of the `agent` tool's registration (`tool.ts`). */
export interface SpawnEnv {
	api: ExtensionAPI;
	runs: AgentRuns;
	permission: Permission;
	getProfiles: () => Map<string, AgentProfile>;
	getRefused?: () => ReadonlyMap<string, string>;
	lingering: Lingering;
	/** Live agent and goal pairs the launch result already named (`team/overlap.ts`): each is named once. */
	overlapWarned: Set<string>;
	/** The caller's signal joined with the one a permission change or shutdown aborts. */
	withLaunch: (signal?: AbortSignal) => AbortSignal;
	/** Runs `work` and, once it ends, records the run's session file and its questions to this session's agent. */
	record: <T>(run: Run, details: RunDetails, session: ChildSession, work: Promise<T>) => Promise<T>;
	relayHost: (ctx: Pick<ExtensionContext, "hasUI" | "ui">) => RelayHost;
}

type AgentParams = Static<ReturnType<typeof agentToolSpec>["parameters"]>;

/**
 * One `agent` task call. A foreground call past the limit waits for a slot, its row saying so. A background call past it
 * returns its id at once and takes the slot detached, tied to the session rather than this turn: the batch that fanned it
 * out would otherwise hold the parent deaf to reports and questions until all but the last few had launched.
 */
export async function spawnAgent(
	env: SpawnEnv,
	id: string,
	params: AgentParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentUpdate | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<RunDetails>> {
	const { api, runs, permission, lingering } = env;
	const { team } = runs;
	const launchSignal = env.withLaunch(signal);
	launchSignal.throwIfAborted();
	const tooDeep = nestingRefusal();
	if (tooDeep) throw new Error(tooDeep);
	if (params.workingCopy && !params.isolate) throw new Error("workingCopy requires isolate: true.");
	const resultContract = params.resultSchema === undefined ? undefined : admitResultSchema(params.resultSchema);
	// A continued child is one this session recorded, on its own transcript and profile (`children.ts`).
	const resumed = params.resume
		? resumableChild(ctx.sessionManager.getEntries(), params.resume, new Set(runs.running.keys()))
		: undefined;
	// A continued child keeps its recorded goal unless the call names a new one.
	const goal = checkGoal(params.goal ?? resumed?.child.goal);
	if (resumed && params.isolate) throw new Error("resume continues a child in this tree; isolate does not apply.");
	const refuseOverSpend = () => {
		const refusal = spawnRefusal(api.getSettings().subagents, ctx.sessionManager.getEntries(), runs, resumed?.child.id);
		if (refusal) throw new Error(refusal);
	};
	refuseOverSpend();
	// Refusals first (an item this session cannot hold, unknown profile, unavailable model), then a slot, then the
	// spawn ask: the user is never asked for a run that cannot start, and a refused or denied spawn claims nothing.
	const linked = itemLink(ctx, params.item);
	// One child per item: a second one would race the first on its paths and its completion. A child that reported and
	// stays reachable still owns it, since a message continues it; the call that resumes that child passes.
	const refuseSecondChild = () => {
		if (!linked) return;
		for (const [child, ref] of runs.items)
			if (ref === linked.ref && child !== resumed?.child.id && runs.running.has(child))
				throw new Error(`${ref} is being worked on by ${child}: message or resume it, or wait for its report.`);
		const parked = lingering.onItem(linked.ref);
		if (parked !== undefined && parked !== resumed?.child.id)
			throw new Error(
				`${linked.ref} is with ${parked}, which reported and stays reachable: resume it (\`resume\` ${parked}), or end it with \`coordinate\` action \`stop\` first.`,
			);
	};
	refuseSecondChild();
	const plan = planRun(
		env.getProfiles(),
		resumed ? resumedTask(params, resumed.child, ctx.modelRegistry.getAvailable()) : params,
		ctx,
		env.getRefused?.(),
	);
	// An unknown or disabled server name refuses the task before it claims anything.
	const taskServers =
		params.mcp === undefined
			? undefined
			: resolveTaskServers(api.events, params.mcp, plan.profile, resumed !== undefined);
	let reserving = planReservation(team, plan.profile, params);
	const replan = () => planReservation(team, plan.profile, params);
	// A foreground start tells its row what it waits for; a background one says so in its result.
	const waitingRow = (waiting: ReservationPlan) => {
		const row = waitingUpdate(params.profile, goal, 0);
		onUpdate?.({ ...row, content: [{ type: "text", text: waitingText(waiting) }] });
	};
	const skillPlan = taskSkillPlan(plan.profile, params.skills, api.getCommands());
	const skillResources = api.getSkillResourceSnapshot(skillPlan.names);
	const artifactAccess = plan.profile?.lean ? "none" : "local";
	const referenced = await taskReferences(params.task, team, ctx, artifactAccess);
	const slot = { held: false };
	if (params.background) {
		// A child just failed on a rate limit (`rate-gate.ts`): the next start would meet it too, so this one queues as well.
		// So does one that waits for the reservations of a running child: it holds no slot and no lease until then.
		slot.held = startGate.remainingMs() === 0 && reserving.waitOn.length === 0 && runs.slots.tryTake();
	} else {
		// Before a slot: a start that waits for a sibling's paths must not keep others from theirs.
		reserving = await awaitSiblings(team, reserving, replan, launchSignal, waitingRow, (clear) => clear);
		await startGate.wait(launchSignal);
		await runs.slots.take(launchSignal, (running) => onUpdate?.(waitingUpdate(params.profile, goal, running)));
		slot.held = true;
	}
	let claimed: Run | undefined;
	let grants: Awaited<ReturnType<typeof askSpawn>>;
	try {
		grants = await askSpawn(permission, ctx, plan.profile, params.task, launchSignal, api.getSettings().defaultTools, {
			toolCallId: id,
			goal,
		});
		// An isolated run's name must not repeat a saved ref: `/agents merge <name>` would be ambiguous.
		const refs = params.isolate ? await pendingRefs(ctx.cwd) : [];
		launchSignal.throwIfAborted();
		// Siblings started while the user was asked (or a slot waited for) now hold paths: from here to the claim nothing
		// awaits, so what this finds is what the claim reserves against.
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
		// Parallel calls of one batch all passed the first check, and a foreground call may have waited long for its slot.
		refuseOverSpend();
		refuseSecondChild();
		// The item is claimed only now: everything that could refuse the call has passed.
		linked?.claim();
		claimed = claimRun(
			runs,
			plan,
			{ ...params, goal, name: resumed?.child.id, sessionId: resumed?.session.id },
			ctx,
			refs,
			undefined,
			slot,
		);
		if (resumed) lingering.forget(resumed.child.id);
	} finally {
		if (!claimed && slot.held) runs.slots.give();
	}
	const run = claimed;
	const queued = !slot.held;
	const isolation = new Isolation(run.identity.id, linked?.ref);
	let finalized: Promise<string> | undefined;
	/** A queued run's worktree warning, which came too late for the start result. */
	let lateNote = "";
	// With the report's outcome (the success paths), the item the child worked on gets the report noted on it; `lingers`: the child stays reachable after it.
	const finish = (outcome?: SubagentOutcome, lingers?: boolean) =>
		(finalized ??= finishChildNotes(ctx, isolation, linked, outcome, run.identity.id, lingers)
			.then((note) => {
				// A background report carrying a graph notice wakes the parent for it (`graph-wake.ts`).
				if (params.background && linked?.notice) runs.graph?.mark(run.identity.id, linked.notice);
				return `${note}${lateNote}`;
			})
			.finally(() => {
				runs.live.delete(run.identity.id);
				run.release();
			}));
	let handedOff = false;
	// From the claim on, every failure goes through `finish`: the slot and the name are given back.
	try {
		const waitsForSiblings = reserving.waitOn.length > 0;
		const reserved = waitsForSiblings ? `\n\n(${waitingText(reserving)}.)` : takeReservation(team, run, reserving);
		if (resultContract) run.identity.resultContract = resultContract;
		if (linked) {
			run.identity.item = linked.ref;
			runs.items.set(run.identity.id, linked.ref);
		}
		// A lean child reads its skills inlined in the task; it loads none itself.
		if (!skillPlan.inline) run.identity.skillResources = skillResources;
		run.identity.skillsInTask = skillPlan.inTask;
		run.profile = withRoleSkills(run.profile, skillPlan.roleSkills, skillResources);
		// Servers the model added with `mcp` (the user confirmed each), and the ones it stopped, reach the child as a transient file.
		const { servers: addedServers, stopped } = getMcpSessionHandoff(api.events);
		const inherited = taskServers?.servers ?? addedServers;
		if (Object.keys(inherited).length > 0) run.identity.mcpServers = inherited;
		if (stopped.length > 0) run.identity.mcpStopped = stopped;
		if (taskServers) {
			run.identity.mcpOnly = taskServers.only;
			run.identity.mcpNamed = taskServers.named;
		}
		// A child cannot ask anyone, so it gets the mode, the reach the user's spawn approval named (for the whole run: that
		// approval is the consent, `askSpawn`) and every kind the user allowed for this session. Never a class that always asks.
		run.identity.permission = {
			mode: permission.mode,
			grants: [...new Set([...grants, ...permission.childGrants()])],
		};
		// With a person to ask, the child's approval dialogs come here (this tool exists only in the main session).
		run.identity.relay = ctx.hasUI;
		if (!params.background) run.identity.parentWaits = true;
		const host = env.relayHost(ctx);
		const session = resumed?.session ?? childSession(run.identity);
		const details = runDetails(run, session);
		runs.live.set(run.identity.id, details);
		const track = tracker(run.identity, details, modelLookup(ctx), ctx);
		// Only a background run that is not isolated (its worktree is gone) can stay reachable for a follow-up: for the linger setting, and after a `blocked` report whatever it is.
		const lingers = params.background === true && !params.isolate;
		const args = buildAgentArgs(run.profile, run.route.model, session, [], run.route.thinking, run.identity.mcpNamed);
		const prefix = childCacheGroup(run, skillPlan, ctx.sessionManager.getSessionId());
		const notes = `${run.teamNote}${reserved}${launchOverlap(team, run.identity.id, goal, env.overlapWarned)}`;
		/** The part of a start that needs its slot: a worktree exists only for a run that can use it, and the teammates are those of the moment it starts. */
		const begin = async (beginSignal: AbortSignal) => {
			const cwd = params.isolate ? await isolation.start(ctx, run.identity, params.workingCopy, beginSignal) : ctx.cwd;
			beginSignal.throwIfAborted();
			const worktree = isolation.worktree;
			const onSpawn = worktree ? (pid: number) => recordWorktreePid(worktree, pid) : undefined;
			const archive = parentArchive();
			const told = resumeText(resumed, params.task);
			const skillText = told.prefix || !skillPlan.inTask ? "" : taskSkillText(skillResources, skillPlan.inline);
			const parts = { referenced, browserMode: run.profile?.headless, skillText, resultContract };
			const assigned = { ...run.identity, background: params.background === true, why: params.reason };
			const own = withIdentity(`${told.prefix}${childTaskInput(told.text, parts)}`, assigned, archive);
			run.identity.assignment = assignmentText(assigned, archive, parts, skillPlan.inline); // re-read after compacting
			const task = own;
			const launch = (runSignal: AbortSignal | undefined, update: AgentUpdate | undefined, warm?: () => void) => {
				const tracked = track(update);
				const progress: typeof tracked = (change) => {
					if (change.responding) warm?.();
					tracked(change);
				};
				return env.record(
					run,
					details,
					session,
					runSubagent(task, args, cwd, run.profile, run.identity, runSignal, progress, onSpawn, undefined, host),
				);
			};
			return {
				staggered: staggeredLaunch(prefix, run.identity.cacheTtlMs, launch),
				warning: worktree?.warning ? `\n\n${worktree.warning}` : "",
			};
		};
		const window = lingers ? lingering.window(run, ctx) : undefined;
		const sessionId = ctx.sessionManager.getSessionId();
		if (queued) {
			const whenFree = async (queueSignal: AbortSignal) => {
				if (waitsForSiblings) {
					// Leases first, then the slot: the run holds no lease while it waits here, and takes them in one step.
					lateNote = await awaitSiblings(team, reserving, replan, queueSignal, undefined, (clear) =>
						takeReservation(team, run, clear),
					);
				}
				await startGate.wait(queueSignal);
				await runs.slots.take(queueSignal);
				slot.held = true;
				queueSignal.throwIfAborted();
				const started = await begin(queueSignal);
				lateNote = `${lateNote}${started.warning}`;
				details.startedAt = Date.now();
				delete details.queued;
				return started.staggered()(queueSignal);
			};
			startBackground(runs, run, details, params.task, whenFree, finish, sessionId, window);
			handedOff = true;
			details.status = "background";
			details.queued = true;
			return textResult(
				`Queued ${run.identity.id} (${run.identity.role}: ${goal}) in the background: ${waitsForSiblings ? "it holds no paths yet: it waits for the children holding them, then for a slot" : `${runs.running.size - 1} subagents are ahead of it or running, and it starts when a slot frees`}. Its report arrives as a message. Runs on ${routeSummary(run.route)}.${notes}`,
				details,
			);
		}
		const started = await begin(launchSignal);
		const warning = `${started.warning}${notes}`;
		const stopping = () => {
			details.stopping = true;
			onUpdate?.({ content: [{ type: "text", text: "stopping…" }], details: { ...details } });
		};
		if (!params.background)
			return await runForeground(
				runs,
				run,
				details,
				started.staggered(onUpdate),
				finish,
				warning,
				launchSignal,
				stopping,
			);
		startBackground(runs, run, details, params.task, started.staggered(), finish, sessionId, window);
		handedOff = true;
		details.status = "background";
		return textResult(
			`Started ${run.identity.id} (${run.identity.role}: ${goal}) in the background; its report arrives as a message. Runs on ${routeSummary(run.route)}.${isolation.worktree ? ` Works in its own worktree ${worktreeName(isolation.worktree.path)}, removed when it ends; its result lands on ${REF_PREFIX}${run.identity.id}.` : ""}${warning}`,
			details,
		);
	} finally {
		// A failure before the run started still removes the worktree.
		if (!handedOff) await finish();
	}
}
