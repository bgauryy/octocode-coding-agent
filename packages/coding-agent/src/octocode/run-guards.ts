import type { FeatureSetup } from "../core/features/index.ts";
import { registerReadDedupe } from "./files/dedupe.ts";
import { registerLoopGuard } from "./loop-guard.ts";
import type { Gate } from "./permission/judge.ts";
import { registerRunBudget } from "./run-budget.ts";

/**
 * What keeps a run from wasting itself, after the file guard's `tool_result` handler (the read dedupe must see the text a
 * read returned). Returns the `loop` step for the `tool_call` pipeline (`tool-gates.ts`): the run's request and spend
 * bounds (`run-budget.ts`), then the loop guard.
 */
export function registerRunGuards(api: FeatureSetup, isSubagent: boolean): { loop: Gate } {
	registerReadDedupe(api);
	const budget = registerRunBudget(api, isSubagent);
	const loop = registerLoopGuard(api);
	return { loop: async (event, ctx, prior) => (await budget(event, ctx, prior)) ?? loop(event, ctx, prior) };
}
