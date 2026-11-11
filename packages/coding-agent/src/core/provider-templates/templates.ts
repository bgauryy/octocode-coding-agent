import type { Api } from "@octocodeai/octocode-ai";
import type { ModelsJsonProvider } from "../model-config.ts";

/**
 * Starting points for a `models.json` provider Octocode does not build in: a hosted API-key service with a fixed host,
 * a gateway or proxy in front of a vendor API (the user gives the host), or a local server. Every host, API and key
 * variable below was checked against the vendor's documentation linked in `docs`. Hosts Octocode already builds in
 * (OpenRouter, Together, Fireworks, Groq, Cerebras, DeepSeek, Hugging Face, ...) have no template: sign in to them.
 */
export interface ProviderTemplate {
	/** The provider id the entry is saved under (a free variant when it is taken). */
	id: string;
	name: string;
	kind: "hosted" | "gateway" | "local";
	api: Api;
	/** The fixed API base URL; without it the user gives the host. */
	baseUrl?: string;
	/** Shown when asking for the host; a local server's documented default, used when the answer is empty. */
	hostHint?: string;
	/** Whether `hostHint` is a usable default (a local server's documented address). */
	hostDefault?: boolean;
	/** The key variable the vendor's documentation names; offered as a `$NAME` reference. */
	keyEnv?: string;
	/** `optional`: a local server that runs without a key unless one is configured on it. */
	key: "required" | "optional";
	/** The vendor's page that documents the host, API and key. */
	docs: string;
	/** Request differences for this host; only fields its documentation supports. */
	compat?: ModelsJsonProvider["compat"];
	/** The models.dev provider id whose listing supplies model ids and metadata. */
	catalog?: string;
}

/**
 * OpenAI-compatible servers document `max_tokens` (not `max_completion_tokens`), and neither OpenAI's `store` field nor
 * the `developer` role (Ollama's and DeepInfra's parameter tables, for example): send only what they document.
 */
const COMPATIBLE_SERVER = {
	maxTokensField: "max_tokens",
	supportsStore: false,
	supportsDeveloperRole: false,
} as const satisfies NonNullable<ModelsJsonProvider["compat"]>;

export const PROVIDER_TEMPLATES: readonly ProviderTemplate[] = [
	{
		id: "nebius",
		name: "Nebius Token Factory",
		kind: "hosted",
		api: "openai-completions",
		baseUrl: "https://api.tokenfactory.nebius.com/v1",
		keyEnv: "NEBIUS_API_KEY",
		key: "required",
		docs: "https://docs.tokenfactory.nebius.com/quickstart",
		compat: COMPATIBLE_SERVER,
		catalog: "nebius",
	},
	{
		id: "deepinfra",
		name: "DeepInfra",
		kind: "hosted",
		api: "openai-completions",
		baseUrl: "https://api.deepinfra.com/v1/openai",
		keyEnv: "DEEPINFRA_API_KEY",
		key: "required",
		docs: "https://docs.deepinfra.com/chat/overview",
		compat: COMPATIBLE_SERVER,
		catalog: "deepinfra",
	},
	{
		id: "sambanova",
		name: "SambaNova Cloud",
		kind: "hosted",
		api: "openai-completions",
		baseUrl: "https://api.sambanova.ai/v1",
		key: "required",
		docs: "https://docs.sambanova.ai/docs/en/get-started/api-keys-urls",
		compat: COMPATIBLE_SERVER,
		catalog: "sambanova",
	},
	{
		id: "hyperbolic",
		name: "Hyperbolic",
		kind: "hosted",
		api: "openai-completions",
		baseUrl: "https://api.hyperbolic.ai/inference/v1",
		key: "required",
		docs: "https://hyperbolic.ai/docs/inference/quickstart",
		compat: COMPATIBLE_SERVER,
	},
	{
		id: "ollama-cloud",
		name: "Ollama Cloud",
		kind: "hosted",
		api: "openai-completions",
		baseUrl: "https://ollama.com/v1",
		keyEnv: "OLLAMA_API_KEY",
		key: "required",
		docs: "https://docs.ollama.com/api/openai-compatibility",
		compat: COMPATIBLE_SERVER,
		catalog: "ollama-cloud",
	},
	{
		id: "anthropic-gateway",
		name: "Anthropic API gateway",
		kind: "gateway",
		api: "anthropic-messages",
		hostHint: "https://gateway.example.com/anthropic",
		key: "required",
		docs: "https://platform.claude.com/docs/en/api/overview",
	},
	{
		id: "openai-gateway",
		name: "OpenAI API gateway (Responses)",
		kind: "gateway",
		api: "openai-responses",
		hostHint: "https://gateway.example.com/openai/v1",
		key: "required",
		docs: "https://developers.openai.com/api/reference/resources/responses/methods/create",
	},
	{
		id: "google-gateway",
		name: "Google Gemini API gateway",
		kind: "gateway",
		api: "google-generative-ai",
		hostHint: "https://gateway.example.com/google/v1beta",
		key: "required",
		docs: "https://aistudio.google.com/api-reference",
	},
	{
		id: "litellm",
		name: "LiteLLM proxy",
		kind: "gateway",
		api: "openai-completions",
		hostHint: "http://localhost:4000",
		hostDefault: true,
		keyEnv: "LITELLM_API_KEY",
		key: "required",
		docs: "https://docs.litellm.ai/docs/proxy/user_keys",
		compat: COMPATIBLE_SERVER,
	},
	{
		id: "ollama",
		name: "Ollama",
		kind: "local",
		api: "openai-completions",
		hostHint: "http://localhost:11434/v1",
		hostDefault: true,
		key: "optional",
		docs: "https://docs.ollama.com/api/openai-compatibility",
		compat: COMPATIBLE_SERVER,
	},
	{
		id: "lmstudio",
		name: "LM Studio",
		kind: "local",
		api: "openai-completions",
		hostHint: "http://localhost:1234/v1",
		hostDefault: true,
		keyEnv: "LM_API_TOKEN",
		key: "optional",
		docs: "https://lmstudio.ai/docs/developer/openai-compat",
		compat: COMPATIBLE_SERVER,
	},
	{
		id: "vllm",
		name: "vLLM",
		kind: "local",
		api: "openai-completions",
		hostHint: "http://localhost:8000/v1",
		hostDefault: true,
		keyEnv: "VLLM_API_KEY",
		key: "optional",
		docs: "https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/",
		compat: COMPATIBLE_SERVER,
	},
];
