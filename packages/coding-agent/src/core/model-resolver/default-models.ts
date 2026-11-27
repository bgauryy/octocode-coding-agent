import type { Api, KnownProvider, Model } from "@octocodeai/octocode-ai";
import { normalizeModelId } from "../provider-composer/known-models.ts";

/** Default chat model IDs for providers with built-in chat models. */
export const defaultModelPerProvider: Partial<Record<KnownProvider, string>> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	"ant-ling": "Ring-2.6-1T",
	anthropic: "claude-opus-5-5",
	openai: "gpt-6.1-sol",
	azure: "gpt-5.4",
	nvidia: "nvidia/nemotron-3.5-super-vl-120b-a12b",
	deepseek: "deepseek-v4-pro",
	google: "gemini-3.1-pro-preview",
	"google-vertex": "gemini-3.1-pro-preview",
	"github-copilot": "gpt-6.1-sol",
	openrouter: "moonshotai/kimi-k2.6",
	"vercel-ai-gateway": "zai/glm-5.1",
	xai: "grok-4.7",
	groq: "openai/gpt-oss-120b",
	cerebras: "gpt-oss-120b",
	zai: "glm-5.3",
	"zai-coding-cn": "glm-5.3",
	mistral: "devstral-medium-latest",
	minimax: "MiniMax-M2.7",
	"minimax-cn": "MiniMax-M2.7",
	moonshotai: "kimi-k2.6",
	"moonshotai-cn": "kimi-k2.6",
	huggingface: "moonshotai/Kimi-K2.6",
	fireworks: "accounts/fireworks/models/kimi-k3",
	together: "moonshotai/Kimi-K3",
	baseten: "zai-org/GLM-5.2",
	opencode: "kimi-k2.6",
	"opencode-go": "kimi-k3",
	"kimi-coding": "kimi-for-coding",
	meta: "muse-spark-1.3",
	"cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.6",
	"cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.6",
	"qwen-token-plan": "qwen3.7-max",
	"qwen-token-plan-cn": "qwen3.7-max",
	"qwen-token-plan-individual": "qwen3.8-max",
	xiaomi: "mimo-v2.6-pro",
	"xiaomi-token-plan-cn": "mimo-v2.6-pro",
	"xiaomi-token-plan-ams": "mimo-v2.6-pro",
	"xiaomi-token-plan-sgp": "mimo-v2.6-pro",
};

/**
 * A provider without a built-in default (a gateway in models.json): its model that a vendor defaults to (a gateway's
 * `claude-opus-5-5` or `anthropic/claude-opus-5.5`), else its first available model.
 */
export function ownProviderDefault(available: readonly Model<Api>[], provider: string): Model<Api> | undefined {
	const own = available.filter((model) => model.provider === provider);
	const vendorDefaults = new Set(Object.values(defaultModelPerProvider).map((id) => normalizeModelId(id)));
	return own.find((model) => vendorDefaults.has(normalizeModelId(model.id))) ?? own[0];
}
