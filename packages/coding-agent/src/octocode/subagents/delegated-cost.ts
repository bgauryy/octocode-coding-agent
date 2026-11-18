import { renderPrompt } from "../../core/prompt-template.ts";
import { entryUsage } from "../../core/usage-totals.ts";
import { formatCost } from "../shared/format.ts";

type Entry = Parameters<typeof entryUsage>[0];

/**
 * A session's recorded spend in dollars, split by who spent it: `delegated` is what its subagents' runs cost (a
 * foreground run rides on its `agent` tool result, a background run on its report message), `own` is everything else
 * (the session's replies, its summaries, its other tools).
 */
export function sessionSpend(entries: readonly Entry[]): { own: number; delegated: number } {
	let own = 0;
	let delegated = 0;
	for (const entry of entries) {
		const cost = entryUsage(entry)?.usage.cost.total ?? 0;
		const child =
			entry.type === "custom_message" ||
			(entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "agent");
		if (child) delegated += cost;
		else own += cost;
	}
	return { own, delegated };
}

/** The highest multiple each session's coordinator was told about, by its runs: a multiple is named once. */
const told = new WeakMap<object, number>();

/**
 * The line a child's report ends with when its run took delegated cost past a new whole multiple of the session's own
 * cost, else "". `entries` do not hold this run yet, so `runCost` is added to them. A notice only: nothing is refused or
 * stopped, and a failure to count says nothing. A session without a priced reply of its own has no ratio to name.
 */
export function delegatedCostNote(scope: object, entries: readonly Entry[], runCost: number): string {
	try {
		if (!(runCost > 0)) return "";
		const { own, delegated } = sessionSpend(entries);
		if (!(own > 0)) return "";
		// Multiples the recorded runs already passed were told when they ended, in this process or an earlier one.
		const passed = Math.max(Math.floor(delegated / own), told.get(scope) ?? 0);
		const multiple = Math.floor((delegated + runCost) / own);
		if (multiple <= passed) return "";
		told.set(scope, multiple);
		const note = renderPrompt("notices/subagents/cost.md", {
			once: multiple === 1,
			multiple,
			delegated: formatCost({ cost: delegated + runCost, unpriced: false }),
			own: formatCost({ cost: own, unpriced: false }),
		});
		return `\n\n${note}`;
	} catch {
		return "";
	}
}
