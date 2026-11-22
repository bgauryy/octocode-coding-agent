import { isUnreadableKeychainStub } from "../auth/endpoint.ts";
import { ModelsError, refreshStoredOAuthCredential, resolveProviderAuth } from "../auth/resolve.ts";
import type {
	AuthCheck,
	AuthContext,
	AuthInteraction,
	AuthOperationOptions,
	AuthType,
	Credential,
	CredentialStore,
	LoginOptions,
} from "../auth/types.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import type { Provider } from "./contracts.ts";

/** Resolves the credential a dynamic provider's network refresh phase uses, refreshing expired OAuth. */
export async function resolveRefreshCredential(
	credentials: CredentialStore,
	authContext: AuthContext,
	provider: Provider,
	stored: Credential | undefined,
	signal: AbortSignal,
): Promise<Credential | undefined> {
	if (stored?.type === "oauth") {
		if (stored.signedOut) return undefined;
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
		if (credential.signedOut) return undefined;
		return provider.auth.oauth ? { source: "OAuth", type: "oauth" } : undefined;
	}
	const apiKey = provider.auth.apiKey;
	if (!apiKey) return undefined;
	// A reference to a keychain record that could not be read is not a credential; requests fail with the reason.
	if (isUnreadableKeychainStub(credential)) return undefined;
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

/** Refuses a key its provider rejects; a check that could not be made saves the key and says so. */
async function verifyLoginKey(
	providerName: string,
	method: Provider["auth"]["apiKey"],
	key: string,
	interaction: AuthInteraction,
	signal: AbortSignal,
): Promise<void> {
	const verdict = (await method?.verify?.({ key, signal })) ?? "unchecked";
	if (verdict === "rejected") {
		throw new ModelsError("auth", `${providerName} rejected this key (HTTP 401). Nothing was saved.`);
	}
	if (verdict === "forbidden") {
		interaction.notify({
			type: "info",
			message: `${providerName} denied the credential check (HTTP 403). The key was saved, but model access is unverified. Check its endpoint permissions if requests fail.`,
		});
	}
	if (verdict === "unreachable") {
		const choice = await interaction.prompt({
			type: "select",
			message: `Could not check the ${providerName} key (network or service problem). Save it without checking?`,
			signal,
			options: [
				{ id: "save", label: "Save it unverified" },
				{ id: "cancel", label: "Cancel" },
			],
		});
		if (choice !== "save")
			throw new ModelsError("auth", `The ${providerName} key could not be checked. Nothing was saved.`);
		interaction.notify({
			type: "info",
			message: `Could not check the ${providerName} key (network or service problem); it was saved anyway.`,
		});
	}
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
	const previousCredential = await credentials.read(providerId, { signal });
	const loginOperation: Promise<Credential> = method.login(
		{ ...interaction, signal },
		{ ...options, previousCredential },
	);
	const credential = await raceWithAbortSignal(loginOperation, signal);
	// A key saved with a custom host is not the official host's key: that host must never receive it.
	if (type === "api_key" && credential.type === "api_key" && credential.key && !credential.endpoint) {
		await verifyLoginKey(provider.name, provider.auth.apiKey, credential.key, interaction, signal);
	}
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

/** Revoke and clear tokens under the same store lock used by refresh. */
export async function logoutProvider(
	provider: Provider | undefined,
	credentials: CredentialStore,
	providerId: string,
	options?: AuthOperationOptions,
): Promise<void> {
	const signal = operationSignal(options?.signal);
	signal.throwIfAborted();
	const logout = provider?.auth.oauth?.logout;
	const stored = await credentials.read(providerId, { signal });
	if (!logout || stored?.type !== "oauth") {
		await credentials.delete(providerId, { signal });
		return;
	}
	const lockWait = new AbortController();
	const onAbort = () => lockWait.abort(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	try {
		const result = await credentials.modify(
			providerId,
			async (current) => {
				signal.removeEventListener("abort", onAbort);
				signal.throwIfAborted();
				if (current?.type !== "oauth" || current.signedOut) return undefined;
				return logout(current, AbortSignal.timeout(15_000));
			},
			{ signal: lockWait.signal },
		);
		if (result?.type === "oauth" && result.revocationUnconfirmed === true) {
			throw new ModelsError(
				"oauth",
				"Signed out locally; remote session revocation was not confirmed. Disconnect the app in the provider's account settings.",
			);
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
