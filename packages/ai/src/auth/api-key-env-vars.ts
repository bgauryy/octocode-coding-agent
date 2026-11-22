/**
 * Environment variables that can hold each provider's API key, in precedence order. The one table behind provider
 * auth (`envApiKeyAuth`) and env discovery (`findEnvKeys`, `getEnvApiKey`). Anthropic is not listed: its variables
 * are special-cased in `env-api-keys.ts` (an auth token must be sent as a bearer token, not as an API key).
 */
const API_KEY_ENV_VARS = {
	"ant-ling": ["ANT_LING_API_KEY"],
	azure: ["AZURE_OPENAI_API_KEY"],
	baseten: ["BASETEN_API_KEY"],
	cerebras: ["CEREBRAS_API_KEY"],
	"cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"],
	"cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"],
	deepseek: ["DEEPSEEK_API_KEY"],
	fireworks: ["FIREWORKS_API_KEY"],
	"github-copilot": ["COPILOT_GITHUB_TOKEN"],
	google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
	"google-vertex": ["GOOGLE_CLOUD_API_KEY"],
	groq: ["GROQ_API_KEY"],
	huggingface: ["HF_TOKEN"],
	"kimi-coding": ["KIMI_API_KEY"],
	meta: ["META_API_KEY", "MODEL_API_KEY"],
	minimax: ["MINIMAX_API_KEY"],
	"minimax-cn": ["MINIMAX_CN_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	moonshotai: ["MOONSHOT_API_KEY"],
	"moonshotai-cn": ["MOONSHOT_API_KEY"],
	nvidia: ["NVIDIA_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	opencode: ["OPENCODE_API_KEY"],
	"opencode-go": ["OPENCODE_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	"qwen-token-plan": ["QWEN_TOKEN_PLAN_API_KEY"],
	"qwen-token-plan-cn": ["QWEN_TOKEN_PLAN_CN_API_KEY"],
	"qwen-token-plan-individual": ["QWEN_TOKEN_PLAN_API_KEY"],
	together: ["TOGETHER_API_KEY"],
	typesafe: ["TYPESAFE_API_KEY"],
	"vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
	xai: ["XAI_API_KEY"],
	xiaomi: ["XIAOMI_API_KEY"],
	"xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
	"xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
	"xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
	zai: ["ZAI_API_KEY"],
	"zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
} as const satisfies Record<string, readonly string[]>;

type ApiKeyEnvProvider = keyof typeof API_KEY_ENV_VARS;

/** The API-key variables of a provider named in the table; an unlisted id is a compile-time error. */
export function apiKeyEnvVars(provider: ApiKeyEnvProvider): readonly string[] {
	return API_KEY_ENV_VARS[provider];
}

/** The API-key variables of any provider id, or `undefined` when none are declared. */
export function findApiKeyEnvVars(provider: string): readonly string[] | undefined {
	// Own keys only: an id such as `constructor` must not find an inherited property.
	return Object.hasOwn(API_KEY_ENV_VARS, provider)
		? (API_KEY_ENV_VARS as Readonly<Record<string, readonly string[]>>)[provider]
		: undefined;
}

/** The other providers that read the API-key variable `envVar`: a key set for one makes each of them look ready. */
export function providersSharingApiKeyEnvVar(envVar: string, provider: string): string[] {
	return Object.entries(API_KEY_ENV_VARS as Readonly<Record<string, readonly string[]>>)
		.filter(([id, names]) => id !== provider && names.includes(envVar))
		.map(([id]) => id);
}
