import type { AiGatewayPricing } from "../ai-gateway-pricing.ts";
import type { ModelsDevReasoningOption } from "../models-dev-reasoning-options.ts";

/** Shapes of the upstream catalogs the generator reads (models.dev, NVIDIA NIM, Vercel AI Gateway). */

export interface ModelsDevModel {
	id: string;
	name: string;
	tool_call?: boolean;
	structured_output?: boolean;
	reasoning?: boolean;
	reasoning_options?: ModelsDevReasoningOption[];
	status?: string;
	limit?: {
		context?: number;
		output?: number;
	};
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
		tiers?: {
			input?: number;
			output?: number;
			cache_read?: number;
			cache_write?: number;
			tier?: {
				type?: string;
				size?: number;
			};
		}[];
	};
	modalities?: {
		input?: string[];
		output?: string[];
	};
	provider?: {
		npm?: string;
	};
}

export interface ModelsDevProvider {
	models?: Record<string, ModelsDevModel>;
}

export interface ModelsDevMetadata {
	id: string;
	type?: string;
	name: string;
	limit?: { context?: number };
	modalities?: { input?: string[] };
}

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
