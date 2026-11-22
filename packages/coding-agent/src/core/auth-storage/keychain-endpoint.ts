/**
 * An API key saved with a custom host, or a credential whose secret is an environment value (the Azure Entra token):
 * the key, the host, the region and the environment values are one JSON record in the system keychain, and auth.json
 * keeps only a stub with a `keychain` `!command` reference. Reading the stub returns the full credential, and removing
 * the credential removes the whole record, so key and host never drift apart. The record has its own keychain account
 * beside the one a plain API key of the same provider uses.
 */

import type { ApiKeyCredential, Credential } from "@octocodeai/octocode-ai";
import { resolveConfigValue, resolveConfigValueAsync, resolveConfigValueUncached } from "../config-value.ts";
import { isSecretName, registerNamedSecrets, registerResolvedSecret } from "../secret-redaction.ts";

/** The keychain account an endpoint record is kept under. */
export const endpointAccount = (provider: string): string => `${provider}.endpoint`;

/** The `!command` reference of an endpoint stub; undefined for any other credential. */
export function endpointReference(credential: Credential | undefined): string | undefined {
	const reference = credential?.type === "api_key" ? credential.keychain : undefined;
	return typeof reference === "string" && reference.startsWith("!") ? reference : undefined;
}

/** The names of the environment values of `credential` that hold a secret (a token, a key). */
const secretEnvNames = (credential: ApiKeyCredential): string[] =>
	Object.entries(credential.env ?? {})
		.filter(([name, value]) => typeof value === "string" && value.trim() !== "" && isSecretName(name))
		.map(([name]) => name);

/** Whether the environment value of `credential` named `name` is `secret`, as typed or trimmed. */
export const envHoldsSecret = (credential: ApiKeyCredential, secret: string): boolean =>
	secretEnvNames(credential).some((name) => {
		const value = credential.env?.[name];
		return value === secret || value === secret.trim();
	});

/** Whether `credential` carries a custom host or a secret environment value that belongs in the keychain record. */
export const hasKeychainRecord = (credential: ApiKeyCredential): boolean =>
	!endpointReference(credential) && (credential.endpoint !== undefined || secretEnvNames(credential).length > 0);

/** The secret part of `credential`: everything but its type and reference. */
export function endpointBlob(credential: ApiKeyCredential): string {
	const { type: _type, keychain: _keychain, ...fields } = credential;
	return JSON.stringify(fields);
}

/** What auth.json keeps for an endpoint credential once its record is in the keychain under `reference`. */
export const endpointStub = (reference: string): ApiKeyCredential => ({ type: "api_key", keychain: reference });

/** The credential a record holds; undefined when it is missing or is not one. */
function parseBlob(blob: string | undefined): ApiKeyCredential | undefined {
	if (!blob) return undefined;
	try {
		const fields = JSON.parse(blob) as Record<string, unknown>;
		const endpoint = fields.endpoint as Record<string, unknown> | undefined;
		const env = fields.env as Record<string, unknown> | undefined;
		const hasEnv = typeof env === "object" && env !== null && Object.values(env).every((v) => typeof v === "string");
		if (typeof endpoint?.baseUrl !== "string" && !hasEnv) return undefined;
		if (fields.key !== undefined && typeof fields.key !== "string") return undefined;
		if (typeof fields.key === "string") registerResolvedSecret(fields.key);
		registerNamedSecrets(env);
		return { ...fields, type: "api_key" };
	} catch {
		return undefined;
	}
}

/**
 * The full credential an endpoint stub stands for; any other credential as it is. `fresh` skips the brief command
 * cache. When the keychain cannot be read the stub is returned: it holds no key and no host, so requests fail with
 * "no credential" instead of going to the default host with a missing key.
 */
export function resolveKeychainEndpoint(credential: Credential | undefined, fresh = false): Credential | undefined {
	const reference = endpointReference(credential);
	if (!reference) return credential;
	const blob = fresh ? resolveConfigValueUncached(reference) : resolveConfigValue(reference);
	return parseBlob(blob) ?? credential;
}

/** `resolveKeychainEndpoint` (cached read) that does not block the thread while the keychain command runs. */
export async function resolveKeychainEndpointAsync(
	credential: Credential | undefined,
): Promise<Credential | undefined> {
	const reference = endpointReference(credential);
	if (!reference) return credential;
	return parseBlob(await resolveConfigValueAsync(reference)) ?? credential;
}
