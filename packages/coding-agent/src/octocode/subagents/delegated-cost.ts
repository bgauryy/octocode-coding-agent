import type { FeatureContext } from "../../core/features/index.ts";
import { renderPrompt } from "../../core/prompt-template.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { type BillingFacts, billingFacts, entryBilling, entryUsage, runBilling } from "../../core/usage-totals.ts";
import { formatCost } from "../shared/format.ts";

/**
 * The money a session spent, split by who spent it: `delegated` is what its subagents' runs cost (a foreground run rides
 * on its `agent` tool result, a background run on its report message), `own` is everything else (the session's replies,
 * its summaries, its other tools). What a plan paid for (`entryBilling`) is an estimate, not money, and counts in neither:
 * `ownPlan` is that estimate for the session's own spend.
 */
export function sessionSpend(
	entries: readonly SessionEntry[],
	facts: BillingFacts,
): { own: number; delegated: number; ownPlan: number } {
	let own = 0;
	let delegated = 0;
	let ownPlan = 0;
	for (const entry of entries) {
		const spend = entryUsage(entry);
		if (!spend) continue;
		const cost = spend.usage?.cost?.total ?? 0;
		const child =
			entry.type === "custom_message" ||
			(entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "agent");
		if (spend.plan || entryBilling(entry, facts) === "plan") {
			if (!child) ownPlan += cost;
		} else if (child) delegated += cost;
		else own += cost;
	}
	return { own, delegated, ownPlan };
}

/** The highest multiple each session's coordinator was told about, by its runs: a multiple is named once. */
const told = new WeakMap<object, number>();

/**
 * The line a child's report ends with when its run took delegated cost past a new whole multiple of the session's own
 * cost, else "". The session's entries do not hold this run yet, so `cost` is added to them. Delegated cost is money only:
 * a run (`details`, its `RunDetails`) a plan paid for adds nothing. The session's own cost is its money, or, when a plan
 * paid for all of its own spend (a coordinator on a subscription), the plan's estimate of it at list price: the notice
 * then weighs the money its children spend against what its own work is worth. A notice only: nothing is refused or
 * stopped. A session without any priced spend of its own has no ratio to name.
 */
export function delegatedCostNote(
	scope: object,
	ctx: Pick<FeatureContext, "sessionManager" | "modelRegistry" | "model">,
	cost: number,
	details?: unknown,
): string {
	const facts = billingFacts(ctx);
	const runCost = runBilling(details, facts) === "plan" ? 0 : cost;
	if (!(runCost > 0)) return "";
	const { own, delegated, ownPlan } = sessionSpend(ctx.sessionManager.getEntries(), facts);
	const basis = own > 0 ? own : ownPlan;
	if (!(basis > 0)) return "";
	// Multiples the recorded runs already passed were told when they ended, in this process or an earlier one.
	const passed = Math.max(Math.floor(delegated / basis), told.get(scope) ?? 0);
	const multiple = Math.floor((delegated + runCost) / basis);
	if (multiple <= passed) return "";
	told.set(scope, multiple);
	const shown = formatCost({ cost: basis, unpriced: false });
	const note = renderPrompt("notices/subagents/cost.md", {
		once: multiple === 1,
		multiple,
		delegated: formatCost({ cost: delegated + runCost, unpriced: false }),
		// A plan's figure is an estimate, never money: `~$1.00 plan estimate`, as `/usage` writes it.
		own: own > 0 ? shown : `${shown.replace(/^≈/, "~")} plan estimate`,
	});
	return `\n\n${note}`;
}
