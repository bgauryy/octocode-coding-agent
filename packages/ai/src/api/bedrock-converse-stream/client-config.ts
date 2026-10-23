import type { Agent as HttpsAgent } from "node:https";
import type { BedrockRuntimeClientConfig } from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Model, ProviderEnv } from "../../types.ts";
import { resolveHttpProxyUrlForTarget } from "../../utils/node-http-proxy.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { BedrockOptions } from "./types.ts";

export function getConfiguredBedrockRegion(options: BedrockOptions): string | undefined {
	return (
		options.region ||
		getProviderEnvValue("AWS_REGION", options.env) ||
		getProviderEnvValue("AWS_DEFAULT_REGION", options.env) ||
		undefined
	);
}

function getConfiguredBedrockCredentials(env?: ProviderEnv): BedrockRuntimeClientConfig["credentials"] | undefined {
	const accessKeyId = getProviderEnvValue("AWS_ACCESS_KEY_ID", env);
	const secretAccessKey = getProviderEnvValue("AWS_SECRET_ACCESS_KEY", env);
	if (!accessKeyId || !secretAccessKey) {
		return undefined;
	}
	const sessionToken = getProviderEnvValue("AWS_SESSION_TOKEN", env);
	return {
		accessKeyId,
		secretAccessKey,
		...(sessionToken ? { sessionToken } : {}),
	};
}

function getStandardBedrockEndpointRegion(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) {
		return undefined;
	}

	try {
		const { hostname } = new URL(baseUrl);
		const match = hostname.toLowerCase().match(/^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/);
		return match?.[1];
	} catch {
		return undefined;
	}
}

function shouldUseExplicitBedrockEndpoint(
	baseUrl: string,
	configuredRegion: string | undefined,
	hasAmbientConfiguredProfile: boolean,
): boolean {
	const endpointRegion = getStandardBedrockEndpointRegion(baseUrl);
	if (!endpointRegion) {
		return true;
	}

	return !configuredRegion && !hasAmbientConfiguredProfile;
}

/** Client configuration for one request: endpoint, region, credentials, proxy handler and bearer-token auth. */
export function buildBedrockClientConfig(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): BedrockRuntimeClientConfig {
	// A profile explicitly configured through pi's auth flow (the `profile`
	// option or scoped `AWS_PROFILE` on the stored credential's env) must win
	// over ambient AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY. The SDK default
	// chain already prefers a configured profile over env keys, but only when
	// `credentials` is not set on the client config. See #6957.
	const optionsProfile = options.profile || options.env?.AWS_PROFILE;
	const config: BedrockRuntimeClientConfig = {
		profile: optionsProfile || getProviderEnvValue("AWS_PROFILE", options.env),
	};
	const configuredRegion = getConfiguredBedrockRegion(options);
	const hasAmbientConfiguredProfile = Boolean(getProviderEnvValue("AWS_PROFILE"));
	const endpointRegion = getStandardBedrockEndpointRegion(model.baseUrl);
	const useExplicitEndpoint = shouldUseExplicitBedrockEndpoint(
		model.baseUrl,
		configuredRegion,
		hasAmbientConfiguredProfile,
	);

	// Only pin standard AWS Bedrock runtime endpoints when no region or ambient AWS_PROFILE is configured.
	// This preserves custom endpoints (VPC/proxy) from #3402 without forcing built-in
	// catalog defaults such as us-east-1 to override AWS_REGION/AWS_PROFILE.
	if (useExplicitEndpoint) {
		config.endpoint = model.baseUrl;
	}

	// Resolve bearer token for Bedrock API key auth.
	const skipAuth = getProviderEnvValue("AWS_BEDROCK_SKIP_AUTH", options.env) === "1";
	const bearerToken =
		options.bearerToken || options.apiKey || getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", options.env) || undefined;
	const useBearerToken = bearerToken !== undefined && !skipAuth;

	// in Node.js/Bun environment only
	if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
		// Region resolution: ARN-embedded > explicit option > env vars > SDK default chain.
		// When the model ID is an inference profile ARN, extract the region from it.
		// This avoids conflicts with AWS_REGION set for other services.
		const arnRegionMatch = model.id.match(/^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):/);
		if (arnRegionMatch) {
			config.region = arnRegionMatch[1];
		} else if (configuredRegion) {
			config.region = configuredRegion;
		} else if (endpointRegion && useExplicitEndpoint) {
			config.region = endpointRegion;
		} else if (!hasAmbientConfiguredProfile) {
			config.region = "us-east-1";
		}

		// Support proxies that don't need authentication
		if (skipAuth) {
			config.credentials = {
				accessKeyId: "dummy-access-key",
				secretAccessKey: "dummy-secret-key",
			};
		}

		const credentials = getConfiguredBedrockCredentials(options.env);
		if (!skipAuth && credentials && !optionsProfile) {
			config.credentials = credentials;
		}

		const proxyUrl = resolveHttpProxyUrlForTarget(model.baseUrl, options.env);
		if (proxyUrl) {
			// Bedrock runtime uses NodeHttp2Handler by default since v3.798.0, which is based
			// on `http2` module and has no support for http agent.
			// Use NodeHttpHandler to support HTTP(S) proxy agents.
			config.requestHandler = new NodeHttpHandler({
				httpAgent: new HttpProxyAgent(proxyUrl),
				httpsAgent: new HttpsProxyAgent(proxyUrl) as unknown as HttpsAgent,
			});
		} else if (getProviderEnvValue("AWS_BEDROCK_FORCE_HTTP1", options.env) === "1") {
			// Some custom endpoints require HTTP/1.1 instead of HTTP/2
			config.requestHandler = new NodeHttpHandler();
		}
	} else {
		// Non-Node environment (browser): fall back to us-east-1 since
		// there's no config file resolution available.
		config.region =
			configuredRegion || (endpointRegion && useExplicitEndpoint ? endpointRegion : undefined) || "us-east-1";
	}

	if (useBearerToken) {
		config.token = { token: bearerToken };
		config.authSchemePreference = ["httpBearerAuth"];
	}

	return config;
}
