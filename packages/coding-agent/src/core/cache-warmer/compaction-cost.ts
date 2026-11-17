import { activeRates, type Api, type Model } from "@octocodeai/octocode-ai";
import { price } from "./economics.ts";

/**
 * Whether an automatic compaction pays before the context limit forces it (RFC F6). Its one-time cost is the summary
 * request (reading the context, writing the summary) plus a cold write of the new span's prefix; its saving is the
 * context it drops, no longer read on each later request:
 *
 *     oneTime = summary + write(kept)          saving = read(context − kept) × remainingRequests
 *
 * When the cache is cold anyway (an idle gap past the lifetime, a model change), the next request would rewrite the whole
 * context without compacting, so that write is credited and the summary request reads the context at the input price.
 */
export interface CompactionCostInput {
	model: Model<Api>;
	/** Tokens in the context now. */
	contextTokens: number;
	/** Tokens of the new span's prefix after compacting: head, summary and kept messages. */
	keptTokens: number;
	/** Expected output tokens of the summary. */
	summaryTokens: number;
	/** Requests expected before the context limit would force a compaction. */
	remainingRequests: number;
	/** The next request rewrites the cache whether or not it compacts. */
	rewriteAnyway: boolean;
}

export interface CompactionCost {
	oneTime: number;
	savingPerRequest: number;
	saving: number;
	pays: boolean;
}

export function compactionCost(input: CompactionCostInput): CompactionCost {
	const { model, contextTokens: context, summaryTokens } = input;
	const kept = Math.min(Math.max(0, input.keptTokens), context);
	const premium = activeRates(model.cost).cacheWrite > 0;
	const write = (tokens: number) => price(model, premium ? { cacheWrite: tokens } : { input: tokens });
	const summary = price(
		model,
		input.rewriteAnyway ? { input: context, output: summaryTokens } : { cacheRead: context, output: summaryTokens },
	);
	const oneTime = summary + write(kept) - (input.rewriteAnyway ? write(context) : 0);
	const savingPerRequest = price(model, { cacheRead: context - kept });
	const saving = savingPerRequest * Math.max(0, input.remainingRequests);
	return { oneTime, savingPerRequest, saving, pays: kept < context && saving > oneTime };
}
