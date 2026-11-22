import type { AiGatewayPricing } from "../ai-gateway-pricing.ts";
import type { Model } from "@opencode-ai/models";

/** The converters accept sparse provider rows; the SDK owns the types of their fields. */
export type ModelsDevModel = Pick<Model, "id" | "name"> & Partial<Model>;
export type ModelsDevProvider = { models?: Record<string, ModelsDevModel> };
export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

export interface NvidiaNimModelListItem {
	id: string;
}

export interface AiGatewayModel {
	id: string;
	name?: string;
	type?: string;
	context_window?: number;
	max_tokens?: number;
	tags?: string[];
	pricing?: AiGatewayPricing;
}
