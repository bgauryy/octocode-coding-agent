import { getPromptCacheLifetime, price } from "../../../core/cache-warmer/economics.ts";
import type { FeatureContext } from "../../../core/features/index.ts";
import type { Settings } from "../../../core/settings-manager.ts";

/** Claude Code's SessionStart fields for a resumed or forked session (`seconds_since_last_response` and the rest). */
interface ResumeFields {
	seconds_since_last_response: number;
	context_tokens: number;
	prompt_cache_likely_expired: boolean;
	estimated_cache_write_usd?: number;
}

/**
 * What a resumed or forked session's first request will cost to re-send, as Claude Code's SessionStart reports it, when
 * its transcript holds a reply: the seconds since that reply, the prompt the first request re-sends (the context
 * estimate, else the last reply's prompt and output), whether the cache entry has likely expired (older than the history
 * entry's lifetime under the session's cache settings, replaced by a later compaction, or no lifetime known), and the
 * cost of writing that prompt to the cache at the model's prices (its input price where writes cost nothing extra).
 * Undefined otherwise.
 */
export function resumeFields(
	settings: Settings,
	ctx: Pick<FeatureContext, "sessionManager" | "getContextUsage" | "model" | "modelRegistry">,
	now = Date.now(),
): ResumeFields | undefined {
	const branch = ctx.sessionManager.getBranch();
	const index = branch.findLastIndex((entry) => entry.type === "message" && entry.message.role === "assistant");
	const entry = branch[index];
	if (entry?.type !== "message" || entry.message.role !== "assistant") return undefined;
	const reply = entry.message;
	const seconds = Math.max(0, Math.round((now - reply.timestamp) / 1000));
	const usage = reply.usage;
	const tokens = ctx.getContextUsage()?.tokens ?? usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
	const model = ctx.model;
	const lifetime = model
		? getPromptCacheLifetime(
				model,
				ctx.modelRegistry.getCachePolicy(model, [{ source: "settings", values: settings }]).options,
			)
		: undefined;
	const compacted = branch.slice(index + 1).some((later) => later.type === "compaction");
	const cost = model
		? model.cost.cacheWrite > 0
			? price(model, { cacheWrite: tokens, ...(lifetime?.history === "long" ? { cacheWrite1h: tokens } : {}) })
			: price(model, { input: tokens })
		: undefined;
	return {
		seconds_since_last_response: seconds,
		context_tokens: tokens,
		prompt_cache_likely_expired: compacted || !lifetime || seconds * 1000 >= lifetime.ttlMs,
		...(cost !== undefined ? { estimated_cache_write_usd: Math.round(cost * 10_000) / 10_000 } : {}),
	};
}
