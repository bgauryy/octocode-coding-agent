import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { typesafeSystemOneApi } from "../api/typesafe-system-one.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { apiKeyEnvVars } from "../auth/api-key-env-vars.ts";
import { verifyByRequest } from "../auth/verify.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENCODE_CLASSIFIER_MODELS, OPENCODE_MODELS } from "./opencode.models.ts";
import { withOpenCodeSessionHeader } from "./opencode-headers.ts";

type OpenCodeApi = "anthropic-messages" | "google-generative-ai" | "openai-completions" | "openai-responses";

/**
 * OpenCode serves its free-tier chat models only to the OpenCode app: other clients get 429 `FreeUsageLimitError`
 * ("Free-tier chat models require OpenCode; use paid models or Go from other clients", OpenCode's Console docs). Those
 * models stay reachable through the OpenCode external agent. A paid model on a limited-time free price keeps its `after`.
 */
const freeTier = (cost: { input: number; output: number; after?: unknown }): boolean =>
	cost.input === 0 && cost.output === 0 && cost.after === undefined;

export function opencodeProvider(): Provider<OpenCodeApi> {
	return createProvider<OpenCodeApi>({
		id: "opencode",
		name: "OpenCode Zen",
		auth: {
			// The free model list answers 401 to a key OpenCode does not accept (checked 2026-11-10).
			apiKey: envApiKeyAuth(
				"OpenCode API key",
				apiKeyEnvVars("opencode"),
				"https://opencode.ai/console",
				({ key, signal }) =>
					verifyByRequest("https://opencode.ai/inference/v1/models", { Authorization: `Bearer ${key}` }, signal),
			),
		},
		models: [
			...Object.values(OPENCODE_MODELS).filter((model) => !freeTier(model.cost)),
			...Object.values(OPENCODE_CLASSIFIER_MODELS),
		],
		api: {
			"anthropic-messages": withOpenCodeSessionHeader(anthropicMessagesApi()),
			"google-generative-ai": withOpenCodeSessionHeader(googleGenerativeAIApi()),
			"openai-completions": withOpenCodeSessionHeader(openAICompletionsApi()),
			"openai-responses": withOpenCodeSessionHeader(openAIResponsesApi()),
		},
		// OpenCode Zen serves TypeSafe's System One protocol at /inference/systemone/v1/systemone.
		classifiers: { "typesafe-system-one": typesafeSystemOneApi() },
	});
}
