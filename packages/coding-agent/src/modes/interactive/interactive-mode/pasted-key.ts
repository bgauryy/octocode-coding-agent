/**
 * What a pasted API key says about itself: some providers issue keys with a prefix of their own. A Claude subscription
 * token is refused for every provider; a key whose prefix belongs to another provider is flagged so the dialog can ask
 * before saving it. Only the provider is ever named, never the key.
 */

import {
	CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL,
	isClaudeSubscriptionToken,
} from "@octocodeai/octocode-ai/api/anthropic-messages/token";

/**
 * Distinctive key prefixes and the provider that issues them; `alsoFor` lists providers that take the same keys. A bare
 * `sk-` is left out: OpenAI, DeepSeek, Moonshot and others all issue keys that start with it.
 */
const KEY_PREFIXES: ReadonlyArray<{ prefix: string; provider: string; alsoFor?: readonly string[] }> = [
	{ prefix: "sk-ant-api", provider: "anthropic" },
	{ prefix: "sk-or-", provider: "openrouter" },
	{ prefix: "sk-proj-", provider: "openai" },
	{ prefix: "sk-svcacct-", provider: "openai" },
	{ prefix: "ghu_", provider: "github-copilot" },
	{ prefix: "gho_", provider: "github-copilot" },
	{ prefix: "gsk_", provider: "groq" },
	{ prefix: "xai-", provider: "xai" },
	{ prefix: "hf_", provider: "huggingface" },
	{ prefix: "AIza", provider: "google", alsoFor: ["google-vertex"] },
	{ prefix: "nvapi-", provider: "nvidia" },
	{ prefix: "csk-", provider: "cerebras" },
];

export type PastedKeyCheck =
	| { kind: "ok" }
	/** Never saved, for any provider. */
	| { kind: "refuse"; message: string }
	/** The prefix belongs to `owner`, not the provider the key is being saved for. */
	| { kind: "mismatch"; owner: string };

/** Checks a key pasted for `providerId` against the known prefixes. */
export function checkPastedKey(providerId: string, key: string): PastedKeyCheck {
	if (isClaudeSubscriptionToken(key)) return { kind: "refuse", message: CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL };
	const trimmed = key.trim();
	const match = KEY_PREFIXES.find((entry) => trimmed.startsWith(entry.prefix));
	if (!match || match.provider === providerId || match.alsoFor?.includes(providerId)) return { kind: "ok" };
	return { kind: "mismatch", owner: match.provider };
}
