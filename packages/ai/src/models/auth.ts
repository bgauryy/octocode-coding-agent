import { ModelsError, refreshStoredOAuthCredential, resolveProviderAuth } from "../auth/resolve.ts";
import type {
	AuthCheck,
	AuthContext,
	AuthInteraction,
	AuthType,
	Credential,
	CredentialStore,
	LoginOptions,
} from "../auth/types.ts";
import type { ProviderHeaders } from "../types.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import type { Provider } from "./contracts.ts";

export function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

export async function readCredential(
	credentials: CredentialStore,
	providerId: string,
	signal: AbortSignal,
): Promise<Credential | undefined> {
	try {
		return await credentials.read(providerId, { signal });
	} catch (error) {
		throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
	}
}

/** Resolves the credential a dynamic provider's network refresh phase uses, refreshing expired OAuth. */
export async function resolveRefreshCredential(
	credentials: CredentialStore,
	authContext: AuthContext,
	provider: Provider,
	stored: Credential | undefined,
	signal: AbortSignal,
): Promise<Credential | undefined> {
	if (stored?.type === "oauth") {
		const oauth = provider.auth.oauth;
		if (!oauth) return undefined;
		if (Date.now() < stored.expires) return stored;
		if (signal.aborted) return undefined;
		// A refresh that has started survives cancellation or a superseding model refresh, so a
		// rotated refresh token is always persisted. A newer refresh then sees the fresh credential.
		return refreshStoredOAuthCredential(
			credentials,
			provider.id,
			oauth,
			(current) => Date.now() >= current.expires,
			signal,
		);
	}

	const apiKey = provider.auth.apiKey;
	if (!apiKey) return undefined;
	const credential = stored?.type === "api_key" ? stored : undefined;
	const result = await apiKey.resolve({ ctx: authContext, credential, signal });
	if (!result) return undefined;
	return { type: "api_key", key: result.auth.apiKey, env: result.env };
}

export async function checkProviderAuth(
	credentials: CredentialStore,
	authContext: AuthContext,
	provider: Provider,
	credential: Credential | undefined,
	signal: AbortSignal,
): Promise<AuthCheck | undefined> {
	if (credential?.type === "oauth") {
		return provider.auth.oauth ? { source: "OAuth", type: "oauth" } : undefined;
	}
	const apiKey = provider.auth.apiKey;
	if (!apiKey) return undefined;
	if (apiKey.check) {
		try {
			return await apiKey.check({
				ctx: authContext,
				credential: credential?.type === "api_key" ? credential : undefined,
				signal,
			});
		} catch (error) {
			throw new ModelsError("auth", `API key auth check failed for provider ${provider.id}`, { cause: error });
		}
	}

	const resolution = await resolveProviderAuth(provider, credentials, authContext, { signal });
	return resolution ? { source: resolution.source, type: "api_key" } : undefined;
}

/** Runs a provider-owned login flow and persists its returned credential. */
export async function loginProvider(
	providers: ReadonlyMap<string, Provider>,
	credentials: CredentialStore,
	providerId: string,
	type: AuthType,
	interaction: AuthInteraction,
	options?: LoginOptions,
): Promise<Credential> {
	const signal = operationSignal(interaction.signal);
	signal.throwIfAborted();
	const provider = providers.get(providerId);
	if (!provider) throw new ModelsError("provider", `Unknown provider: ${providerId}`);
	const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
	if (!method?.login) {
		throw new ModelsError("auth", `${provider.name} does not support ${type} login`);
	}
	const loginOperation: Promise<Credential> = method.login({ ...interaction, signal }, options);
	const credential = await raceWithAbortSignal(loginOperation, signal);
	let mutationStarted = false;
	let markMutationStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		markMutationStarted = resolve;
	});
	const mutation = credentials.modify(
		providerId,
		async () => {
			mutationStarted = true;
			markMutationStarted?.();
			return credential;
		},
		{ signal },
	);
	void mutation.catch(() => {});
	try {
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				if (!mutationStarted) reject(signal.reason);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			void Promise.race([started, mutation]).then(
				() => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				},
				(error: unknown) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			);
			if (signal.aborted) onAbort();
		});
		await mutation;
	} catch (error) {
		signal.throwIfAborted();
		throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
	}
	return credential;
}
