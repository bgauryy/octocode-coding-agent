import type { AiGatewayPricing } from "../ai-gateway-pricing.ts";

/** The converters accept sparse provider rows; the shared field mappers own their shape. */
export type { ModelsDevCatalog, ModelsDevModel, ModelsDevProvider } from "../../src/catalog/models-dev-fields.ts";

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
