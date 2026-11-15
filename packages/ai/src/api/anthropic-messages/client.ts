import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import {
	ANTHROPIC_FEDERATION_RULE_ID_ENV,
	ANTHROPIC_IDENTITY_TOKEN_FILE_ENV,
	ANTHROPIC_ORGANIZATION_ID_ENV,
	ANTHROPIC_SERVICE_ACCOUNT_ID_ENV,
	ANTHROPIC_WORKSPACE_ID_ENV,
} from "../../env-api-keys.ts";
import { hasProviderHeader } from "../../utils/headers.ts";
import type { Model, ProviderEnv, ProviderHeaders } from "../../types.ts";
import { getProviderCapabilities } from "../../utils/provider-capabilities.ts";
import { getUserAgent } from "../../utils/user-agent.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import { getAnthropicCompat } from "./compat.ts";

function mergeHeaders(...headerSources: (ProviderHeaders | undefined)[]): ProviderHeaders {
	const merged: ProviderHeaders = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

/** Sent on every request so the SDK's own default (newer SDKs move to versions that reject sampling parameters) never applies. */
export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

function mergeClientHeaders(...headerSources: (ProviderHeaders | undefined)[]): ProviderHeaders {
	return mergeHeaders(
		{ "User-Agent": getUserAgent(), "anthropic-version": DEFAULT_ANTHROPIC_VERSION },
		...headerSources,
	);
}

function hasRequestAuth(apiKey: string | undefined, headers: ProviderHeaders | undefined): boolean {
	return (
		!!apiKey ||
		hasProviderHeader(headers, "authorization") ||
		hasProviderHeader(headers, "x-api-key") ||
		hasProviderHeader(headers, "cf-aig-authorization")
	);
}

export function assertRequestAuth(
	provider: string,
	apiKey: string | undefined,
	headers: ProviderHeaders | undefined,
): void {
	if (!hasRequestAuth(apiKey, headers)) throw new Error(`No API key for provider: ${provider}`);
}

/**
 * Anthropic SDK client that never runs the SDK's own credential chain
 * (ANTHROPIC_PROFILE config files, federation env vars). Without this, every
 * client built with `apiKey: null, authToken: null` for header-owned auth would
 * also resolve and exchange SDK credentials behind Octocode's auth resolver.
 */
class HeaderAuthAnthropic extends Anthropic {
	protected override _shouldResolveDefaultCredentials(): boolean {
		return false;
	}
}

type AnthropicFederationConfig = NonNullable<ClientOptions["config"]>;

/**
 * Workload identity federation config from the ANTHROPIC_* variables the
 * Anthropic SDK documents; the SDK performs the token exchange and refresh.
 * Only for the anthropic provider, since the exchange is an Anthropic API
 * endpoint, and only when no key or auth header was resolved.
 */
export function getAnthropicFederation(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
	headers: ProviderHeaders | undefined,
	env: ProviderEnv | undefined,
): AnthropicFederationConfig | undefined {
	if (model.provider !== "anthropic" || hasRequestAuth(apiKey, headers)) return undefined;
	const federationRuleId = getProviderEnvValue(ANTHROPIC_FEDERATION_RULE_ID_ENV, env);
	const organizationId = getProviderEnvValue(ANTHROPIC_ORGANIZATION_ID_ENV, env);
	const identityTokenFile = getProviderEnvValue(ANTHROPIC_IDENTITY_TOKEN_FILE_ENV, env);
	if (!federationRuleId || !organizationId || !identityTokenFile) return undefined;
	return {
		organization_id: organizationId,
		workspace_id: getProviderEnvValue(ANTHROPIC_WORKSPACE_ID_ENV, env),
		authentication: {
			type: "oidc_federation",
			federation_rule_id: federationRuleId,
			service_account_id: getProviderEnvValue(ANTHROPIC_SERVICE_ACCOUNT_ID_ENV, env),
			identity_token: { source: "file", path: identityTokenFile },
		},
	};
}

/**
 * The SDK caches the federated access token per client, but Octocode creates a client
 * per request. Keep one client for the current federation config and fetch, and
 * clone it per request with `withOptions()`, which shares the token cache.
 */
let federationClient: { key: string; fetch: typeof globalThis.fetch | undefined; client: Anthropic } | undefined;

export function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	dynamicHeaders?: Record<string, string>,
	sessionId?: string,
	federation?: AnthropicFederationConfig,
): Anthropic {
	if (getProviderCapabilities(model.provider).anthropicBearerAuth) {
		const client = new HeaderAuthAnthropic({
			apiKey: null,
			authToken: apiKey ?? null,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			fetch,
			defaultHeaders: mergeClientHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
				},
				model.headers,
				dynamicHeaders,
				optionsHeaders,
			),
		});

		return client;
	}

	// API key, header-owned auth, or workload identity federation.
	const compat = getAnthropicCompat(model);
	const sessionAffinityHeaders: ProviderHeaders = {};
	if (sessionId && compat.sendSessionAffinityHeaders) {
		const header = compat.sessionAffinityFormat === "openrouter" ? "x-session-id" : "x-session-affinity";
		sessionAffinityHeaders[header] = sessionId;
	}
	const defaultHeaders = mergeClientHeaders(
		{
			accept: "application/json",
			"anthropic-dangerous-direct-browser-access": "true",
		},
		sessionAffinityHeaders,
		model.headers,
		optionsHeaders,
	);
	if (federation) {
		const key = JSON.stringify([model.baseUrl, federation]);
		if (federationClient?.key !== key || federationClient.fetch !== fetch) {
			const client = new HeaderAuthAnthropic({
				apiKey: null,
				authToken: null,
				config: federation,
				baseURL: model.baseUrl,
				dangerouslyAllowBrowser: true,
				fetch,
			});
			federationClient = { key, fetch, client };
		}
		return federationClient.client.withOptions({ defaultHeaders });
	}

	// SDK 1.x sends `apiKey` as `Authorization: Bearer`. Anthropic-compatible endpoints and the pinned API version
	// expect `x-api-key`, so the key travels as that header and the SDK's Bearer header is omitted. Configured headers
	// come last, so a model or caller can still replace or omit (`null`) either one.
	const client = new HeaderAuthAnthropic({
		apiKey: apiKey ?? null,
		authToken: null,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: apiKey
			? mergeHeaders({ "x-api-key": apiKey, authorization: null }, defaultHeaders)
			: defaultHeaders,
	});

	return client;
}
