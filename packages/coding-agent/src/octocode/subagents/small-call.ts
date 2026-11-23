import { contentText, normalizeContext } from "@octocodeai/octocode-ai";
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@octocodeai/octocode-ai/compat";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { FeatureContext } from "../../core/features/index.ts";
import { retrySideCall, type SideRetry } from "../shared/side-retry.ts";
import type { SmallCallResult } from "../shared/small-model.ts";
import { currentCatalog } from "../../core/model-catalog/index-store.ts";
import { resolveTierChoice } from "./model.ts";

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
	/** Retries of a rate limit or transient failure; none when unset. */
	retry?: SideRetry;
	/** Sends the request in place of the session's model runtime (tests). */
	complete?: CompleteSmall;
}

/**
 * The `small` purpose's model by price alone. A size-class guess (the session model has no price) is not "cheaper": these
 * background calls spend without being asked, so with nothing known to be cheaper they make no call.
 */
function pricedSmall(ctx: FeatureContext, available: ReturnType<FeatureContext["modelRegistry"]["getAvailable"]>) {
	const { model, guessed } = resolveTierChoice("small", available, ctx.model, currentCatalog());
	return guessed ? undefined : model;
}

/** The `provider/id` the `small` purpose resolves to for this session, or undefined: no cheaper model, so a call would fail. */
export function smallModelLabel(ctx: FeatureContext): string | undefined {
	if (!ctx.model) return undefined;
	const chosen = pricedSmall(ctx, ctx.modelRegistry.getAvailable());
	return chosen ? `${chosen.provider}/${chosen.id}` : undefined;
}

/**
 * One call to the cheapest capable model the `small` purpose resolves to among the session's available models: no tools,
 * no cache. Without such a model (the session model's price is unknown, or nothing cheaper is connected) it uses the
 * session's own model when `fallbackToSession` is set, else fails. Each attempt goes through the session's model runtime,
 * the entry the session's own requests use, which resolves the credential and a virtual model's route. Never rejects: a
 * missing model, failed authentication, a failed or aborted call and an empty reply each give `{ error }` naming the
 * cause.
 */
export async function callSmallModel(ctx: FeatureContext, options: SmallCallOptions): Promise<SmallCallResult> {
	try {
		if (!ctx.model) return { error: "no model is selected" };
		const available = ctx.modelRegistry.getAvailable();
		const chosen = pricedSmall(ctx, available);
		const session = ctx.model;
		const model =
			(chosen && available.find((each) => each.provider === chosen.provider && each.id === chosen.id)) ??
			(options.fallbackToSession ? session : undefined);
		if (!model) return { error: "no cheaper model is available" };
		// Checked first so a missing credential names the model and costs no request; the runtime resolves it per attempt.
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return { error: `${model.provider}/${model.id} is not authenticated` };
		const send: CompleteSmall =
			options.complete ??
			((target, context, request) => ctx.modelRegistry.streamSimple(target, context, request).result());
		const context = normalizeContext({
			messages: [{ role: "user", content: [{ type: "text", text: options.text }], timestamp: Date.now() }],
		});
		const request: SimpleStreamOptions = {
			signal: options.signal,
			maxTokens: options.maxTokens,
			cacheRetention: "none",
		};
		const reply = await retrySideCall(() => send(model, context, request), options.retry, options.signal);
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
