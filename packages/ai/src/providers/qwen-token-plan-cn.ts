import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { apiKeyEnvVars } from "../auth/api-key-env-vars.ts";
import { createProvider, type Provider } from "../models.ts";
import { QWEN_PLAN } from "./plans.ts";
import { QWEN_TOKEN_PLAN_CN_MODELS } from "./qwen-token-plan-cn.models.ts";

export function qwenTokenPlanCnProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "qwen-token-plan-cn",
		name: "Qwen Token Plan CN",
		baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		auth: { apiKey: envApiKeyAuth("Qwen Token Plan CN API key", apiKeyEnvVars("qwen-token-plan-cn")), plan: QWEN_PLAN },
		models: Object.values(QWEN_TOKEN_PLAN_CN_MODELS),
		api: openAICompletionsApi(),
	});
}
