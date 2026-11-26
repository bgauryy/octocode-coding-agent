import type { ProviderEnv } from "../types.ts";
import { isUnreadableKeychainStub, KEYCHAIN_UNREADABLE_MESSAGE, normalizeEndpointHost } from "./endpoint.ts";
import { isActiveCredential } from "./helpers.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { ModelsError } from "../utils/models-error.ts";

export { ModelsError, type ModelsErrorCode } from "../utils/models-error.ts";

import type {
	ApiKeyAuth,
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Credential,
	CredentialStore,
	OAuthAuth,
	OAuthCredential,
	ProviderAuth,
} from "./types.ts";

export interface AuthResolutionOverrides {
	apiKey?: string;
	env?: ProviderEnv;
	/** Require this much remaining OAuth-token validity; defaults to five minutes. */
	minOAuthValidityMs?: number;
	signal?: AbortSignal;
}

/**
 * Auth resolution shared by all operations in a `Models` collection.
 * A stored credential owns the provider: ambient/env is consulted only when
 * nothing is stored. No silent env fallback after a failed refresh or for a
 * credential type without a matching handler.
 */
export function resolveProviderAuth(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides?: AuthResolutionOverrides,
): Promise<AuthResult | undefined> {
	const signal = operationSignal(overrides?.signal);
	return raceWithAbortSignal(
		resolveProviderAuthWithSignal(provider, credentials, authContext, overrides, signal),
		signal,
	);
}

async function resolveProviderAuthWithSignal(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides: AuthResolutionOverrides | undefined,
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	signal.throwIfAborted();
	const requestAuthContext = overrides?.env ? overlayEnvAuthContext(authContext, overrides.env) : authContext;

	if (overrides?.apiKey !== undefined && provider.auth.apiKey) {
		return resolveApiKey(
			requestAuthContext,
			provider.auth.apiKey,
			provider.id,
			{
				type: "api_key",
				key: overrides.apiKey,
				env: overrides.env,
			},
			signal,
		);
	}

	const stored = await readCredential(credentials, provider.id, signal);
	if (stored) {
		if (stored.type === "oauth" && provider.auth.oauth) {
			return resolveStoredOAuth(
				credentials,
				provider.id,
				provider.auth.oauth,
				stored,
				signal,
				overrides?.minOAuthValidityMs,
			);
		}
		if (stored.type === "api_key" && provider.auth.apiKey) {
			const credential = overrides?.env ? { ...stored, env: { ...stored.env, ...overrides.env } } : stored;
			return resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, credential, signal);
		}
		return undefined;
	}

	// Ambient (env vars, AWS profiles, ADC files).
	return provider.auth.apiKey
		? resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, undefined, signal)
		: undefined;
}

function overlayEnvAuthContext(base: AuthContext, env: ProviderEnv): AuthContext {
	return {
		env: async (name) => env[name] || (await base.env(name)),
		fileExists: (path) => base.fileExists(path),
	};
}

const DEFAULT_OAUTH_MINIMUM_VALIDITY_MS = 5 * 60 * 1000;
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Refresh a stored OAuth credential under the credential-store lock and persist
 * the result before the lock is released. `needsRefresh` is re-checked under
 * the lock, so concurrent callers and processes refresh only once.
 *
 * `signal` cancels only the wait for the lock. Once a refresh starts, the
 * provider may already have rotated the refresh token, so the refresh and its
 * persistence ignore `signal` and are bounded only by a timeout. Otherwise a
 * cancelled caller could discard the only valid refresh token. Callers that
 * must return promptly on cancellation race this promise with their signal.
 *
 * Resolves with the stored OAuth credential after the operation, or undefined
 * when the provider no longer has an OAuth credential.
 */
export async function refreshStoredOAuthCredential(
	credentials: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	needsRefresh: (credential: OAuthCredential) => boolean,
	signal: AbortSignal,
): Promise<OAuthCredential | undefined> {
	let post: Credential | undefined;
	let rejection: ModelsError | undefined;
	const lockWait = new AbortController();
	const cancelLockWait = () => lockWait.abort(signal.reason);
	signal.addEventListener("abort", cancelLockWait, { once: true });
	if (signal.aborted) cancelLockWait();
	try {
		post = await credentials.modify(
			providerId,
			async (current) => {
				signal.removeEventListener("abort", cancelLockWait);
				signal.throwIfAborted();
				if (current?.type !== "oauth" || current.signedOut) return undefined; // logged out meanwhile
				if (!needsRefresh(current)) return undefined; // another process/request refreshed
				const fingerprint = await refreshTokenFingerprint(current.refresh);
				if (current.refreshRejected?.refreshSha256 === fingerprint) {
					throw rejectedRefreshError(providerId, current.refreshRejected.at);
				}
				try {
					const refreshed = await oauth.refresh(current, AbortSignal.timeout(DEFAULT_OAUTH_REFRESH_TIMEOUT_MS));
					if (!refreshed.refreshRejected) return refreshed;
					const { refreshRejected: _stale, ...clean } = refreshed;
					return clean;
				} catch (error) {
					const failure = new ModelsError("oauth", `OAuth refresh failed for ${providerId}`, { cause: error });
					if (!isTerminalGrantError(error)) throw failure;
					// Persist the refusal in the same locked write so later requests skip the doomed request.
					rejection = failure;
					return { ...current, refreshRejected: { at: Date.now(), refreshSha256: fingerprint } };
				}
			},
			{ signal: lockWait.signal },
		);
	} catch (error) {
		if (error instanceof ModelsError) throw error;
		signal.throwIfAborted();
		throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
	} finally {
		signal.removeEventListener("abort", cancelLockWait);
	}
	if (rejection) throw rejection;
	return post?.type === "oauth" && !post.signedOut ? post : undefined;
}

/**
 * Whether a refresh error says the provider refused the refresh token for good, so retrying it cannot succeed:
 * the OAuth `invalid_grant` code, or Kimi's unauthorized refresh.
 * Providers throw plain errors, so this reads the message and its causes. Network, timeout, abort, 429 and 5xx
 * failures match nothing and stay retryable.
 */
const TERMINAL_GRANT_ERROR = /\binvalid_grant\b|Kimi Code token refresh unauthorized \(status (?:401|403)\)/;

function isTerminalGrantError(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
		if (!(current instanceof Error)) return typeof current === "string" && TERMINAL_GRANT_ERROR.test(current);
		if (TERMINAL_GRANT_ERROR.test(current.message)) return true;
		current = current.cause;
	}
	return false;
}

function rejectedRefreshError(providerId: string, at: number): ModelsError {
	return new ModelsError(
		"oauth",
		`OAuth refresh failed for ${providerId}: the provider rejected this sign-in (invalid_grant) at ${new Date(at).toISOString()}; sign in again, it is not retried until then`,
	);
}

/** Hex SHA-256 of a refresh token, so the rejected token is recognised without storing a second copy of it. */
async function refreshTokenFingerprint(refresh: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(refresh));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * OAuth resolution with double-checked locking: tokens with less than five
 * minutes remaining are refreshed through `refreshStoredOAuthCredential`.
 */
async function resolveStoredOAuth(
	credentials: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	stored: OAuthCredential,
	signal: AbortSignal,
	minOAuthValidityMs?: number,
): Promise<AuthResult | undefined> {
	const minimumValidityMs = Math.max(DEFAULT_OAUTH_MINIMUM_VALIDITY_MS, minOAuthValidityMs ?? 0);
	const expiresSoon = (credential: OAuthCredential) => Date.now() + minimumValidityMs >= credential.expires;
	let credential = stored;

	if (expiresSoon(credential)) {
		// Optimistic check said expired; the authoritative check runs under the lock.
		const post = await refreshStoredOAuthCredential(credentials, providerId, oauth, expiresSoon, signal);
		if (!post) return undefined; // logged out meanwhile
		credential = post;
		// The normal five-minute window triggers a refresh but does not impose a
		// provider contract. Explicit callers (such as bearer-token export) do
		// require the requested minimum after the refresh.
		if (minOAuthValidityMs !== undefined && Date.now() + minOAuthValidityMs >= credential.expires) {
			throw new ModelsError("oauth", `OAuth refresh returned a token that expires too soon for ${providerId}`);
		}
	}

	try {
		return { auth: await oauth.toAuth(credential), source: "OAuth" };
	} catch (error) {
		throw new ModelsError("oauth", `OAuth auth derivation failed for ${providerId}`, { cause: error });
	}
}

async function resolveApiKey(
	authContext: AuthContext,
	apiKey: ApiKeyAuth,
	providerId: string,
	credential: ApiKeyCredential | undefined,
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	try {
		if (isUnreadableKeychainStub(credential)) throw new ModelsError("auth", KEYCHAIN_UNREADABLE_MESSAGE);
		const resolved = await apiKey.resolve({ ctx: authContext, credential, signal });
		// A custom host saved with the credential redirects every request of this provider to it.
		const saved = credential?.endpoint?.baseUrl;
		return resolved && saved
			? { ...resolved, auth: { ...resolved.auth, baseUrl: normalizeEndpointHost(saved) } }
			: resolved;
	} catch (error) {
		// The cause's first line says why (a command's exit status, the variable that is not set): the wrapper keeps it.
		const why = error instanceof Error ? error.message.split("\n")[0] : "";
		throw new ModelsError("auth", `API key auth failed for provider ${providerId}${why ? `: ${why}` : ""}`, {
			cause: error,
		});
	}
}

export async function readCredential(
	credentials: CredentialStore,
	providerId: string,
	signal: AbortSignal,
): Promise<Credential | undefined> {
	try {
		const credential = await credentials.read(providerId, { signal });
		return isActiveCredential(credential) ? credential : undefined;
	} catch (error) {
		throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
	}
}
