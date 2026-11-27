import type { AssistantMessage, RequestTrace } from "@octocodeai/octocode-ai";
import type { SessionEntry } from "../session-manager.ts";
import { entryUsage } from "../usage-totals.ts";
import { firstChangedArea, isEarlierChange, type LayerChange } from "./first-change.ts";

/** One user turn: every request from a user message up to the next one, with the refreshes that fell inside it. */
export interface TurnCost {
	/** 1-based turn number on the branch. */
	turn: number;
	requests: number;
	/**
	 * US dollars: everything recorded during the turn, as `/session`'s total counts it (`entryUsage`): the responses,
	 * cache refreshes and summaries, and the subagent runs whose tool results or reports landed in it.
	 */
	cost: number;
	/** The costliest first change among the turn's requests (`isEarlierChange`); undefined without traces. */
	firstChange?: LayerChange;
	/** A response in the turn lacks the provider's final count: `cost` is a floor. */
	lowerBound: boolean;
}

const sameModel = (a: AssistantMessage, b: AssistantMessage) => a.provider === b.provider && a.model === b.model;

/**
 * $/turn for the branch `entries` (RFC D9), root first. A request is compared with the previous request of the same
 * model; after a model switch it is `cold`. Requests before the first user message form turn 0's cost and are dropped.
 */
export function turnCosts(entries: readonly SessionEntry[]): TurnCost[] {
	const turns: TurnCost[] = [];
	let previous: { message: AssistantMessage; trace?: RequestTrace } | undefined;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "user") {
			turns.push({ turn: turns.length + 1, requests: 0, cost: 0, lowerBound: false });
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			// Spend outside the replies: refreshes, summaries, and subagent runs (their tool results and reports).
			const spend = entryUsage(entry);
			const turn = turns.at(-1);
			if (spend && turn) {
				turn.cost += spend.usage.cost.total;
				if (spend.usage.lowerBound) turn.lowerBound = true;
			}
			continue;
		}
		const message = entry.message;
		const turn = turns.at(-1);
		const trace = message.requestTrace;
		const before = previous && sameModel(previous.message, message) ? previous.trace : undefined;
		const change = firstChangedArea(before, trace);
		previous = { message, trace };
		if (!turn) continue;
		turn.requests++;
		turn.cost += message.usage.cost.total;
		if (message.usage.lowerBound) turn.lowerBound = true;
		if (change && (!turn.firstChange || isEarlierChange(change, turn.firstChange))) turn.firstChange = change;
	}
	return turns.filter((turn) => turn.requests > 0);
}
