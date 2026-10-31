import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { apiKeyEnvVars } from "../auth/api-key-env-vars.ts";
import { createProvider, type Provider } from "../models.ts";
import { QWEN_TOKEN_PLAN_MODELS } from "./qwen-token-plan.models.ts";

export function qwenTokenPlanProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "qwen-token-plan",
		name: "Qwen Token Plan",
		baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
		auth: { apiKey: envApiKeyAuth("Qwen Token Plan API key", apiKeyEnvVars("qwen-token-plan")) },
		models: Object.values(QWEN_TOKEN_PLAN_MODELS),
		api: openAICompletionsApi(),
	});
}
