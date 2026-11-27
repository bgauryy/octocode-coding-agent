export interface ModelDiscoverySource {
	/** Public catalogs require no credential and do not prove account entitlement. */
	public?: boolean;
	/** Relative to the provider's configured API base URL. */
	path?: string;
	format?: "openai" | "anthropic" | "google";
	docs: string;
	note?: string;
}

const catalog = (docs: string, note: string): ModelDiscoverySource => ({ docs, note });
const list = (path: string, docs: string, format: ModelDiscoverySource["format"] = "openai"): ModelDiscoverySource => ({
	path,
	docs,
	format,
});

/** Only documented discovery routes are requested; API compatibility does not imply /models. */
export const MODEL_DISCOVERY_SOURCES: Readonly<Record<string, ModelDiscoverySource>> = {
	"amazon-bedrock": catalog(
		"https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html",
		"Use the regional Bedrock control-plane ListFoundationModels and GetFoundationModelAvailability APIs; the inference bearer token is not a control-plane credential.",
	),
	"ant-ling": catalog(
		"https://developer.ant-ling.com/en/docs/models/",
		"Use the vendor model catalog; no authenticated list contract verified.",
	),
	anthropic: list("v1/models", "https://platform.claude.com/docs/en/api/models/list", "anthropic"),
	azure: catalog(
		"https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/working-with-models",
		"Discover Azure deployments through the management plane; catalog model IDs are not deployment names.",
	),
	baseten: list("models", "https://docs.baseten.co/inference/model-apis/overview"),
	cerebras: list("models", "https://inference-docs.cerebras.ai/api-reference/models"),
	"cloudflare-ai-gateway": catalog(
		"https://developers.cloudflare.com/ai-gateway/",
		"A gateway can route multiple vendors; use each configured upstream's discovery contract.",
	),
	"cloudflare-workers-ai": catalog(
		"https://developers.cloudflare.com/api/resources/ai/methods/list/",
		"Use account-scoped GET /accounts/{account_id}/ai/models/search; this is separate from the OpenAI compatibility base.",
	),
	deepseek: list("models", "https://api-docs.deepseek.com/api/list-models"),
	fireworks: catalog(
		"https://docs.fireworks.ai/api-reference/list-models",
		"Management model lists require an account ID and include deployable models; consult deployments for inference availability.",
	),
	"github-copilot": list("models", "https://github.com/microsoft/vscode-copilot-chat"),
	google: list("models", "https://ai.google.dev/api/models", "google"),
	"google-vertex": catalog(
		"https://cloud.google.com/vertex-ai/generative-ai/docs/learn/models",
		"Publisher models and regional deployment availability require Google Cloud authentication; use the Vertex publisher-model APIs.",
	),
	groq: list("models", "https://console.groq.com/docs/models"),
	huggingface: {
		...list("models", "https://huggingface.co/docs/inference-providers/en/hub-api"),
		public: true,
		note: "Public routing catalog; listing does not prove account entitlement.",
	},
	"kimi-coding": catalog(
		"https://github.com/MoonshotAI/kimi-cli",
		"Subscription entitlements are separate from Moonshot's pay-as-you-go /models catalog.",
	),
	meta: catalog(
		"https://dev.meta.ai/docs/overview",
		"Use the vendor catalog; no stable third-party account-specific model-list contract verified.",
	),
	minimax: list(
		"v1/models",
		"https://platform.minimax.io/docs/api-reference/models/anthropic/list-models",
		"anthropic",
	),
	"minimax-cn": list(
		"v1/models",
		"https://platform.minimax.cn/docs/api-reference/models/anthropic/list-models",
		"anthropic",
	),
	mistral: list("v1/models", "https://docs.mistral.ai/api/endpoint/models"),
	moonshotai: list("models", "https://platform.kimi.ai/docs/api/list-models"),
	"moonshotai-cn": list("models", "https://platform.kimi.com/docs/api/list-models"),
	nvidia: list("models", "https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html"),
	openai: list("models", "https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference"),
	opencode: {
		...list("v1/models", "https://opencode.ai/v2/docs/console/models/"),
		public: true,
		note: "Public Console catalog; listing does not prove account entitlement.",
	},
	"opencode-go": catalog(
		"https://opencode.ai/v2/docs/console/go/",
		"Use the plan's published model list; Console pay-as-you-go discovery does not establish Go entitlement.",
	),
	openrouter: list("models/user", "https://openrouter.ai/docs/api-reference/models/get-models-user"),
	"qwen-token-plan": catalog(
		"https://help.aliyun.com/en/model-studio/base-url",
		"Use the dedicated Token Plan supported-model list and region; standard Model Studio models do not establish plan entitlement.",
	),
	"qwen-token-plan-cn": catalog(
		"https://help.aliyun.com/en/model-studio/base-url",
		"Use the Beijing Token Plan supported-model list and plan-specific key.",
	),
	"qwen-token-plan-individual": catalog(
		"https://help.aliyun.com/en/model-studio/chatbox",
		"Use the Individual Token Plan supported-model list and key.",
	),
	together: catalog(
		"https://docs.together.ai/docs/serverless/models",
		"Use the serverless catalog. Current SDK model resources describe project-owned deployment models; the legacy /v1/models list is not assumed to remain a stable serverless contract.",
	),
	typesafe: catalog(
		"https://docs.typesafe.ai/api/system-one",
		"Use the System One model catalog; no /models contract verified.",
	),
	"vercel-ai-gateway": {
		...list("v1/models", "https://vercel.com/docs/ai-gateway/models-and-providers"),
		public: true,
		note: "Public gateway catalog; listing does not prove account entitlement.",
	},
	xai: list("models", "https://docs.x.ai/developers/advanced-api-usage/regions"),
	xiaomi: catalog(
		"https://mimo.mi.com/docs/quick-start/first-api-call",
		"Use the current vendor model list; no /models contract verified.",
	),
	"xiaomi-token-plan-ams": catalog(
		"https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription",
		"Use the European plan catalog and key; availability differs from pay-as-you-go.",
	),
	"xiaomi-token-plan-cn": catalog(
		"https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription",
		"Use the China plan catalog and key.",
	),
	"xiaomi-token-plan-sgp": catalog(
		"https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription",
		"Use the Singapore plan catalog and key.",
	),
	zai: catalog(
		"https://docs.z.ai/devpack/quick-start",
		"Use the Coding Plan supported-model list; general API keys and catalogs are separate.",
	),
	"zai-coding-cn": catalog(
		"https://docs.bigmodel.cn/cn/coding-plan/quick-start",
		"Use the China Coding Plan supported-model list and key.",
	),
};
