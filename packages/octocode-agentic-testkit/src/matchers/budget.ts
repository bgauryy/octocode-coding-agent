import { cannot, needTrace, type Result } from "./shared.ts";

export interface BudgetLimits {
	requests?: number;
	promptTokens?: number;
	completionTokens?: number;
	cachedTokensAtLeast?: number;
	/** USD over the priced requests (`caps.pricing` on the gateway). */
	usd?: number;
	agent?: string;
}

export const budgetMatchers = {
	toStayWithin(received: unknown, limits: BudgetLimits): Result {
		const t = needTrace(received);
		const reqs = t.requests.filter((r) => limits.agent === undefined || r.agent === limits.agent);
		const used = reqs.filter((r) => r.usage);
		const tokenLimit =
			limits.promptTokens !== undefined ||
			limits.completionTokens !== undefined ||
			limits.cachedTokensAtLeast !== undefined;
		if (tokenLimit && !used.length) return cannot("no usage on any request");
		const priced = reqs.filter((r) => r.costUsd !== undefined);
		if (limits.usd !== undefined && !priced.length)
			return cannot("no priced request (set caps.pricing on the gateway)");
		const sum = (f: "promptTokens" | "completionTokens" | "cachedTokens"): number =>
			used.reduce((n, r) => n + (r.usage?.[f] ?? 0), 0);
		const over: string[] = [];
		if (limits.requests !== undefined && reqs.length > limits.requests)
			over.push(`requests ${reqs.length} > ${limits.requests}`);
		if (limits.promptTokens !== undefined && sum("promptTokens") > limits.promptTokens)
			over.push(`promptTokens ${sum("promptTokens")} > ${limits.promptTokens}`);
		if (limits.completionTokens !== undefined && sum("completionTokens") > limits.completionTokens)
			over.push(`completionTokens ${sum("completionTokens")} > ${limits.completionTokens}`);
		if (limits.cachedTokensAtLeast !== undefined && sum("cachedTokens") < limits.cachedTokensAtLeast)
			over.push(`cachedTokens ${sum("cachedTokens")} < ${limits.cachedTokensAtLeast}`);
		const usd = priced.reduce((n, r) => n + (r.costUsd ?? 0), 0);
		if (limits.usd !== undefined && usd > limits.usd) over.push(`usd ${usd.toFixed(6)} > ${limits.usd}`);
		const estimated = used.some((r) => r.usage?.estimated) ? " (estimated)" : "";
		return {
			pass: over.length === 0,
			message: () =>
				over.length
					? `budget exceeded${estimated}: ${over.join("; ")}`
					: `expected the budget to be exceeded${estimated}, but ${JSON.stringify(limits)} held`,
		};
	},
};
