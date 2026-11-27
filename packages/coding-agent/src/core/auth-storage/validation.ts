import type { AuthStorageData } from "./backends.ts";
import { isActiveCredential, type Credential, type CredentialInfo } from "@octocodeai/octocode-ai";
import { isCommandConfigValue, isConfigValueConfigured } from "@octocodeai/octocode-ai/utils/resolve-config-value";
import { jsonErrorLocation } from "@octocodeai/octocode-common/json";
import { stripBom } from "@octocodeai/octocode-common/text";

/** Parser diagnostics for a credential file must never quote its contents, including in the error cause. */
export function parseAuthJson(content: string): unknown {
	try {
		return JSON.parse(stripBom(content));
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		throw new SyntaxError(`Invalid auth.json: ${jsonErrorLocation(error)}`);
	}
}

/** Why a credential entry is not one Octocode reads, or undefined when it is. */
export function invalidEntryReason(credential: unknown): string | undefined {
	if (typeof credential !== "object" || credential === null || Array.isArray(credential)) return "not an object";
	const value = credential as Record<string, unknown>;
	if (value.type === "api_key") {
		const validKey = value.key === undefined || typeof value.key === "string";
		const validEnv =
			value.env === undefined ||
			(typeof value.env === "object" &&
				value.env !== null &&
				!Array.isArray(value.env) &&
				Object.values(value.env).every((entry) => typeof entry === "string"));
		const endpoint = value.endpoint as Record<string, unknown> | undefined;
		const validEndpoint =
			endpoint === undefined ||
			(typeof endpoint === "object" &&
				endpoint !== null &&
				typeof endpoint.baseUrl === "string" &&
				(endpoint.region === undefined || typeof endpoint.region === "string") &&
				(endpoint.api === undefined || typeof endpoint.api === "string"));
		const validReference = value.keychain === undefined || typeof value.keychain === "string";
		if (!validKey || !validEnv) return "an api_key entry needs a string key and string env values";
		return validEndpoint && validReference
			? undefined
			: "an api_key entry has an invalid endpoint or keychain reference";
	}
	if (value.type === "oauth") {
		const valid =
			typeof value.access === "string" &&
			typeof value.refresh === "string" &&
			typeof value.expires === "number" &&
			Number.isFinite(value.expires);
		return valid ? undefined : "an oauth entry needs string access and refresh tokens and a numeric expires";
	}
	return typeof value.type === "string" ? "the credential type must be api_key or oauth" : "it has no type";
}

/** Only Octocode's own configuration may supply a command for a credential. */
export function usesCredentialCommand(credential: Credential): boolean {
	return (
		(credential.type === "api_key" && !!credential.key && isCommandConfigValue(credential.key)) ||
		(typeof credential.keychain === "string" && isCommandConfigValue(credential.keychain))
	);
}

export function parseStorageData(content: string | undefined): AuthStorageData {
	if (!content) {
		return {};
	}
	const parsed: unknown = parseAuthJson(content);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Invalid auth.json: expected an object");
	}
	for (const [provider, credential] of Object.entries(parsed)) {
		const reason = invalidEntryReason(credential);
		if (reason) throw new Error(`Invalid auth.json credential for provider "${provider}": ${reason}`);
	}
	return parsed as AuthStorageData;
}

export type StoredCredentialInfo = CredentialInfo & { signedOut?: true };

/** Metadata for merging credential sources, including the local markers that suppress an inherited sign-in. */
export function storedCredentials(data: AuthStorageData): StoredCredentialInfo[] {
	return Object.entries(data).map(([providerId, credential]) => ({
		providerId,
		type: credential.type,
		...(isActiveCredential(credential) ? {} : { signedOut: true as const }),
	}));
}

/** Metadata-only gate shared by runtime discovery and the web provider list. */
export function usablePiCredential(
	credential: Credential | undefined,
	supportsOAuth = true,
	env?: NodeJS.ProcessEnv,
): credential is Credential {
	if (!isActiveCredential(credential) || usesCredentialCommand(credential)) return false;
	if (credential.type === "oauth") return supportsOAuth;
	return (
		!credential.key || isConfigValueConfigured(credential.key, { ...env, ...credential.env } as Record<string, string>)
	);
}
