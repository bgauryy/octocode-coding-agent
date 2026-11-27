import type { ProviderEnv } from "../types.ts";
import type { ApiKeyCredential, ApiKeyEndpoint, ApiKeyHostOption, AuthInteraction, Credential } from "./types.ts";
import { ModelsError } from "../utils/models-error.ts";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A credential that is only a reference to a keychain record: the app resolves it to the record's key, host and
 * environment values when it can read the keychain, and leaves the bare reference when it cannot. Such a credential
 * carries nothing a provider could use, and must not count as stored: a provider that treats "a credential exists"
 * as ready would send the request to its default host with whatever ambient credentials it finds.
 */
export const isUnreadableKeychainStub = (credential: Credential | undefined): boolean =>
	credential?.type === "api_key" &&
	typeof credential.keychain === "string" &&
	credential.endpoint === undefined &&
	credential.key === undefined &&
	credential.env === undefined;

/** Why a request or check of a provider whose credential is an unreadable keychain stub cannot go on. */
export const KEYCHAIN_UNREADABLE_MESSAGE =
	"This credential is kept in the system keychain, which could not be read. Unlock it, or sign in again in /providers.";

/**
 * The URL a user typed as a provider host, normalized: a bare host name gets `https://`, and a trailing slash goes.
 * Only https is accepted, or http for a loopback host; credentials, a query or a fragment in the URL are refused.
 * The message never carries the URL: it may hold a secret.
 */
export function normalizeEndpointHost(raw: string): string {
	const text = raw.trim();
	if (!text) throw new ModelsError("auth", "The host is empty.");
	let url: URL;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
	} catch {
		throw new ModelsError("auth", "The host is not a valid URL. Use a host name or an https URL.");
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
		throw new ModelsError("auth", "The host must use https (http is accepted only for localhost).");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new ModelsError("auth", "The host must not contain a user, password, query or fragment.");
	}
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The endpoint a login saves, or undefined when no host was entered. `api` only when the host name does not tell. */
export function endpointFromAnswers(host: string, region: string, api?: string): ApiKeyEndpoint | undefined {
	if (!host.trim()) return undefined;
	const trimmedRegion = region.trim();
	return {
		baseUrl: normalizeEndpointHost(host),
		...(trimmedRegion ? { region: trimmedRegion } : {}),
		...(api ? { api } : {}),
	};
}

/** The host option of a provider whose API takes a base URL and nothing else: the URL is validated, no region or API. */
export const simpleHostOption = (example: string): ApiKeyHostOption => ({
	example,
	endpoint: ({ host }) => endpointFromAnswers(host, ""),
});

/** What a request of a credential with a custom host needs besides the base URL: the region and the API choice. */
export function endpointEnv(credential: ApiKeyCredential | undefined): ProviderEnv | undefined {
	const endpoint = credential?.endpoint;
	if (!endpoint) return credential?.env;
	return {
		...credential.env,
		...(endpoint.region ? { AWS_REGION: endpoint.region } : {}),
		...(endpoint.api ? { OCTOCODE_ENDPOINT_API: endpoint.api } : {}),
	};
}

/**
 * The optional host question of an official provider whose API accepts a base URL (a proxy or gateway). Enter keeps
 * the provider's own host; an answer is validated, and is saved with the key, so it is stored where the key is.
 */
export async function askCustomHost(
	interaction: Pick<AuthInteraction, "prompt"> & { signal: AbortSignal },
	providerName: string,
	option: ApiKeyHostOption,
): Promise<ApiKeyEndpoint | undefined> {
	const host = await interaction.prompt({
		type: "text",
		message: `Custom ${providerName} API host (optional, Enter keeps the official host; saved with the key)`,
		placeholder: option.example,
		storedWithKey: true,
	});
	interaction.signal.throwIfAborted();
	return option.endpoint({ host });
}
