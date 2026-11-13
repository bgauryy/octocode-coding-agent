/**
 * OAuth credentials in the OS keychain. The access token, refresh token, expiry and any other provider fields are one
 * JSON blob in the keychain; auth.json keeps a stub with empty tokens, the expiry, and a `keychain` `!command`
 * reference that reads the blob back. `AuthStorage` resolves the stub on every read and, while the stub is its own
 * reference, writes each refreshed credential back to the keychain. Where no keychain exists the credential stays in
 * auth.json as before.
 */

import type { Credential, OAuthCredential } from "@octocodeai/octocode-ai";
import {
	clearConfigValueCache,
	resolveConfigValue,
	resolveConfigValueAsync,
	resolveConfigValueUncached,
} from "../config-value.ts";
import { registerResolvedSecret } from "../secret-redaction.ts";
import type { KeychainBackend } from "./keychain.ts";

/** The keychain account an OAuth blob is kept under, beside the account an API key of the same provider would use. */
export const oauthAccount = (provider: string): string => `${provider}.oauth`;

/** The `!command` reference of an OAuth stub; undefined for any other credential. */
export function oauthReference(credential: Credential | undefined): string | undefined {
	const reference = credential?.type === "oauth" ? credential.keychain : undefined;
	return typeof reference === "string" && reference.startsWith("!") ? reference : undefined;
}

/** The keychain entry behind `credential` (an API key's `!` reference, or an OAuth stub's), as account and reference. */
export function keychainEntry(
	provider: string,
	credential: Credential | undefined,
): { account: string; reference: string } | undefined {
	if (credential?.type === "api_key" && credential.key?.startsWith("!"))
		return { account: provider, reference: credential.key };
	const reference = oauthReference(credential);
	return reference ? { account: oauthAccount(provider), reference } : undefined;
}

/** The secret part of `credential`: everything but its type and reference. */
export function oauthBlob(credential: OAuthCredential): string {
	const { type: _type, keychain: _keychain, ...fields } = credential;
	return JSON.stringify(fields);
}

/** What auth.json keeps for `credential` once its blob is in the keychain under `reference`. */
export const oauthStub = (credential: OAuthCredential, reference: string): OAuthCredential => ({
	type: "oauth",
	access: "",
	refresh: "",
	expires: credential.expires,
	keychain: reference,
});

/** The credential a blob holds; undefined when it is missing or is not one. */
function parseBlob(blob: string | undefined): OAuthCredential | undefined {
	if (!blob) return undefined;
	try {
		const fields = JSON.parse(blob) as Record<string, unknown>;
		const { access, refresh, expires } = fields;
		if (typeof access !== "string" || typeof refresh !== "string" || typeof expires !== "number") return undefined;
		return { ...fields, type: "oauth", access, refresh, expires };
	} catch {
		return undefined;
	}
}

/**
 * The full credential an OAuth stub stands for; any other credential as it is. `fresh` skips the brief command cache,
 * for a read under the storage lock that may refresh: another process may have rotated the tokens meanwhile. When the
 * keychain cannot be read the stub is returned: its empty tokens fail the request, and signing in again replaces it.
 */
export function resolveKeychainOAuth(credential: Credential | undefined, fresh = false): Credential | undefined {
	const reference = oauthReference(credential);
	if (!reference) return credential;
	const blob = fresh ? resolveConfigValueUncached(reference) : resolveConfigValue(reference);
	if (fresh) registerResolvedSecret(blob);
	return parseBlob(blob) ?? credential;
}

/** `resolveKeychainOAuth` (cached read) that does not block the thread while the keychain command runs. */
export async function resolveKeychainOAuthAsync(credential: Credential | undefined): Promise<Credential | undefined> {
	const reference = oauthReference(credential);
	if (!reference) return credential;
	return parseBlob(await resolveConfigValueAsync(reference)) ?? credential;
}

/**
 * What auth.json gets for `next` when `previous` (as stored) kept its tokens in this keychain: the new tokens go to the
 * keychain and auth.json keeps the stub, so a refresh writes the blob. Any other credential is returned as it is. When
 * the keychain refuses, the tokens are written to auth.json instead: a refresh may have rotated the refresh token, and
 * losing it would sign the user out.
 */
export async function keepInKeychain(
	keychain: KeychainBackend | undefined,
	provider: string,
	previous: Credential | undefined,
	next: Credential,
): Promise<Credential> {
	if (next.type !== "oauth" || next.signedOut || oauthReference(next)) return next;
	const account = oauthAccount(provider);
	const reference = oauthReference(previous);
	if (!keychain || !reference || !keychain.isOwnReference(reference, account)) return next;
	try {
		await keychain.store(account, oauthBlob(next));
	} catch {
		return next;
	} finally {
		clearConfigValueCache();
	}
	return oauthStub(next, reference);
}
