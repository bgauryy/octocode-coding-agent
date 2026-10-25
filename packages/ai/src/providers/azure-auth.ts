import { envApiKeyAuth } from "../auth/helpers.ts";
import type { ApiKeyAuth } from "../auth/types.ts";

/** Azure v1 supports resource keys and Microsoft Entra bearer tokens. */
export function azureAuth(): ApiKeyAuth {
	const keys = envApiKeyAuth("Azure OpenAI API key", ["AZURE_OPENAI_API_KEY"]);
	return {
		name: "Azure API key or Microsoft Entra token",
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
			const token = await interaction.prompt({ type: "secret", message: "Enter Microsoft Entra access token" });
			interaction.signal.throwIfAborted();
			if (!token.trim()) throw new Error("Microsoft Entra access token is empty");
			return { type: "api_key", env: { AZURE_OPENAI_AD_TOKEN: token } };
		},
		resolve: async (input) => {
			if (input.credential?.key) return keys.resolve(input);
			const token = input.credential?.env?.AZURE_OPENAI_AD_TOKEN ?? (await input.ctx.env("AZURE_OPENAI_AD_TOKEN"));
			input.signal.throwIfAborted();
			if (token)
				return {
					auth: { headers: { Authorization: `Bearer ${token}`, "api-key": null } },
					env: input.credential?.env,
					source: input.credential ? "stored Entra token" : "AZURE_OPENAI_AD_TOKEN",
				};
			return keys.resolve(input);
		},
	};
}
