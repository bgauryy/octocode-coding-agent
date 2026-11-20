import type { FeatureContext } from "../../core/features/index.ts";
import type { BudgetStanding } from "../team/model.ts";
import type { HandItem } from "../team/tools/hand.ts";
import { contextText } from "./hand-item.ts";
import type { MergeResult } from "./merge-child.ts";
import type { AgentControl } from "./tool.ts";

/** `coordinate merge` for a registration that reaches the agent tool later (`index.ts` builds the team tools first). */
export const mergeThrough =
	(agents: () => AgentControl | undefined) =>
	async (id: string, ctx: FeatureContext, signal?: AbortSignal): Promise<MergeResult> =>
		(await agents()?.merge(id, ctx, signal)) ?? { ok: false, text: "Agent controls are unavailable." };

/** `agent` `message` with `item`, for a registration that reaches the agent tool later, like `mergeThrough`. */
const handThrough =
	(agents: () => AgentControl | undefined): HandItem =>
	(child, ref, ctx) => {
		const control = agents();
		if (!control) throw new Error("Agent controls are unavailable.");
		return control.handItem(child, ref, ctx);
	};

/** `coordinate` `grant` and `list`, and `message` `item`, for a registration that reaches the agent tool later, like `mergeThrough`. */
export const budgetsThrough = (agents: () => AgentControl | undefined) => ({
	grant: (id: string, requests: number): BudgetStanding | string =>
		agents()?.budgets.grant(id, requests) ?? "Agent controls are unavailable.",
	usage: (id: string): BudgetStanding | undefined => agents()?.budgets.usage(id),
	queued: (): string[] => agents()?.queued() ?? [], // queued and held children, one row each, for `coordinate list`
	cost: (id: string): number | undefined => agents()?.budgets.cost(id),
	context: (id: string): string | undefined => {
		const context = agents()?.context(id);
		return context ? contextText(context) : undefined;
	},
	hand: handThrough(agents),
});
