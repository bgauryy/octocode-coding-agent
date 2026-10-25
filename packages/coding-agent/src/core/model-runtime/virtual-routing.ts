import {
	type Api,
	type AssistantMessage,
	clampThinkingLevel,
	type Message,
	type Model,
	type ModelThinkingLevel,
} from "@octocodeai/octocode-ai";
import { findLatestResponse, type ModelRoute, type ModelRouteReason } from "../virtual-models.ts";
import type { RegisteredVirtualModel } from "./types.ts";
import { assertPendingImageInputSupported } from "@octocodeai/octocode-ai/utils/image-input";

/** What virtual-model routing needs of the runtime. */
export interface VirtualRoutingHost {
	getPhysicalModel(providerId: string, modelId: string): Model<Api> | undefined;
	hasConfiguredAuth(providerId: string): boolean;
}

/** Route one request of the registered virtual model `virtual`; see `ModelRuntime.resolveModel()`. */
export async function routeVirtualModel(
	host: VirtualRoutingHost,
	virtual: RegisteredVirtualModel | undefined,
	model: Model<Api>,
	messages: readonly Message[],
	options: {
		reason: ModelRouteReason;
		thinkingLevel: ModelThinkingLevel;
		signal?: AbortSignal;
		failed?: AssistantMessage;
		state?: unknown;
	},
): Promise<ModelRoute> {
	const name = `Virtual model ${model.provider}/${model.id}`;
	if (!virtual) throw new Error(`${name} is not registered.`);
	const { failed, ...request } = options;
	const latest = findLatestResponse(messages);
	const previousModel = latest && host.getPhysicalModel(latest.provider, latest.model);
	// A failed routing attempt names the virtual model; there is no physical request to report.
	const failedModel = failed && host.getPhysicalModel(failed.provider, failed.model);
	const route = await virtual.route({
		...request,
		model,
		previous: previousModel && { model: previousModel, thinkingLevel: latest?.thinkingLevel },
		failed: failedModel && failed && { model: failedModel, thinkingLevel: failed.thinkingLevel, message: failed },
		messages,
	});
	const target = host.getPhysicalModel(route.model.provider, route.model.id);
	const routed = `${name} routed to ${route.model.provider}/${route.model.id}`;
	if (!target) throw new Error(`${routed}, which is not a physical model.`);
	if (!host.hasConfiguredAuth(target.provider)) throw new Error(`${routed}, which has no credentials.`);
	assertPendingImageInputSupported(target, messages);
	return { model: target, thinkingLevel: clampThinkingLevel(target, route.thinkingLevel), state: route.state };
}
