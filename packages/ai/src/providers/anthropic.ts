import {
	CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL,
	carriesClaudeSubscriptionToken,
	isClaudeSubscriptionToken,
} from "../api/anthropic-messages/token.ts";
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { askCustomHost, endpointEnv, simpleHostOption } from "../auth/endpoint.ts";
import type { ApiKeyAuth, AuthResult } from "../auth/types.ts";
import { verifyByRequest } from "../auth/verify.ts";
import {
	ANTHROPIC_API_KEY_ENV_ORDER,
	ANTHROPIC_AUTH_TOKEN_ENV,
	ANTHROPIC_FEDERATION_RULE_ID_ENV,
	ANTHROPIC_IDENTITY_TOKEN_FILE_ENV,
	ANTHROPIC_ORGANIZATION_ID_ENV,
	ANTHROPIC_SERVICE_ACCOUNT_ID_ENV,
	ANTHROPIC_WORKSPACE_ID_ENV,
} from "../env-api-keys.ts";
import { createProvider, type Provider } from "../models.ts";
import type { ProviderEnv } from "../types.ts";
import { ModelsError } from "../utils/models-error.ts";
import { ANTHROPIC_MODELS } from "./anthropic.models.ts";

const ANTHROPIC_HOST = simpleHostOption("https://llm.example.com");

function anthropicApiKeyAuth(): ApiKeyAuth {
	return {
		name: "Anthropic API key",
		host: ANTHROPIC_HOST,
		keyPage: "https://platform.claude.com/settings/keys",
		verify: async ({ key, signal }) =>
			verifyByRequest(
				"https://api.anthropic.com/v1/models",
				{ "x-api-key": key, "anthropic-version": "2023-06-01" },
				signal,
			),
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			// Pasted keys often carry a newline or spaces; an empty answer is no key, so nothing is saved.
			const key = (
				await interaction.prompt({
					type: "secret",
					message: "Enter an Anthropic API key (Claude Console)",
				})
			).trim();
			interaction.signal.throwIfAborted();
			if (!key) throw new ModelsError("auth", "No Anthropic API key was entered. Nothing was saved.");
			// A Claude subscription token is never saved: Anthropic allows it only in Claude Code.
			if (isClaudeSubscriptionToken(key)) throw new Error(CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL);
			const endpoint = await askCustomHost(interaction, "Anthropic", ANTHROPIC_HOST);
			return { type: "api_key", key, ...(endpoint ? { endpoint } : {}) };
		},
		// A Claude subscription token, saved or set in the environment, configures nothing: no model of
		// this provider is offered. `resolve` still returns it, so a request names the reason and hosts can explain it.
		check: async (input) => {
			const resolved = await resolveAnthropicAuth(input);
			if (!resolved || carriesClaudeSubscriptionToken(resolved.auth.apiKey, resolved.auth.headers)) return undefined;
			return { type: "api_key", source: resolved.source };
		},
		resolve: resolveAnthropicAuth,
	};
}

async function resolveAnthropicAuth({
	ctx,
	credential,
	signal,
}: Parameters<ApiKeyAuth["resolve"]>[0]): Promise<AuthResult | undefined> {
	signal.throwIfAborted();
	if (credential?.key) {
		return { auth: { apiKey: credential.key }, env: endpointEnv(credential), source: "stored credential" };
	}

	const authToken = await ctx.env(ANTHROPIC_AUTH_TOKEN_ENV);
	signal.throwIfAborted();
	if (authToken) {
		return {
			auth: { headers: { Authorization: `Bearer ${authToken}` } },
			source: ANTHROPIC_AUTH_TOKEN_ENV,
		};
	}

	// A request refuses a subscription token in ANTHROPIC_OAUTH_TOKEN with the reason, rather than reporting no key.
	for (const envVar of ANTHROPIC_API_KEY_ENV_ORDER) {
		const apiKey = await ctx.env(envVar);
		signal.throwIfAborted();
		if (apiKey) return { auth: { apiKey }, source: envVar };
	}

	// Workload identity federation: the Anthropic SDK exchanges the identity
	// token for a short-lived access token and refreshes it itself. Last in
	// line so keys and ANTHROPIC_AUTH_TOKEN keep winning, as in the SDK. The
	// ids are provider config rather than auth, so they travel in `env`.
	const federation: ProviderEnv = {};
	for (const envVar of [
		ANTHROPIC_FEDERATION_RULE_ID_ENV,
		ANTHROPIC_ORGANIZATION_ID_ENV,
		ANTHROPIC_IDENTITY_TOKEN_FILE_ENV,
	]) {
		const value = await ctx.env(envVar);
		signal.throwIfAborted();
		if (!value) return undefined;
		federation[envVar] = value;
	}
	for (const envVar of [ANTHROPIC_SERVICE_ACCOUNT_ID_ENV, ANTHROPIC_WORKSPACE_ID_ENV]) {
		const value = await ctx.env(envVar);
		signal.throwIfAborted();
		if (value) federation[envVar] = value;
	}
	return { auth: {}, env: federation, source: "workload identity federation" };
}

export function anthropicProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "anthropic",
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		auth: {
			apiKey: anthropicApiKeyAuth(),
		},
		models: Object.values(ANTHROPIC_MODELS),
		api: anthropicMessagesApi(),
	});
}
