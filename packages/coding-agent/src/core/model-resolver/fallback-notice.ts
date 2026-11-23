/**
 * The startup line that says a saved default model was not used, why, and what runs instead: a saved default whose
 * sign-in expired must not be replaced silently, least of all by a provider that bills differently.
 */

import type { Api, Model } from "@octocodeai/octocode-ai";
import { billedText } from "../agent-session/fallback-switch.ts";
import type { ModelRuntime } from "../model-runtime.ts";

type SkipRuntime = Pick<
	ModelRuntime,
	| "getProvider"
	| "isProviderDisabled"
	| "getPlanDisabledReason"
	| "hasConfiguredAuth"
	| "getModel"
	| "isModelHidden"
	| "getProviderBilling"
>;

/**
 * Why the saved default `provider/modelId` is unusable, checked in this order: the provider is unknown or off (turned
 * off in `/providers`, or its plan paused), it has no credentials, the model is not in its catalog, the model is hidden.
 */
function savedDefaultSkipReason(runtime: SkipRuntime, provider: string, modelId: string): string {
	if (!runtime.getProvider(provider)) return "provider not configured";
	if (runtime.isProviderDisabled(provider)) return "provider off";
	const paused = runtime.getPlanDisabledReason(provider);
	if (paused) return `provider paused (${paused})`;
	if (!runtime.hasConfiguredAuth(provider)) return "no credentials";
	if (!runtime.getModel(provider, modelId)) return "model not in the catalog";
	if (runtime.isModelHidden({ provider, id: modelId })) return "model hidden";
	return "model unavailable";
}

/**
 * `Saved default p/m not used: no credentials. Using q/n (billed per token).` The billing is named when it may differ:
 * the saved default's provider has no credentials (its billing is unknown) or bills differently from the replacement.
 * Without a replacement the line ends after the reason; the caller adds how to connect a provider.
 */
export function savedDefaultNotice(
	runtime: SkipRuntime,
	saved: { provider: string; modelId: string },
	replacement: Pick<Model<Api>, "provider" | "id"> | undefined,
): string {
	const reason = savedDefaultSkipReason(runtime, saved.provider, saved.modelId);
	const head = `Saved default ${saved.provider}/${saved.modelId} not used: ${reason}.`;
	if (!replacement) return head;
	const billing = runtime.getProviderBilling(replacement.provider);
	const billingKnown = runtime.hasConfiguredAuth(saved.provider);
	const named = !billingKnown || runtime.getProviderBilling(saved.provider) !== billing;
	return `${head} Using ${replacement.provider}/${replacement.id}${named ? ` (${billedText(billing)})` : ""}.`;
}
