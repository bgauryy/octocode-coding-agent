import path from "node:path";
import type { FeatureSetup } from "../../core/features/index.ts";
import type { BacklogStore } from "../backlog/store.ts";
import type { Item } from "../backlog/item.ts";
import { openBacklog } from "../backlog/context.ts";
import { attend } from "../monitor/attention/attend.ts";
import { IDLE_ITEM_TYPE, IdleItems, idleItemsAttention, idleItemsText } from "../monitor/attention/idle-items.ts";
import { runningWorkOf } from "../shared/running-work.ts";
import type { Team } from "../team/session.ts";
import { itemKey, wakeGateOf } from "../wake/gate.ts";
import type { AgentRuns } from "./claim.ts";
import { servedItems } from "./handed-items.ts";
import type { Lingering } from "./linger.ts";
import { registerStalledItems } from "./stalled-items.ts";

/** Ongoing items read to find this session's; the board lists the most urgent first. */
const SCAN = 50;

/** The items a running child of this session works on, started for or handed since (an ended child's entry is dropped). */
function linkedItems(runs: Pick<AgentRuns, "running" | "items" | "handed">): Set<string> {
	for (const id of runs.items.keys()) if (!runs.running.has(id)) runs.items.delete(id);
	return new Set([...servedItems(runs)].map(([, ref]) => ref));
}

/** The items a running background bash job was started for (its `item`). */
function jobItems(api: FeatureSetup): Set<string> {
	const served = new Set<string>();
	for (const row of runningWorkOf(api).all()) {
		const key = row.kind === "bash" ? itemKey(row.item) : undefined;
		if (key) served.add(key);
	}
	return served;
}

/** `refs` and every item they derive from (`from` or parent links, any depth), by normalized key. */
function withAncestors(store: Pick<BacklogStore, "get">, refs: Iterable<string>): Set<string> {
	const served = new Set<string>();
	const seen = new Set<string>();
	const queue: (Item | undefined)[] = [];
	for (const start of refs) {
		served.add(itemKey(start) ?? start);
		queue.push(store.get(start));
	}
	// An item can have both an epic parent and a `from` origin: both lead to items its work serves.
	for (let at = queue.pop(); at || queue.length; at = queue.pop()) {
		if (!at || seen.has(at.ref)) continue;
		seen.add(at.ref);
		served.add(itemKey(at.ref) ?? at.ref);
		for (const up of [at.parentId, at.from]) if (up !== undefined) queue.push(store.get(up));
	}
	return served;
}

/**
 * When the main session ends a turn while children, bash jobs or timers run, names each ongoing item it holds that no
 * running child or bash job is linked to, no reported child can still be resumed on (a new child would be refused) and
 * whose paths, and everything inside them, nobody reserves: the coordinator would otherwise wait with free work
 * unstarted. (An item with an open prerequisite cannot be ongoing: the backlog refuses the claim.) Once per item per
 * wait; the message starts a turn so the coordinator acts on it. An item the run that just ended wrote (a note,
 * completion, claim, close or step, or a delegation to it) is not named: that run already decided about it, and the gate
 * counts the dropped nudge on the turn record. Being woken about an item is not deciding about it, and an item left
 * unnamed stays untold, so it is named after a run that did nothing about it.
 */
export function registerIdleItems(
	api: FeatureSetup,
	team: Team,
	runs: Pick<AgentRuns, "running" | "items" | "handed">,
	lingering: Pick<Lingering, "onItem">,
): () => void {
	const stopStalls = registerStalledItems(api, team, runs);
	const told = new IdleItems();
	api.bus.on("agent_settled", async (event, ctx) => {
		if (event.aborted) return undefined;
		const working = runs.running.size > 0 || runningWorkOf(api).all().length > 0;
		let idle: string[] = [];
		if (working) {
			try {
				const backlog = openBacklog(ctx, { isSubagent: false });
				const served = withAncestors(backlog.store, [...linkedItems(runs), ...jobItems(api)]);
				idle = backlog.store
					.list({ states: ["ongoing"], limit: SCAN })
					.items.filter(
						(item) =>
							item.assignee === backlog.session &&
							!served.has(itemKey(item.ref) ?? item.ref) &&
							lingering.onItem(item.ref) === undefined &&
							!item.paths.some((entry) => team.reserved(path.resolve(ctx.cwd, entry), "tree")),
					)
					.map((item) => item.ref);
			} catch {
				// An unreadable backlog or team database names nothing; `backlog` and `coordinate` report the cause when asked.
				return undefined;
			}
		}
		const gate = wakeGateOf(api);
		const { fresh, dropped } = told.fresh(working, idle, (ref) => gate.actedOn(ref));
		gate.drop(dropped);
		if (fresh.length === 0) return undefined;
		await attend(
			api,
			idleItemsAttention(fresh),
			{ customType: IDLE_ITEM_TYPE, content: idleItemsText(fresh) },
			{ how: "wake", deliverAs: "followUp" },
		);
		return undefined;
	});
	return stopStalls;
}
