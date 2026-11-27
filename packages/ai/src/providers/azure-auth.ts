import { apiKeyEnvVars } from "../auth/api-key-env-vars.ts";
import { askCustomHost, simpleHostOption } from "../auth/endpoint.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import type { ApiKeyAuth } from "../auth/types.ts";

const AZURE_RESOURCE_URL_EXAMPLE = "https://my-resource.openai.azure.com/openai/v1";

/** Azure v1 supports resource keys and Microsoft Entra bearer tokens; both may be saved with the resource URL. */
export function azureAuth(): ApiKeyAuth {
	const keys = envApiKeyAuth(
		"Azure OpenAI API key",
		apiKeyEnvVars("azure"),
		undefined,
		undefined,
		AZURE_RESOURCE_URL_EXAMPLE,
	);
	const host = simpleHostOption(AZURE_RESOURCE_URL_EXAMPLE);
	return {
		name: "Azure API key or Microsoft Entra token",
		host,
		login: async (interaction) => {
			const method = await interaction.prompt({
				type: "select",
				message: "Select Azure authentication:",
				options: [
					{ id: "api-key", label: "Azure OpenAI API key" },
					{ id: "entra", label: "Microsoft Entra access token" },
				],
			});
			if (method === "api-key") return keys.login!(interaction);
			if (method !== "entra") throw new Error("Unknown Azure authentication method");
			interaction.notify({
				type: "info",
				message:
					"Obtain a token for https://cognitiveservices.azure.com/.default using Azure Identity or Azure CLI. Tokens expire; refresh AZURE_OPENAI_AD_TOKEN externally or use the SDK's azureADTokenProvider option.",
			});
			const token = (
				await interaction.prompt({ type: "secret", message: "Enter Microsoft Entra access token" })
			).trim();
			interaction.signal.throwIfAborted();
			if (!token) throw new Error("Microsoft Entra access token is empty");
			const endpoint = await askCustomHost(interaction, "Azure resource", host);
			return { type: "api_key", env: { AZURE_OPENAI_AD_TOKEN: token }, ...(endpoint ? { endpoint } : {}) };
		},
		resolve: async (input) => {
			// A saved resource URL beats AZURE_OPENAI_BASE_URL and the resource name in the environment.
			const baseUrl = input.credential?.endpoint?.baseUrl;
			const stored = baseUrl ? { ...input.credential?.env, AZURE_OPENAI_BASE_URL: baseUrl } : input.credential?.env;
			if (input.credential?.key) {
				const resolved = await keys.resolve(input);
				return resolved && stored ? { ...resolved, env: stored } : resolved;
			}
			const storedToken = input.credential?.env?.AZURE_OPENAI_AD_TOKEN?.trim();
			const token = storedToken || (await input.ctx.env("AZURE_OPENAI_AD_TOKEN"))?.trim();
			input.signal.throwIfAborted();
			if (token)
				return {
					auth: { headers: { Authorization: `Bearer ${token}`, "api-key": null } },
					env: stored,
					source: storedToken ? "stored Entra token" : "AZURE_OPENAI_AD_TOKEN",
				};
			return keys.resolve(input);
		},
	};
}
