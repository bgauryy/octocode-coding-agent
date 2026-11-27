import type { ProviderHeaders } from "../../types.ts";

/**
 * Why a Claude subscription token (`sk-ant-oat…`) is refused. Anthropic permits plan credentials only in Claude Code,
 * so Octocode never sends one; the plan is used through the Claude Code external agent instead.
 */
export const CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL =
	"This is a Claude subscription token. Anthropic allows it only in Claude Code. Connect Claude Code as an external agent in /providers (External agents).";

/** Whether a credential is a Claude subscription token rather than an API key. */
export function isClaudeSubscriptionToken(value: string): boolean {
	return value
		.trim()
		.replace(/^Bearer\s+/i, "")
		.startsWith("sk-ant-oat");
}

/** Whether the key, or an `Authorization` or `x-api-key` header, carries a Claude subscription token. */
export function carriesClaudeSubscriptionToken(
	apiKey: string | undefined,
	headers: ProviderHeaders | undefined,
): boolean {
	const values = [apiKey];
	for (const [name, value] of Object.entries(headers ?? {})) {
		const lower = name.toLowerCase();
		if ((lower === "authorization" || lower === "x-api-key") && typeof value === "string") values.push(value);
	}
	return values.some((value) => value !== undefined && isClaudeSubscriptionToken(value));
}

/**
 * Throws the refusal when the key or a header carries a Claude subscription token, so no request is built with it.
 */
export function refuseClaudeSubscriptionToken(apiKey: string | undefined, headers: ProviderHeaders | undefined): void {
	if (carriesClaudeSubscriptionToken(apiKey, headers)) throw new Error(CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL);
}
