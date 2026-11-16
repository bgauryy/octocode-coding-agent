import path from "node:path";
import { renderInstruction } from "../../core/prompt-template.ts";
import type { ExtensionAPI } from "../../core/features/index.ts";
import { openBacklog } from "../backlog/context.ts";
import { runningWorkOf } from "../shared/running-work.ts";
import type { Team } from "../team/session.ts";
import { itemKey, wakeGateOf } from "../wake/gate.ts";
import type { AgentRuns } from "./claim.ts";
import type { Lingering } from "./linger.ts";

/** The custom message that names ongoing items nobody works on. */
const IDLE_ITEM_TYPE = "octocode-idle-item";

/** Ongoing items read to find this session's; the board lists the most urgent first. */
const SCAN = 50;

/** Tells each idle item once while the same work keeps running; a change of the idle set (or no work) starts over. */
class IdleItems {
	private told = new Set<string>();

	/**
	 * The refs of `idle` to name now: not yet told in this wait, and not `acted` on. An acted-on ref is counted in `dropped`
	 * and stays untold, so a later wait names it if the run then did nothing about it. Nothing (and the memory cleared)
	 * when no work runs.
	 */
	fresh(
		working: boolean,
		idle: readonly string[],
		acted: (ref: string) => boolean,
	): { fresh: string[]; dropped: number } {
		if (!working) {
			this.told.clear();
			return { fresh: [], dropped: 0 };
		}
		this.told = new Set([...this.told].filter((ref) => idle.includes(ref)));
		const fresh: string[] = [];
		let dropped = 0;
		for (const ref of idle) {
			if (this.told.has(ref)) continue;
			if (acted(ref)) dropped++;
			else {
				this.told.add(ref);
				fresh.push(ref);
			}
		}
		return { fresh, dropped };
	}
}

/** The items a running child of this session works on (an ended child's entry is dropped). */
function linkedItems(runs: Pick<AgentRuns, "running" | "items">): Set<string> {
	const linked = new Set<string>();
	for (const [id, ref] of runs.items) {
		if (runs.running.has(id)) linked.add(ref);
		else runs.items.delete(id);
	}
	return linked;
}

/** The items a running background bash job was started for (its `item`). */
function jobItems(api: ExtensionAPI): Set<string> {
	const served = new Set<string>();
	for (const row of runningWorkOf(api).all()) {
		const key = row.kind === "bash" ? itemKey(row.item) : undefined;
		if (key) served.add(key);
	}
	return served;
}

/**
 * When the main session ends a turn while children, bash jobs or timers run, names each ongoing item it holds that no
 * running child or bash job is linked to, no reported child can still be resumed on (a new child would be refused) and
 * whose paths nobody else reserves: the coordinator would otherwise wait with free work unstarted. Once per item per
 * wait; the message starts a turn so the coordinator acts on it. An item the run that just ended wrote (a note,
 * completion, claim, close or step, or a delegation to it) is not named: that run already decided about it, and the gate
 * counts the dropped nudge on the turn record. Being woken about an item is not deciding about it, and an item left
 * unnamed stays untold, so it is named after a run that did nothing about it.
 */
export function registerIdleItems(
	api: ExtensionAPI,
	team: Team,
	runs: Pick<AgentRuns, "running" | "items">,
	lingering: Pick<Lingering, "onItem">,
): void {
	const told = new IdleItems();
	api.on("agent_settled", async (event, ctx) => {
		if (event.aborted) return undefined;
		const working = runs.running.size > 0 || runningWorkOf(api).all().length > 0;
		let idle: string[] = [];
		if (working) {
			try {
				const backlog = openBacklog(ctx, { isSubagent: false });
				const linked = linkedItems(runs);
				const served = jobItems(api);
				idle = backlog.store
					.list({ states: ["ongoing"], limit: SCAN })
					.items.filter(
						(item) =>
							item.assignee === backlog.session &&
							!linked.has(item.ref) &&
							!served.has(itemKey(item.ref) ?? item.ref) &&
							lingering.onItem(item.ref) === undefined &&
							!item.paths.some((entry) => team.reserved(path.resolve(ctx.cwd, entry))),
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
		const content = fresh.map((ref) => renderInstruction("notices/subagents/idle-item.md", { ref }).trim()).join("\n");
		await gate.emit(
			{ kind: "item.idle", refs: fresh },
			{ customType: IDLE_ITEM_TYPE, content, display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		return undefined;
	});
}
