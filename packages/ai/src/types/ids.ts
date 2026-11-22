/** Identifiers of the built-in APIs and providers; custom strings are accepted alongside them. */
export type KnownApi =
	| "openai-completions"
	| "mistral-conversations"
	| "openai-responses"
	| "azure-openai-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-vertex";

export type Api = KnownApi | (string & {});

export type KnownImageApi = "openrouter-images";

export type ImageApi = KnownImageApi | (string & {});

export type KnownClassifierApi = "typesafe-system-one" | "cloudflare-workers-ai-system-one" | "openai-decisions";

export type ClassifierApi = KnownClassifierApi | (string & {});

/** Required provider catalogs, available before generated model data is hydrated. */
export const KNOWN_PROVIDER_IDS = [
	"amazon-bedrock",
	"ant-ling",
	"anthropic",
	"azure",
	"baseten",
	"cerebras",
	"cloudflare-ai-gateway",
	"cloudflare-workers-ai",
	"deepseek",
	"fireworks",
	"github-copilot",
	"google",
	"google-vertex",
	"groq",
	"huggingface",
	"kimi-coding",
	"meta",
	"minimax",
	"minimax-cn",
	"mistral",
	"moonshotai",
	"moonshotai-cn",
	"nvidia",
	"openai",
	"opencode",
	"opencode-go",
	"openrouter",
	"qwen-token-plan",
	"qwen-token-plan-cn",
	"qwen-token-plan-individual",
	"together",
	"typesafe",
	"vercel-ai-gateway",
	"xai",
	"xiaomi",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-sgp",
	"zai",
	"zai-coding-cn",
] as const;
export type KnownProvider = (typeof KNOWN_PROVIDER_IDS)[number];
// oxlint-disable-next-line typescript/no-redundant-type-constituents -- names the built-in providers while accepting custom provider IDs
export type ProviderId = KnownProvider | string;
