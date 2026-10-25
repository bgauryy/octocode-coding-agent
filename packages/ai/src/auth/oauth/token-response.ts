import type { OAuthCredential } from "../types.ts";

/** Validate before saving; errors must never contain tokens or response bodies. */
export function parseOAuthTokenResponse(
	value: unknown,
	provider: string,
	options: { previousRefresh?: string; expiryMarginMs?: number } = {},
): OAuthCredential {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${provider} OAuth response must be an object`);
	const data = value as Record<string, unknown>;
	const access = data.access_token;
	const refresh = data.refresh_token ?? options.previousRefresh;
	if (typeof access !== "string" || !access.trim())
		throw new Error(`${provider} OAuth response has invalid access_token`);
	if (typeof refresh !== "string" || !refresh.trim())
		throw new Error(`${provider} OAuth response has invalid refresh_token`);
	const expiresIn = data.expires_in;
	if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0)
		throw new Error(`${provider} OAuth response has invalid expires_in`);
	const margin = Math.min(options.expiryMarginMs ?? 0, expiresIn * 100);
	return { type: "oauth", access, refresh, expires: Date.now() + expiresIn * 1000 - margin };
}
