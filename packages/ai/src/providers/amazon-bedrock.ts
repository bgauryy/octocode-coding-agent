import { endpointEnv, endpointFromAnswers } from "../auth/endpoint.ts";
import type { ApiKeyAuth, ApiKeyCredential } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { AMAZON_BEDROCK_MODELS } from "./amazon-bedrock.models.ts";
import {
	BEDROCK_API_CHOICES,
	BEDROCK_HOST,
	bedrockEndpoint,
	bedrockHostFamily,
	bedrockStreams,
} from "./amazon-bedrock-endpoint.ts";

const ENDPOINT_HINT =
	"Custom endpoint host (optional, Enter keeps the default AWS endpoint). For a fully custom host, add the 'Custom OpenAI-compatible host' template in /providers instead";

/**
 * The optional custom host and region of a login. They are saved with the credential: a `bedrock-runtime.*` host
 * speaks the Converse stream and `bedrock-mantle.*` the OpenAI-compatible APIs, so only an unknown host asks which.
 */
async function askEndpoint(
	interaction: Parameters<NonNullable<ApiKeyAuth["login"]>>[0],
	method: string,
): Promise<ApiKeyCredential["endpoint"]> {
	const host = await interaction.prompt({
		type: "text",
		message: ENDPOINT_HINT,
		placeholder: "bedrock-runtime.eu-central-1.amazonaws.com",
		storedWithKey: true,
	});
	interaction.signal.throwIfAborted();
	if (!host.trim()) return undefined;
	const family = bedrockHostFamily(endpointFromAnswers(host, "")?.baseUrl ?? "");
	if (family === "mantle" && method !== "bearer-token") {
		throw new Error("A bedrock-mantle host needs an Amazon Bedrock API key (bearer token), not AWS credentials.");
	}
	const region = await interaction.prompt({
		type: "text",
		message: "AWS region for this host (optional)",
		placeholder: "eu-central-1",
		storedWithKey: true,
	});
	interaction.signal.throwIfAborted();
	let api: string | undefined;
	if (family === "unknown") {
		api = await interaction.prompt({
			type: "select",
			message: "Which API does this host serve?",
			options: BEDROCK_API_CHOICES.map((choice) => ({ ...choice })),
		});
		interaction.signal.throwIfAborted();
	}
	return bedrockEndpoint({ host, region, ...(api ? { api } : {}) }, method);
}

/**
 * Bedrock accepts a bearer token or the AWS SDK's default credential chain.
 * The login flow can store a token/profile choice; resolve also detects ambient
 * AWS credentials without copying them into Octocode's credential store.
 */
const bedrockAuth: ApiKeyAuth = {
	name: "AWS credentials or bearer token",
	host: BEDROCK_HOST,
	login: async (interaction) => {
		interaction.signal.throwIfAborted();
		const method = await interaction.prompt({
			type: "select",
			message: "Select Amazon Bedrock authentication method:",
			options: [
				{ id: "bearer-token", label: "Bearer token" },
				{ id: "aws-profile", label: "AWS profile" },
				{ id: "credential-chain", label: "Existing AWS credential chain" },
			],
		});
		interaction.signal.throwIfAborted();
		let credential: ApiKeyCredential;
		if (method === "bearer-token") {
			credential = {
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "Enter Amazon Bedrock bearer token" }),
			};
		} else {
			interaction.notify({
				type: "info",
				message: "Amazon Bedrock supports AWS profiles, IAM credentials, and role-based credentials.",
				links: [
					{
						label: "AWS credential provider chain",
						url: "https://docs.aws.amazon.com/sdkref/latest/guide/standardized-credentials.html",
					},
				],
			});
			if (method === "aws-profile") {
				credential = {
					type: "api_key",
					env: { AWS_PROFILE: await interaction.prompt({ type: "text", message: "Enter AWS profile name" }) },
				};
			} else if (method === "credential-chain") {
				await interaction.prompt({
					type: "text",
					message: "Configure AWS credentials, then press Enter to continue",
				});
				credential = { type: "api_key" };
			} else {
				throw new Error(`Unknown Amazon Bedrock auth method: ${method}`);
			}
		}
		interaction.signal.throwIfAborted();
		const endpoint = await askEndpoint(interaction, method);
		return endpoint ? { ...credential, endpoint } : credential;
	},
	resolve: async ({ ctx, credential, signal }) => {
		const env = async (name: string) => {
			signal.throwIfAborted();
			const value = await ctx.env(name);
			signal.throwIfAborted();
			return value;
		};
		if (credential?.key) {
			return { auth: { apiKey: credential.key }, env: endpointEnv(credential), source: "stored credential" };
		}
		// A stored profile is the user's explicit choice, so it outranks the environment, as a stored key does.
		if (credential?.env?.AWS_PROFILE) {
			return { auth: {}, env: endpointEnv(credential), source: "stored credential" };
		}
		if (await env("AWS_BEARER_TOKEN_BEDROCK")) return { auth: {}, source: "AWS_BEARER_TOKEN_BEDROCK" };
		if (await env("AWS_PROFILE")) return { auth: {}, env: endpointEnv(credential), source: "AWS_PROFILE" };
		if ((await env("AWS_ACCESS_KEY_ID")) && (await env("AWS_SECRET_ACCESS_KEY"))) {
			return { auth: {}, source: "AWS access keys" };
		}
		if (await env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")) return { auth: {}, source: "ECS task role" };
		if (await env("AWS_CONTAINER_CREDENTIALS_FULL_URI")) return { auth: {}, source: "ECS task role" };
		if (await env("AWS_WEB_IDENTITY_TOKEN_FILE")) return { auth: {}, source: "web identity token" };
		// An explicit credential-chain login delegates discovery (including IMDS and
		// credential_process) to the AWS SDK; no env marker or local key is required.
		if (credential) return { auth: {}, env: endpointEnv(credential), source: "stored credential" };
		for (const path of [
			(await env("AWS_SHARED_CREDENTIALS_FILE")) ?? "~/.aws/credentials",
			(await env("AWS_CONFIG_FILE")) ?? "~/.aws/config",
		]) {
			const exists = await ctx.fileExists(path);
			signal.throwIfAborted();
			if (exists) return { auth: {}, source: "AWS shared configuration" };
		}
		return undefined;
	},
};

export function amazonBedrockProvider(): Provider<"bedrock-converse-stream"> {
	return createProvider({
		id: "amazon-bedrock",
		name: "Amazon Bedrock",
		auth: { apiKey: bedrockAuth },
		models: Object.values(AMAZON_BEDROCK_MODELS),
		api: bedrockStreams(),
	});
}
