import { renderPrompt } from "../../../core/prompt-template.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { formatCost } from "../../shared/format.ts";
import { plural } from "../../shared/text.ts";
import { textResult } from "../../shared/util.ts";
import type { BudgetStanding } from "../model.ts";
import type { Team } from "../session.ts";
import type { HandItem } from "./hand.ts";

/** The request budgets of the children this agent started (wired by `index.ts` from the subagents domain); unset in a subagent. */
export interface ChildBudgets {
	/** Adds `requests` to child `id`'s limits for this run; the new standing, or the refusal. */
	grant(id: string, requests: number): BudgetStanding | string;
	usage(id: string): BudgetStanding | undefined;
	/** What running child `id` has cost so far in this run, in dollars. */
	cost?(id: string): number | undefined;
	/** The children queued behind prerequisites or held, one row each (`coordinate` `list`). */
	queued?(): string[];
	/** How full running child `id`'s context is (`context 45% (90k of 200k)`); undefined before its first reply. */
	context?(id: string): string | undefined;
	/** Hands a backlog item to running child `id` (`agent` `message` with `item`). */
	hand?: HandItem;
}

/** Running child `id`'s requests against its limits, with its context fill, for `coordinate list`. */
export function childStanding(budgets: ChildBudgets | undefined, id: string): BudgetStanding | undefined {
	const usage = budgets?.usage(id);
	const context = budgets?.context?.(id);
	return usage && context ? { ...usage, context } : usage;
}

/**
 * `coordinate` action `grant`: the parent process counts the child's requests, so the new limits hold at once; the child
 * hears of them in its mail. The result names the requests the child has used and what they cost so far. A message that fails costs only that word: the limits are raised either way.
 */
export async function grantRequests(
	team: Pick<Team, "send" | "asks" | "id">,
	budgets: ChildBudgets | undefined,
	subagent: string | undefined,
	requests: number | undefined,
	signal?: AbortSignal,
): Promise<ReturnType<typeof textResult>> {
	if (!budgets) throw new Error("Only the agent that started a subagent can grant it requests.");
	const id = subagent?.trim();
	if (!id) throw new Error("grant needs the id of a running subagent you started.");
	if (requests === undefined || !Number.isSafeInteger(requests) || requests < 1)
		throw new Error("grant needs requests: a positive whole number of model requests to add.");
	const standing = budgets.grant(id, requests);
	if (typeof standing === "string") throw new Error(standing);
	const told = await tell(team, id, requests, standing, openAsk(team, id), signal);
	const cost = formatCost({ cost: budgets.cost?.(id) ?? 0, unpriced: false });
	return textResult(
		`Granted ${requests} more requests to ${id} for this run: it has used ${standing.used} of ${standing.soft}${cost ? ` (${cost} so far)` : ""} and stops at ${standing.hard}. ${told}`,
		{ summary: `Granted ${plural(requests, "request")} to ${id}` },
	);
}

/**
 * The child's one open question to this agent, which a grant answers. With none, or several (which one is about the
 * budget is a guess), the grant stays a plain notice and the questions stay open.
 */
function openAsk(team: Pick<Team, "asks" | "id">, child: string): number | undefined {
	if (!team.id) return undefined;
	const open = team.asks(child, team.id, 0).filter((ask) => !ask.answer);
	return open.length === 1 ? open[0]?.id : undefined;
}

async function tell(
	team: Pick<Team, "send">,
	id: string,
	requests: number,
	{ used, hard }: BudgetStanding,
	replyTo: number | undefined,
	signal?: AbortSignal,
): Promise<string> {
	const text = renderPrompt("notices/subagents/budget-granted.md", { requests, used, hard });
	try {
		const result = await team.send(id, text, {
			replyRequired: false,
			...(replyTo !== undefined ? { replyTo } : {}),
			...(signal ? { signal } : {}),
		});
		if (!("error" in result))
			return `It reads this at its next step (message #${result.id})${replyTo !== undefined ? `; it answers its question #${replyTo}` : ""}.`;
		return `It could not be told (${result.error}), but its limits are raised.`;
	} catch (error) {
		return `It could not be told (${errorMessage(error)}), but its limits are raised.`;
	}
}
