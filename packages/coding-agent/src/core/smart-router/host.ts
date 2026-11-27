import type { Api, Model, ProviderPlan } from "@octocodeai/octocode-ai";
import { isVirtualModel } from "../virtual-models.ts";
import type { CandidateFacts } from "./types.ts";

/** What the router reads of the model runtime. `ModelRuntime` satisfies it. */
export interface SmartRouterHost {
	getAvailableSnapshot(): readonly Model<Api>[];
	hasConfiguredAuth(providerId: string): boolean;
	isProviderDisabled(providerId: string): boolean;
	isModelHidden(model: { provider: string; id: string }): boolean;
	isModelDeprecated(model: { provider: string; id: string }): boolean;
	isModelAccessRejected(model: { provider: string; id: string }): boolean;
	getProviderPlan(providerId: string): ProviderPlan | undefined;
}

/**
 * Facts for every physical chat model the runtime lists as available. Virtual models are never candidates,
 * so the router cannot route to itself. Unavailable models are absent here; the filters still re-check
 * credentials and restrictions, because the snapshot can lag a settings change.
 */
export function collectFacts(host: SmartRouterHost): CandidateFacts[] {
	const facts: CandidateFacts[] = [];
	for (const model of host.getAvailableSnapshot()) {
		if (isVirtualModel(model) || (model as { type?: string }).type !== undefined) continue;
		facts.push({
			model,
			configured: host.hasConfiguredAuth(model.provider),
			providerDisabled: host.isProviderDisabled(model.provider),
			hidden: host.isModelHidden(model),
			deprecated: host.isModelDeprecated(model),
			accessRejected: host.isModelAccessRejected(model),
			plan: host.getProviderPlan(model.provider),
		});
	}
	return facts;
}
