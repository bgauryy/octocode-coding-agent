import { createPublicKey, type JsonWebKey, verify } from "node:crypto";

// OpenAI's discovery metadata publishes this issuer, JWKS URI, and RS256.
// https://auth.openai.com/.well-known/openid-configuration
const ISSUER = "https://auth.openai.com";
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

function jsonObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid OpenAI ID token data");
	}
	return value as Record<string, unknown>;
}

/** Verify the OIDC identity before accepting a new ChatGPT connection. */
export async function validateOpenAIIdToken(
	token: unknown,
	clientId: string,
	nonce: string,
	signal: AbortSignal,
): Promise<string> {
	if (typeof token !== "string" || token.length > 65536) throw new Error("Invalid OpenAI ID token");
	const parts = token.split(".");
	if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
		throw new Error("Invalid OpenAI ID token");
	}
	const [encodedHeader, encodedClaims, signature] = parts as [string, string, string];
	const header = jsonObject(JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")));
	if (header.alg !== "RS256" || typeof header.kid !== "string" || header.crit !== undefined) {
		throw new Error("Unsupported OpenAI ID token signing key or algorithm");
	}
	const response = await fetch(JWKS_URL, {
		headers: { accept: "application/json" },
		redirect: "error",
		signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new Error(`OpenAI signing key request failed (${response.status})`);
	}
	const jwks = jsonObject(await response.json());
	const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
	const matches = keys.filter((candidate: unknown) => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
		const key = candidate as Record<string, unknown>;
		return (
			key.kid === header.kid &&
			key.kty === "RSA" &&
			(key.use === undefined || key.use === "sig") &&
			(key.alg === undefined || key.alg === "RS256")
		);
	});
	if (matches.length !== 1) throw new Error("OpenAI ID token signing key not found or ambiguous");
	const key = createPublicKey({ key: matches[0] as JsonWebKey, format: "jwk" });
	if (
		!verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedClaims}`), key, Buffer.from(signature, "base64url"))
	) {
		throw new Error("Invalid OpenAI ID token signature");
	}
	const claims = jsonObject(JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")));
	const audience = claims.aud;
	const validAudience =
		audience === clientId ||
		(Array.isArray(audience) && audience.every((value) => typeof value === "string") && audience.includes(clientId));
	if (
		claims.iss !== ISSUER ||
		!validAudience ||
		(claims.azp !== undefined && claims.azp !== clientId) ||
		(Array.isArray(audience) && audience.length > 1 && claims.azp !== clientId)
	) {
		throw new Error("OpenAI ID token issuer or audience mismatch");
	}
	const now = Date.now() / 1000;
	if (
		typeof claims.exp !== "number" ||
		!Number.isFinite(claims.exp) ||
		claims.exp <= now ||
		(claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > now))
	) {
		throw new Error("OpenAI ID token is expired or not yet valid");
	}
	if (claims.nonce !== nonce) throw new Error("OpenAI ID token nonce mismatch");
	if (typeof claims.sub !== "string" || !claims.sub.trim()) throw new Error("OpenAI ID token has no subject");
	signal.throwIfAborted();
	return claims.sub;
}
