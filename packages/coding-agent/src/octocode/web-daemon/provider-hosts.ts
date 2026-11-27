/**
 * The host a provider's requests go to, for the configuration page: the one saved with the key, else the one the
 * provider's models.json entry names, else the provider's own. A host is public; the key saved beside it never
 * leaves this module. A host kept in the keychain is read from the record `/providers` wrote (the daemon runs only
 * this platform's own keychain command for it, never a command from a file) and only its URL, region and API are kept.
 */

import type { ApiKeyHostOption, Credential, Provider } from "@octocodeai/octocode-ai";
import { builtinProviders } from "@octocodeai/octocode-ai/providers/all";
import type { ProviderAuthMethods, ProviderCredentialStatus } from "@octocodeai/octocode-contracts/config";
import type { KeychainBackend } from "../../core/auth-storage/keychain.ts";
import {
	endpointAccount,
	endpointReference,
	resolveKeychainEndpointAsync,
} from "../../core/auth-storage/keychain-endpoint.ts";
import { DEFAULT_MODEL_LIMITS } from "../../core/provider-sources/models-files.ts";
import { ConfigWriteError } from "./config-write.ts";
import type { CustomProviderInfo } from "./provider-origins.ts";

/** A host saved with a provider's key. */
export type SavedHost = NonNullable<Extract<Credential, { type: "api_key" }>["endpoint"]>;

/** Whether `credential` is a stub for an endpoint record that one of `matchers` wrote for `provider`. */
export function isOwnEndpointStub(
	provider: string,
	credential: Credential,
	matchers: readonly KeychainBackend[],
): boolean {
	const reference = endpointReference(credential);
	return !!reference && matchers.some((matcher) => matcher.isOwnReference(reference, endpointAccount(provider)));
}

/** The host `credential` carries: in the entry, or in the keychain record its stub points at. Undefined when none. */
export async function savedHost(
	provider: string,
	credential: Credential,
	matchers: readonly KeychainBackend[],
): Promise<SavedHost | undefined> {
	if (credential.type !== "api_key") return undefined;
	if (credential.endpoint) return credential.endpoint;
	if (!isOwnEndpointStub(provider, credential, matchers)) return undefined;
	const full = await resolveKeychainEndpointAsync(credential);
	return full?.type === "api_key" ? full.endpoint : undefined;
}

/**
 * The endpoint a sign-in request saves with its key, checked by the provider's own host option, as the terminal's
 * sign-in does (https or a loopback host, no embedded credentials, a Bedrock host's API). Undefined when no host was
 * entered. Refuses a region or API the provider does not ask for. Messages never carry the host.
 */
export function endpointOfRequest(
	provider: string,
	answers: { host?: string; region?: string; api?: string },
): SavedHost | undefined {
	const host = answers.host?.trim() ?? "";
	const region = answers.region?.trim() ?? "";
	const api = answers.api?.trim() ?? "";
	if (!host) {
		if (region || api) throw new ConfigWriteError(400, "Enter a host to save a region or API with it.", "invalid");
		return undefined;
	}
	const option = builtinProviders().find((each) => each.id === provider)?.auth.apiKey?.host;
	if (!option) throw new ConfigWriteError(400, "This provider does not take a custom host.", "invalid");
	if (region && !option.region) throw new ConfigWriteError(400, "This provider's host takes no region.", "invalid");
	if (api && !option.apis) throw new ConfigWriteError(400, "This provider's host takes no API choice.", "invalid");
	try {
		return option.endpoint({ host, ...(region ? { region } : {}), ...(api ? { api } : {}) });
	} catch (error) {
		// The ai package's host errors are fixed texts that never quote the URL.
		throw new ConfigWriteError(400, error instanceof Error ? error.message : "The host is not valid.", "invalid");
	}
}

/** The host question a provider's key sign-in asks, as names only. */
export function hostQuestion(host: ApiKeyHostOption | undefined): NonNullable<ProviderAuthMethods["keyAuth"]>["host"] {
	if (!host) return undefined;
	return {
		example: host.example,
		...(host.region ? { region: true } : {}),
		...(host.apis ? { apis: host.apis.map(({ id, label }) => ({ id, label })).slice(0, 8) } : {}),
	};
}

/** The base URL a provider's requests go to and where that comes from; undefined when no host is known. */
export function effectiveBaseUrl(
	definition: Provider | undefined,
	saved: SavedHost | undefined,
	custom: CustomProviderInfo | undefined,
): ProviderCredentialStatus["baseUrl"] {
	if (saved)
		return {
			url: saved.baseUrl,
			source: "saved",
			...(saved.region ? { region: saved.region } : {}),
			...(saved.api ? { api: saved.api } : {}),
		};
	if (custom?.baseUrl && !definition) return { url: custom.baseUrl, source: "models-json" };
	if (definition?.baseUrl) return { url: definition.baseUrl, source: "default" };
	return undefined;
}

/** What the page can edit on a custom provider of Octocode's models.json; undefined for any other provider. */
export function customEdit(
	definition: Provider | undefined,
	custom: CustomProviderInfo | undefined,
): ProviderCredentialStatus["customEdit"] {
	if (definition || !custom?.own) return undefined;
	return {
		models: custom.models.slice(0, 64).map((id) => ({
			id,
			contextWindow: (custom.limits[id] ?? DEFAULT_MODEL_LIMITS).contextWindow,
			maxOutput: (custom.limits[id] ?? DEFAULT_MODEL_LIMITS).maxTokens,
		})),
	};
}
