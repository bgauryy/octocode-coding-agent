import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { FeatureSetup } from "../../core/features/index.ts";
import { openBacklog } from "../backlog/context.ts";
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

type Context = Parameters<typeof openBacklog>[0] & { ui: { notify(message: string, level: "warning"): void } };

/**
 * The delegated items to watch: each item a running child of this session was started for or handed, with the latest of its own
 * update (note, step, claim), the child's last file change and, while a background job for it runs, now.
 */
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
	const watched: StallSubject[] = [];
	for (const [agent, ref] of servedItems(runs)) {
		const item = store.get(ref);
		if (!item || item.state !== "ongoing") continue;
		if (jobs.has(itemKey(item.ref) ?? item.ref)) {
			watched.push({ ref: item.ref, agent, lastProgressAt: now });
			continue;
		}
		const edited = log?.changes({ withinMs: STALL_MINUTES * 60_000, agent }, now)[0]?.at ?? 0;
		watched.push({ ref: item.ref, agent, lastProgressAt: Math.max(item.updatedAt, edited) });
	}
	return watched;
}

/**
 * Once a minute while this session's children run, tells the coordinator about each delegated or handed item that made no
 * progress for `STALL_MINUTES` (`graph/stall.ts`): a wake, so it asks the child or re-plans. No model call decides it.
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
		if (checking || runs.running.size === 0) return;
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
