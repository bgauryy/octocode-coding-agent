import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { AwsV4Signer } from "aws4fetch";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { Model } from "../../types.ts";
import type { BedrockOptions } from "../bedrock-converse-stream/types.ts";
import { buildBedrockClientConfig } from "../bedrock-converse-stream/client-config.ts";
import { isAnthropicClaudeModel } from "../bedrock-converse-stream/model-match.ts";

export function bedrockNetworkFetch(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
	observe: (response: Response) => void,
): (fetch: typeof globalThis.fetch) => typeof globalThis.fetch {
	const config = buildBedrockClientConfig(model, options);
	return (fetch) => async (input, init) => {
		const headers = new Headers(init?.headers);
		const reserved = [...headers.keys()].filter(
			(key) => key === "authorization" || key === "host" || key.startsWith("x-amz-"),
		);
		for (const key of reserved) headers.delete(key);
		const skipAuth = getProviderEnvValue("AWS_BEDROCK_SKIP_AUTH", options.env) === "1";
		const bearer = typeof config.apiKey === "string" ? config.apiKey : undefined;
		if (!skipAuth && bearer) headers.set("authorization", `Bearer ${bearer}`);
		else if (!skipAuth) {
			const credentials = await config.credentialProvider!();
			const signer = new AwsV4Signer({
				url: input instanceof Request ? input.url : input.toString(),
				method: init?.method ?? "POST",
				headers,
				body: init?.body as string,
				region: config.region,
				service: "bedrock",
				...credentials,
			});
			const signed = await signer.sign();
			const response = await fetch(input, { ...init, headers: signed.headers });
			observe(response);
			return response;
		}
		const response = await fetch(input, { ...init, headers });
		observe(response);
		return response;
	};
}

export function bedrockSdkModel(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
	fetch: typeof globalThis.fetch,
) {
	return createAmazonBedrock({
		...buildBedrockClientConfig(model, options),
		apiKey: () => "octocode-sign-at-network-boundary",
		fetch,
	})(model.id, isAnthropicClaudeModel(model) ? { modelFamily: "anthropic" } : undefined);
}
