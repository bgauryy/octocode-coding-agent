/**
 * Provider management and credential removal, including the /login compatibility alias.
 */

import { showProviderManager, removeProviderCredential, type ProviderManagerHost } from "./provider-manager.ts";
import { type AuthSelectorProvider, OAuthSelectorComponent } from "../components/oauth-selector.ts";

export function getLoginProviderOptions(
	host: ProviderManagerHost,
	authType?: "oauth" | "api_key",
): AuthSelectorProvider[] {
	const options: AuthSelectorProvider[] = [];
	for (const provider of host.session.modelRuntime.getProviders()) {
		const authStatus = host.session.modelRuntime.getProviderAuthStatus(provider.id);
		const status = authStatus.configured
			? {
					type: host.session.modelRuntime.isUsingOAuth(provider.id) ? ("oauth" as const) : ("api_key" as const),
					source: authStatus.label ?? authStatus.source,
				}
			: undefined;
		const subscription = provider.auth.oauth?.isSubscription === true;
		if ((!authType || authType === "oauth") && provider.auth.oauth) {
			options.push({
				id: provider.id,
				name: provider.name,
				authType: "oauth",
				method: provider.auth.oauth,
				status,
				subscription,
			});
		}
		if ((!authType || authType === "api_key") && provider.auth.apiKey) {
			options.push({
				id: provider.id,
				name: provider.name,
				authType: "api_key",
				method: provider.auth.apiKey,
				status,
				subscription,
			});
		}
	}
	return options.sort((a, b) => a.name.localeCompare(b.name));
}

async function getLogoutProviderOptions(host: ProviderManagerHost): Promise<AuthSelectorProvider[]> {
	return (await host.session.modelRuntime.listCredentials({ signal: AbortSignal.timeout(15_000) }))
		.map(({ providerId, type }) => {
			const provider = host.session.modelRuntime.getProvider(providerId);
			return {
				id: providerId,
				name: provider?.name ?? providerId,
				authType: type,
				status: { type, source: "stored credential" },
				subscription: provider?.auth.oauth?.isSubscription === true,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

export async function handleLoginCommand(host: ProviderManagerHost, providerRef?: string): Promise<void> {
	await showProviderManager(host, providerRef);
}

export async function showOAuthSelector(host: ProviderManagerHost, mode: "login" | "logout"): Promise<void> {
	if (mode === "login") {
		await showProviderManager(host);
		return;
	}

	let providerOptions: AuthSelectorProvider[];
	try {
		providerOptions = await getLogoutProviderOptions(host);
	} catch {
		host.showError("Could not read stored credentials. Check the auth.json format. No credentials were changed.");
		return;
	}
	if (providerOptions.length === 0) {
		host.showStatus(
			"No stored credentials to remove. /logout only removes saved or session credentials; environment variables and models.json config are unchanged.",
		);
		return;
	}

	host.showSelector((done) => {
		const selector = new OAuthSelectorComponent(
			mode,
			providerOptions,
			async (providerId: string) => {
				done();

				const providerOption = providerOptions.find((provider) => provider.id === providerId);
				if (!providerOption) {
					return;
				}

				await removeProviderCredential(host, providerOption.id, providerOption.name);
			},
			() => {
				done();
				host.ui.requestRender();
			},
		);
		return { component: selector, focus: selector };
	});
}
