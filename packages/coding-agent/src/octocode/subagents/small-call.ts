import { contentText, normalizeContext } from "@octocodeai/octocode-ai";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, Usage } from "@octocodeai/octocode-ai/compat";
import { completeSimple } from "@octocodeai/octocode-ai/compat";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { FeatureContext } from "../../core/features/index.ts";
import { currentCatalog } from "./catalog.ts";
import { resolveTier } from "./model.ts";

export type CompleteSmall = (
	model: Model<Api>,
	context: ReturnType<typeof normalizeContext>,
	options: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export interface SmallCallOptions {
	/** The one user message the model is sent. */
	text: string;
	signal: AbortSignal;
	maxTokens: number;
	/** With no cheaper model to resolve, call the session's own model instead of giving up. */
	fallbackToSession?: boolean;
	complete?: CompleteSmall;
}

/** The `provider/id` the `small` purpose resolves to for this session, or undefined: no cheaper model, so a call would fail. */
export function smallModelLabel(ctx: FeatureContext): string | undefined {
	if (!ctx.model) return undefined;
	const chosen = resolveTier("small", ctx.modelRegistry.getAvailable(), ctx.model, currentCatalog());
	return chosen ? `${chosen.provider}/${chosen.id}` : undefined;
}

/** A reply's text, the `provider/id` that wrote it and what the call used and cost (so a caller can record the spend). */
export type SmallCallResult =
	| { text: string; model: string; provider: string; modelId: string; usage: Usage }
	| { error: string };

/**
 * One call to the cheapest capable model the `small` purpose resolves to among the session's available models: no tools,
 * no cache. Without such a model (the session model's price is unknown, or nothing cheaper is connected) it uses the
 * session's own model when `fallbackToSession` is set, else fails. Never rejects: a missing model, failed
 * authentication, a failed or aborted call and an empty reply each give `{ error }` naming the cause.
 */
export async function callSmallModel(ctx: FeatureContext, options: SmallCallOptions): Promise<SmallCallResult> {
	try {
		if (!ctx.model) return { error: "no model is selected" };
		const available = ctx.modelRegistry.getAvailable();
		const chosen = resolveTier("small", available, ctx.model, currentCatalog());
		const session = ctx.model;
		const model =
			(chosen && available.find((each) => each.provider === chosen.provider && each.id === chosen.id)) ??
			(options.fallbackToSession ? session : undefined);
		if (!model) return { error: "no cheaper model is available" };
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return { error: `${model.provider}/${model.id} is not authenticated` };
		const reply = await (options.complete ?? completeSimple)(
			model,
			normalizeContext({
				messages: [{ role: "user", content: [{ type: "text", text: options.text }], timestamp: Date.now() }],
			}),
			{
				signal: options.signal,
				maxTokens: options.maxTokens,
				cacheRetention: "none",
				...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
				...(auth.headers ? { headers: auth.headers } : {}),
				...(auth.env ? { env: auth.env } : {}),
			},
		);
		const label = `${model.provider}/${model.id}`;
		if (reply.stopReason === "aborted") return { error: "the call was cancelled" };
		if (reply.stopReason === "error") return { error: reply.errorMessage || `${label} returned an error` };
		const text = contentText(reply.content);
		return text.trim()
			? { text, model: label, provider: model.provider, modelId: model.id, usage: reply.usage }
			: { error: `${label} returned an empty reply` };
	} catch (error) {
		return { error: errorMessage(error) };
	}
}
