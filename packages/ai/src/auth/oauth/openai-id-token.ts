import { createRemoteJWKSet, customFetch, decodeProtectedHeader, errors, jwtVerify } from "jose";

// OpenAI's discovery metadata publishes this issuer, JWKS URI, and RS256.
// https://auth.openai.com/.well-known/openid-configuration
const ISSUER = "https://auth.openai.com";
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

/** Verify the OIDC identity before accepting a new ChatGPT connection. */
export async function validateOpenAIIdToken(
	token: unknown,
	clientId: string,
	nonce: string,
	signal: AbortSignal,
): Promise<string> {
	signal.throwIfAborted();
	if (typeof token !== "string" || token.length > 65536) throw new Error("Invalid OpenAI ID token");
	const header = decodeProtectedHeader(token);
	if (header.alg !== "RS256" || typeof header.kid !== "string" || header.crit !== undefined) {
		throw new Error("Unsupported OpenAI ID token signing key or algorithm");
	}
	const keys = createRemoteJWKSet(new URL(JWKS_URL), {
		timeoutDuration: 30_000,
		[customFetch]: async (url, init) => {
			const response = await fetch(url, {
				...init,
				redirect: "error",
				signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
			});
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				throw new Error(`OpenAI signing key request failed (${response.status})`);
			}
			return response;
		},
	});
	try {
		const { payload } = await jwtVerify(token, keys, {
			algorithms: ["RS256"],
			issuer: ISSUER,
			audience: clientId,
			requiredClaims: ["exp"],
		});
		// OIDC's authorized-party and authorization-attempt binding are application policy.
		if (
			(payload.azp !== undefined && payload.azp !== clientId) ||
			(Array.isArray(payload.aud) &&
				(!payload.aud.every((value) => typeof value === "string") ||
					(payload.aud.length > 1 && payload.azp !== clientId)))
		)
			throw new Error("OpenAI ID token issuer or audience mismatch");
		if (payload.nonce !== nonce) throw new Error("OpenAI ID token nonce mismatch");
		if (typeof payload.sub !== "string" || !payload.sub.trim()) throw new Error("OpenAI ID token has no subject");
		signal.throwIfAborted();
		return payload.sub;
	} catch (error) {
		if (
			error instanceof errors.JWTExpired ||
			(error instanceof errors.JWTClaimValidationFailed && ["exp", "nbf"].includes(error.claim))
		) {
			throw new Error("OpenAI ID token is expired or not yet valid", { cause: error });
		}
		if (error instanceof errors.JWTClaimValidationFailed && ["iss", "aud"].includes(error.claim)) {
			throw new Error("OpenAI ID token issuer or audience mismatch", { cause: error });
		}
		if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) {
			throw new Error("OpenAI ID token signing key not found or ambiguous", { cause: error });
		}
		throw error;
	}
}
