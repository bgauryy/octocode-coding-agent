import type { Api, Model } from "@octocodeai/octocode-ai";
import type { Billing, CandidateFacts, ModelPattern, RejectionReason, SmartRouterOptions } from "./types.ts";

export function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

const matchers = new Map<string, RegExp>();

/** Whether `pattern` (`*` wildcards, case-insensitive) matches a `provider/id` key. */
export function matchesPattern(pattern: ModelPattern, key: string): boolean {
	let matcher = matchers.get(pattern);
	if (!matcher) {
		const source = pattern
			.split("*")
			.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*");
		matcher = new RegExp(`^${source}$`, "i");
		// Patterns come from settings; the cache stays small, but bound it anyway.
		if (matchers.size >= 256) matchers.clear();
		matchers.set(pattern, matcher);
	}
	return matcher.test(key);
}

function matchesAny(patterns: readonly ModelPattern[] | undefined, key: string): boolean {
	return patterns?.some((pattern) => matchesPattern(pattern, key)) ?? false;
}

/** Per-token unless the provider declares a flat-rate plan. Unknown billing is treated as per-token. */
export function billingOf(facts: Pick<CandidateFacts, "plan">): Billing {
	return facts.plan?.billing === "plan" ? "plan" : "metered";
}

/** What the request needs from a model. */
export interface RequestNeeds {
	/** A new image is pending, so the model must accept images. */
	image: boolean;
	/** Estimated prompt tokens. */
	inputTokens: number;
	/** Safety factor on `inputTokens`; larger after a context overflow. */
	margin: number;
	outputReserve: number;
	/** The session already ran on a plan, so per-token models need explicit permission. */
	usedPlan: boolean;
}

/** Whether the model's window holds the request. `unknown` when the catalog gives no window. */
function contextRoom(model: Model<Api>, needs: RequestNeeds): "fits" | "tight" | "unknown" {
	const window = model.contextWindow;
	if (!(window > 0)) return "unknown";
	const inputCap = model.inputLimits?.maxInputTokens;
	const required = Math.ceil(needs.inputTokens * needs.margin);
	if (inputCap !== undefined && required > inputCap) return "tight";
	const reserve = Math.min(needs.outputReserve, model.maxTokens > 0 ? model.maxTokens : needs.outputReserve);
	return required + reserve <= window ? "fits" : "tight";
}

/**
 * Hard filters, in a fixed order; the first failing one names the reason. A model whose context window is
 * unknown passes with `unverified: true` so the caller can prefer verified models.
 */
export function hardReject(
	facts: CandidateFacts,
	options: SmartRouterOptions,
	needs: RequestNeeds,
): { reason: RejectionReason } | { unverified: boolean } {
	const key = modelKey(facts.model);
	if (options.allow?.length && !matchesAny(options.allow, key)) return { reason: "not-allowed" };
	if (matchesAny(options.deny, key)) return { reason: "denied" };
	if (!facts.configured) return { reason: "no-credentials" };
	if (facts.providerDisabled) return { reason: "provider-disabled" };
	if (facts.plan?.disabled) return { reason: "plan-disabled" };
	if (facts.hidden) return { reason: "hidden" };
	if (facts.deprecated) return { reason: "deprecated" };
	if (facts.accessRejected) return { reason: "access-rejected" };
	if (needs.image && !facts.model.input.includes("image")) return { reason: "modality" };
	const billing = billingOf(facts);
	if (billing === "plan") {
		if (facts.plan?.access === "external-only") return { reason: "plan-external-only" };
		if (options.unattended && facts.plan?.unattended === false) return { reason: "plan-unattended" };
	} else {
		if (options.planOnly) return { reason: "plan-only" };
		if (needs.usedPlan && !options.allowPlanToMeteredEscalation) return { reason: "plan-to-metered" };
	}
	const room = contextRoom(facts.model, needs);
	if (room === "tight") return { reason: "context" };
	return { unverified: room === "unknown" };
}
