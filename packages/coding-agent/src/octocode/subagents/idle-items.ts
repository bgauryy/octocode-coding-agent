import path from "node:path";
import { renderInstruction } from "../../core/prompt-template.ts";
import type { ExtensionAPI } from "../../core/features/index.ts";
import { openBacklog } from "../backlog/context.ts";
import { runningWorkOf } from "../shared/running-work.ts";
import type { Team } from "../team/session.ts";
import type { AgentRuns } from "./claim.ts";
import type { Lingering } from "./linger.ts";

/** The custom message that names ongoing items nobody works on. */
const IDLE_ITEM_TYPE = "octocode-idle-item";

/** Ongoing items read to find this session's; the board lists the most urgent first. */
const SCAN = 50;

/** Tells each idle item once while the same work keeps running; a change of the idle set (or no work) starts over. */
class IdleItems {
	private told = new Set<string>();

	/** The refs of `idle` not yet told in this wait; nothing (and the memory cleared) when no work runs. */
	fresh(working: boolean, idle: readonly string[]): string[] {
		if (!working) {
			this.told.clear();
			return [];
		}
		this.told = new Set([...this.told].filter((ref) => idle.includes(ref)));
		const fresh = idle.filter((ref) => !this.told.has(ref));
		for (const ref of fresh) this.told.add(ref);
		return fresh;
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

/**
 * When the main session ends a turn while children, bash jobs or timers run, names each ongoing item it holds that no
 * running child is linked to, no reported child can still be resumed on (a new child would be refused) and whose paths
 * nobody else reserves: the coordinator would otherwise wait with free work unstarted. Once per item per wait; the
 * message starts a turn so the coordinator acts on it.
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
				idle = backlog.store
					.list({ states: ["ongoing"], limit: SCAN })
					.items.filter(
						(item) =>
							item.assignee === backlog.session &&
							!linked.has(item.ref) &&
							lingering.onItem(item.ref) === undefined &&
							!item.paths.some((entry) => team.reserved(path.resolve(ctx.cwd, entry))),
					)
					.map((item) => item.ref);
			} catch {
				// An unreadable backlog or team database names nothing; `backlog` and `coordinate` report the cause when asked.
				return undefined;
			}
		}
		const fresh = told.fresh(working, idle);
		if (fresh.length === 0) return undefined;
		const content = fresh.map((ref) => renderInstruction("notices/subagents/idle-item.md", { ref }).trim()).join("\n");
		await api.sendMessage(
			{ customType: IDLE_ITEM_TYPE, content, display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		return undefined;
	});
}
