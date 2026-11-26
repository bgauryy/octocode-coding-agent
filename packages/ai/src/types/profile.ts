/** The profile ids a models.json `profile` may name. */
export const PROVIDER_PROFILE_IDS = [
	"anthropic",
	"openai",
	"bedrock",
	"openrouter",
	"vercel",
	"opencode",
	"groq",
	"xiaomi",
	"zai",
	"together",
	"moonshot",
	"cloudflare-workers-ai",
	"cloudflare-ai-gateway",
	"nvidia",
	"ant-ling",
	"cerebras",
	"deepseek",
	"xai",
	"chutes",
] as const;

export type ProviderProfileId = (typeof PROVIDER_PROFILE_IDS)[number];
