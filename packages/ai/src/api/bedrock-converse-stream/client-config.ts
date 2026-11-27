import type { AmazonBedrockProviderSettings } from "@ai-sdk/amazon-bedrock";
import type { Model } from "../../types.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { BedrockOptions } from "./types.ts";
import { bedrockProfileRegion } from "./profile-region.ts";

export function getConfiguredBedrockRegion(options: BedrockOptions): string | undefined {
	return (
		options.region ||
		getProviderEnvValue("AWS_REGION", options.env) ||
		getProviderEnvValue("AWS_DEFAULT_REGION", options.env) ||
		bedrockProfileRegion(options) ||
		undefined
	);
}

export function buildBedrockClientConfig(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): AmazonBedrockProviderSettings {
	const configuredRegion = getConfiguredBedrockRegion(options);
	const endpointRegion = new URL(model.baseUrl).hostname.match(
		/^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/,
	)?.[1];
	const explicitEndpoint = !endpointRegion || (!configuredRegion && !getProviderEnvValue("AWS_PROFILE"));
	const region =
		model.id.match(/^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):/)?.[1] ||
		configuredRegion ||
		(explicitEndpoint ? endpointRegion : undefined) ||
		"us-east-1";
	const apiKey =
		options.bearerToken || options.apiKey || getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", options.env) || "";
	const accessKeyId = getProviderEnvValue("AWS_ACCESS_KEY_ID", options.env);
	const secretAccessKey = getProviderEnvValue("AWS_SECRET_ACCESS_KEY", options.env);
	const sessionToken = getProviderEnvValue("AWS_SESSION_TOKEN", options.env);
	const explicitProfile = options.profile || options.env?.AWS_PROFILE;
	const credentialProvider =
		options.credentialProvider ??
		(!explicitProfile && accessKeyId && secretAccessKey
			? async () => ({ accessKeyId, secretAccessKey, sessionToken })
			: async () => {
					const { fromNodeProviderChain } = await import("@aws-sdk/credential-providers");
					return fromNodeProviderChain({
						profile: explicitProfile || getProviderEnvValue("AWS_PROFILE", options.env) || undefined,
						filepath: getProviderEnvValue("AWS_SHARED_CREDENTIALS_FILE", options.env) || undefined,
						configFilepath: getProviderEnvValue("AWS_CONFIG_FILE", options.env) || undefined,
					})();
				});
	return {
		region,
		baseURL: explicitEndpoint ? model.baseUrl : undefined,
		apiKey,
		...(accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey, sessionToken } : {}),
		credentialProvider,
	};
}
