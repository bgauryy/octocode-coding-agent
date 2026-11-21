import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { FeatureSetup } from "../../core/features/index.ts";
import { openBacklog } from "../backlog/context.ts";
import type { Item } from "../backlog/item.ts";
import { STALL_MINUTES, type StallSubject, StallTracker } from "../graph/stall.ts";
import { attend } from "../monitor/attention/attend.ts";
import { STALLED_ITEM_TYPE, stalledItemAttention, stalledItemsText } from "../monitor/attention/stalled-items.ts";
import { runningWorkOf } from "../shared/running-work.ts";
import { isStaleSessionError } from "../shared/util.ts";
import type { Team } from "../team/session.ts";
import { itemKey } from "../wake/gate.ts";
import type { AgentRuns } from "./claim.ts";
import { servedItems } from "./handed-items.ts";

const TICK_MS = 60_000;

type Context = Parameters<typeof openBacklog>[0] & {
	ui: { notify(message: string, level: "warning"): void };
	isIdle(): boolean;
};

const WINDOW_MS = STALL_MINUTES * 60_000;

/** What `stallSubjects` reads; each port is the current value. */
export interface StallSources {
	/** Each running child with an item it works on (`servedItems`). */
	served: Iterable<[agent: string, ref: string]>;
	item(ref: string): Pick<Item, "ref" | "state" | "updatedAt"> | undefined;
	/** Normalized keys of the items a running background job serves. */
	jobs: ReadonlySet<string>;
	/** The child's last file change within the window, else 0. */
	lastEdit(agent: string): number;
	/** The child's last model or tool event; undefined once its process exited (or while it is queued). */
	lastOutput(agent: string): number | undefined;
}

/**
 * The delegated items to watch: each ongoing item a live child serves, with the latest of its own update (note, step,
 * claim), the child's last file change and, while a background job for it runs, now. A child whose process exited is
 * not named: what its run still does is the parent's work. A child that made a model or tool event within the window
 * works one item at a time, so only its most recently moved item is watched; its other items wait their turn.
 * One pass over the served pairs, one edit-log read per child.
 */
export function stallSubjects(sources: StallSources, now: number): StallSubject[] {
	const byAgent = new Map<string, StallSubject[]>();
	const edits = new Map<string, number>();
	for (const [agent, ref] of sources.served) {
		if (sources.lastOutput(agent) === undefined) continue;
		const item = sources.item(ref);
		if (!item || item.state !== "ongoing") continue;
		let edited = edits.get(agent);
		if (edited === undefined) edits.set(agent, (edited = sources.lastEdit(agent)));
		const lastProgressAt = sources.jobs.has(itemKey(item.ref) ?? item.ref) ? now : Math.max(item.updatedAt, edited);
		const list = byAgent.get(agent) ?? [];
		list.push({ ref: item.ref, agent, lastProgressAt });
		byAgent.set(agent, list);
	}
	const watched: StallSubject[] = [];
	for (const [agent, list] of byAgent) {
		const active = now - Math.max(sources.lastOutput(agent)!, edits.get(agent)!) < WINDOW_MS;
		if (!active || list.length === 1) watched.push(...list);
		else watched.push(list.reduce((latest, each) => (each.lastProgressAt > latest.lastProgressAt ? each : latest)));
	}
	return watched;
}

function subjects(
	api: FeatureSetup,
	team: Team,
	runs: Pick<AgentRuns, "running" | "items" | "handed">,
	ctx: Context,
	now: number,
): StallSubject[] {
	const jobs = new Set<string>();
	for (const row of runningWorkOf(api).all()) {
		const key = row.kind === "bash" ? itemKey(row.item) : undefined;
		if (key) jobs.add(key);
	}
	const { store } = openBacklog(ctx, { isSubagent: false });
	const log = team.editLog();
	return stallSubjects(
		{
			served: servedItems(runs),
			item: (ref) => store.get(ref),
			jobs,
			lastEdit: (agent) => log?.changes({ withinMs: WINDOW_MS, agent }, now)[0]?.at ?? 0,
			lastOutput: (agent) => team.approvals.lastOutput(agent),
		},
		now,
	);
}

/**
 * Once a minute while this session's children run, tells the coordinator about each delegated or handed item that made no
 * progress for `STALL_MINUTES` (`graph/stall.ts`): a wake, so it asks the child or re-plans. No model call decides it.
 * It checks only while this session is idle, so the wake is read as soon as it is sent.
 * Returns the stop the caller's `session_shutdown` runs: a shutdown handler of its own, registered before the agent
 * tool's, would delay the children's abort behind it.
 */
export function registerStalledItems(
	api: FeatureSetup,
	team: Team,
	runs: Pick<AgentRuns, "running" | "items" | "handed">,
): () => void {
	const tracker = new StallTracker();
	let timer: ReturnType<typeof setInterval> | undefined;
	let checking = false;
	const check = async (ctx: Context) => {
		// A busy coordinator reads a wake only after its turn: checked then, the alert cannot name an item closed meanwhile.
		if (checking || runs.running.size === 0 || !ctx.isIdle()) return;
		checking = true;
		try {
			const now = Date.now();
			const alerts = tracker.check(subjects(api, team, runs, ctx, now), now);
			if (alerts.length === 0) return;
			const message = { customType: STALLED_ITEM_TYPE, content: stalledItemsText(alerts) };
			// One row per item in the ledger; the message names them all.
			for (const alert of alerts.slice(1))
				await attend(api, stalledItemAttention(alert, STALL_MINUTES, now), undefined, { how: "ledger" });
			await attend(api, stalledItemAttention(alerts[0], STALL_MINUTES, now), message, {
				how: "wake",
				deliverAs: "followUp",
			});
		} finally {
			checking = false;
		}
	};
	api.bus.on("session_start", async (_event, ctx) => {
		clearInterval(timer);
		timer = setInterval(() => {
			check(ctx).catch((error: unknown) => {
				clearInterval(timer);
				timer = undefined;
				if (!isStaleSessionError(error)) ctx.ui.notify(`The stall check stopped: ${errorMessage(error)}`, "warning");
			});
		}, TICK_MS);
		timer.unref();
		return undefined;
	});
	return () => {
		clearInterval(timer);
		timer = undefined;
	};
}
