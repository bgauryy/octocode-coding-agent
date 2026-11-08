import type { Api, Model, StreamOptions } from "../types.ts";
import { resolveCacheRetention, resolveInstructionCacheRetention } from "../utils/cache-policy.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

const DEFAULT_AZURE_API_VERSION = "v1";

/** Azure models ship without a baseUrl: one resource per user, resolved per request. */
export interface AzureEndpointOptions extends StreamOptions {
	azureApiVersion?: string;
	azureResourceName?: string;
	azureBaseUrl?: string;
	azureDeploymentName?: string;
}

function parseDeploymentNameMap(value: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!value) return map;
	for (const entry of value.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const [modelId, deploymentName] = trimmed.split("=", 2);
		if (!modelId || !deploymentName) continue;
		map.set(modelId.trim(), deploymentName.trim());
	}
	return map;
}

export function resolveDeploymentName(model: Pick<Model<Api>, "id">, options?: AzureEndpointOptions): string {
	if (options?.azureDeploymentName) {
		return options.azureDeploymentName;
	}
	const mappedDeployment = parseDeploymentNameMap(
		getProviderEnvValue("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", options?.env),
	).get(model.id);
	return mappedDeployment || model.id;
}

function normalizeAzureBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`Invalid Azure OpenAI base URL: ${baseUrl}`);
	}

	const isAzureHost =
		url.hostname.endsWith(".openai.azure.com") ||
		url.hostname.endsWith(".cognitiveservices.azure.com") ||
		url.hostname.endsWith(".ai.azure.com");
	const normalizedPath = url.pathname.replace(/\/+$/, "");

	// Ensure Azure hosts have /openai/v1 as base path so the AzureOpenAI SDK
	// can append /deployments/<model>/... and ?api-version=v1 correctly.
	if (
		isAzureHost &&
		(normalizedPath === "" ||
			normalizedPath === "/" ||
			normalizedPath === "/openai" ||
			normalizedPath === "/openai/v1/responses")
	) {
		url.pathname = "/openai/v1";
		url.search = "";
	}

	return url.toString().replace(/\/+$/, "");
}

function buildDefaultBaseUrl(resourceName: string): string {
	return `https://${resourceName}.openai.azure.com/openai/v1`;
}

export function resolveAzureBaseUrl(model: Pick<Model<Api>, "baseUrl">, options?: AzureEndpointOptions): string {
	const baseUrl =
		options?.azureBaseUrl?.trim() || getProviderEnvValue("AZURE_OPENAI_BASE_URL", options?.env)?.trim() || undefined;
	const resourceName = options?.azureResourceName || getProviderEnvValue("AZURE_OPENAI_RESOURCE_NAME", options?.env);

	let resolvedBaseUrl = baseUrl;

	if (!resolvedBaseUrl && resourceName) {
		resolvedBaseUrl = buildDefaultBaseUrl(resourceName);
	}

	if (!resolvedBaseUrl && model.baseUrl) {
		resolvedBaseUrl = model.baseUrl;
	}

	if (!resolvedBaseUrl) {
		throw new Error(
			"Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or pass azureBaseUrl, azureResourceName, or model.baseUrl.",
		);
	}

	return normalizeAzureBaseUrl(resolvedBaseUrl);
}

export function resolveAzureConfig(
	model: Pick<Model<Api>, "baseUrl">,
	options?: AzureEndpointOptions,
): { baseUrl: string; apiVersion: string } {
	return {
		baseUrl: resolveAzureBaseUrl(model, options),
		apiVersion:
			options?.azureApiVersion ||
			getProviderEnvValue("AZURE_OPENAI_API_VERSION", options?.env) ||
			DEFAULT_AZURE_API_VERSION,
	};
}

// Models that accept `prompt_cache_retention: "24h"` on Azure, verified 2026-11-08 against
// https://learn.microsoft.com/azure/foundry/openai/how-to/prompt-caching (no extra charge for either policy).
const AZURE_EXTENDED_RETENTION_MODELS = new Set([
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.3-codex",
	"gpt-5.2",
	"gpt-5.1-codex-max",
	"gpt-5.1",
	"gpt-5.1-codex",
	"gpt-5.1-codex-mini",
	"gpt-5.1-chat",
	"gpt-5",
	"gpt-5-codex",
	"gpt-4.1",
]);

/**
 * Whether an Azure Responses model takes the 24h retention policy. `compat.supportsLongCacheRetention` decides when set,
 * so a deployment-named custom model running a listed model can opt in; otherwise the model id must be on the list.
 */
export function azureAcceptsExtendedRetention(model: Model<Api>): boolean {
	const declared = (model.compat as { supportsLongCacheRetention?: boolean } | undefined)?.supportsLongCacheRetention;
	return declared ?? AZURE_EXTENDED_RETENTION_MODELS.has(model.id);
}

/**
 * Whether an Azure deployment opted in to OpenAI's explicit cache mode with `compat.supportsExplicitPromptCacheMode`.
 * Standard pay-as-you-go deployments of GPT-5.6 and later accept `prompt_cache_options` and a 12h TTL; provisioned
 * GPT-5.6 deployments reject breakpoints, and the adapter cannot tell the deployment types apart, so it is never assumed.
 */
export function azureSupportsExplicitPromptCacheMode(model: Pick<Model<Api>, "compat">): boolean {
	return (
		(model.compat as { supportsExplicitPromptCacheMode?: boolean } | undefined)?.supportsExplicitPromptCacheMode ===
		true
	);
}

/**
 * Whether the Azure request may use the long tier: the 12h TTL in explicit mode, unless
 * `compat.supportsLongCacheRetention: false`, and otherwise the 24h retention policy.
 */
export function azureSupportsLongCacheRetention(model: Model<Api>): boolean {
	if (!azureSupportsExplicitPromptCacheMode(model)) return azureAcceptsExtendedRetention(model);
	return (model.compat as { supportsLongCacheRetention?: boolean } | undefined)?.supportsLongCacheRetention !== false;
}

// GPT-6 Astra supports prompt cache breakpoints on Standard and PTU-M deployments; earlier models, GPT-5.6 included,
// do not on provisioned deployments. Verified 2026-11-08 against the prompt-caching page above. A 12h TTL is
// documented only for "supported Responses API deployments", so without the explicit-mode opt-in its breakpoints keep
// the 30m default in implicit mode.
const AZURE_BREAKPOINT_MODELS = new Set(["gpt-6-astra"]);

/** Whether an Azure Responses model gets 30m breakpoints on its leading instructions without explicit mode. */
export function azureSupportsInstructionBreakpoints(model: Pick<Model<Api>, "id">): boolean {
	return AZURE_BREAKPOINT_MODELS.has(model.id);
}

/** TTL of the 30m instruction breakpoints of an Azure model outside explicit mode (GPT-6 Astra), or undefined for none. */
export function azureInstructionCacheTtl(
	model: Pick<Model<Api>, "id" | "compat">,
	options: Pick<StreamOptions, "cacheRetention" | "instructionCacheRetention" | "env"> | undefined,
): "30m" | undefined {
	if (azureSupportsExplicitPromptCacheMode(model) || !azureSupportsInstructionBreakpoints(model)) return undefined;
	if (resolveCacheRetention(options?.cacheRetention, options?.env) === "none") return undefined;
	const instructions = resolveInstructionCacheRetention(options);
	return instructions === undefined || instructions === "none" ? undefined : "30m";
}
