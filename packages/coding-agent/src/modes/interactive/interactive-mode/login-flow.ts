/**
 * The /login and /logout flows: provider options, the auth-type and provider selectors, and the logout selector.
 */

import { CredentialSynchronizationError } from "../../../core/model-runtime.ts";
import { ExtensionSelectorComponent } from "../components/extension-selector.ts";
import { type AuthSelectorProvider, OAuthSelectorComponent } from "../components/oauth-selector.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by the login and logout flows. */
export type LoginFlowHost = Pick<
	InteractiveModeHost,
	| "getLoginProviderOptions"
	| "session"
	| "showAmbientAuthDialog"
	| "showApiKeyLoginDialog"
	| "showError"
	| "showLoginDialog"
	| "showSelector"
	| "showStatus"
	| "ui"
	| "updateAvailableProviderCount"
>;

export function getLoginProviderOptions(host: LoginFlowHost, authType?: "oauth" | "api_key"): AuthSelectorProvider[] {
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

export async function getLogoutProviderOptions(host: LoginFlowHost): Promise<AuthSelectorProvider[]> {
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

export function findLoginProviderOptions(host: LoginFlowHost, providerRef: string): AuthSelectorProvider[] {
	const normalizedProviderRef = providerRef.trim().toLowerCase();
	if (!normalizedProviderRef) {
		return [];
	}

	return host
		.getLoginProviderOptions()
		.filter(
			(provider) =>
				provider.id.toLowerCase() === normalizedProviderRef || provider.name.toLowerCase() === normalizedProviderRef,
		);
}

export async function handleLoginCommand(host: LoginFlowHost, providerRef?: string): Promise<void> {
	if (!providerRef) {
		showLoginAuthTypeSelector(host);
		return;
	}

	const providerOptions = findLoginProviderOptions(host, providerRef);
	if (providerOptions.length === 1) {
		await startProviderLogin(host, providerOptions[0]);
		return;
	}

	if (providerOptions.length > 1) {
		const providerIds = new Set(providerOptions.map((provider) => provider.id));
		if (providerIds.size === 1) {
			showLoginAuthTypeSelector(host, providerOptions);
			return;
		}
	}

	showLoginProviderSelector(host, undefined, providerRef);
}

/** `onBack` reopens the selector the login was started from when the user cancels it. */
export async function startProviderLogin(
	host: LoginFlowHost,
	providerOption: AuthSelectorProvider,
	onBack?: () => void,
): Promise<void> {
	if (providerOption.authType === "oauth") {
		await host.showLoginDialog(providerOption.id, providerOption.name, onBack);
	} else if (providerOption.method?.login) {
		await host.showApiKeyLoginDialog(providerOption.id, providerOption.name, onBack);
	} else {
		host.showAmbientAuthDialog(providerOption, onBack);
	}
}

export function showLoginAuthTypeSelector(host: LoginFlowHost, providerOptions?: AuthSelectorProvider[]): void {
	const oauthProvider = providerOptions?.find((provider) => provider.authType === "oauth");
	const oauthLoginLabel =
		oauthProvider?.method && "loginLabel" in oauthProvider.method ? oauthProvider.method.loginLabel : undefined;
	const subscriptionLabel = oauthLoginLabel ?? "Sign in with an account";
	const apiKeyLabel = "Sign in with an API key";
	const availableAuthTypes = providerOptions
		? new Set(providerOptions.map((provider) => provider.authType))
		: new Set<AuthSelectorProvider["authType"]>(["oauth", "api_key"]);
	const options: string[] = [];
	if (availableAuthTypes.has("oauth")) {
		options.push(subscriptionLabel);
	}
	if (availableAuthTypes.has("api_key")) {
		options.push(apiKeyLabel);
	}

	if (options.length === 0) {
		host.showStatus("No login methods available.");
		return;
	}

	if (providerOptions && options.length === 1) {
		const providerOption = providerOptions[0];
		if (providerOption) {
			void startProviderLogin(host, providerOption);
		}
		return;
	}

	const title = providerOptions?.[0]
		? `Select authentication method for ${providerOptions[0].name}:`
		: "Select authentication method:";
	host.showSelector((done) => {
		const onSelect = (option: string) => {
			done();
			const authType = option === subscriptionLabel ? "oauth" : "api_key";
			if (providerOptions) {
				const providerOption = providerOptions.find((provider) => provider.authType === authType);
				if (providerOption) {
					void startProviderLogin(host, providerOption, () => showLoginAuthTypeSelector(host, providerOptions));
				}
				return;
			}
			showLoginProviderSelector(host, authType);
		};
		const onCancel = () => {
			done();
			host.ui.requestRender();
		};
		const selector = new ExtensionSelectorComponent(title, options, onSelect, onCancel);
		return { component: selector, focus: selector, dispose: () => selector.dispose() };
	});
}

export function showLoginProviderSelector(
	host: LoginFlowHost,
	authType?: AuthSelectorProvider["authType"],
	initialSearchInput?: string,
): void {
	const providerOptions = host.getLoginProviderOptions(authType);
	if (providerOptions.length === 0) {
		const message =
			authType === "oauth"
				? "No account providers available."
				: authType === "api_key"
					? "No API key providers available."
					: "No login providers available.";
		host.showStatus(message);
		return;
	}

	host.showSelector((done) => {
		const selector = new OAuthSelectorComponent(
			"login",
			providerOptions,
			async (providerId, selectedAuthType) => {
				done();

				const providerOption = providerOptions.find(
					(provider) => provider.id === providerId && provider.authType === selectedAuthType,
				);
				if (!providerOption) {
					return;
				}

				await startProviderLogin(host, providerOption, () =>
					showLoginProviderSelector(host, authType, initialSearchInput),
				);
			},
			() => {
				done();
				if (authType) {
					showLoginAuthTypeSelector(host);
				} else {
					host.ui.requestRender();
				}
			},
			initialSearchInput,
		);
		return { component: selector, focus: selector };
	});
}

export async function showOAuthSelector(host: LoginFlowHost, mode: "login" | "logout"): Promise<void> {
	if (mode === "login") {
		showLoginAuthTypeSelector(host);
		return;
	}

	let providerOptions: AuthSelectorProvider[];
	try {
		providerOptions = await getLogoutProviderOptions(host);
	} catch (error) {
		host.showError(`Could not read stored credentials: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (providerOptions.length === 0) {
		host.showStatus(
			"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
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

				try {
					await host.session.modelRuntime.logout(providerOption.id, {
						signal: AbortSignal.timeout(15_000),
					});
					host.updateAvailableProviderCount();
					const message =
						providerOption.authType === "oauth"
							? `Logged out of ${providerOption.name}`
							: `Removed stored API key for ${providerOption.name}. Environment variables and models.json config are unchanged.`;
					host.showStatus(message);
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : String(error);
					host.showError(
						error instanceof CredentialSynchronizationError
							? `Credentials removed for ${providerOption.name}, but local model state could not be synchronized: ${message}`
							: `Logout failed: ${message}`,
					);
				}
			},
			() => {
				done();
				host.ui.requestRender();
			},
		);
		return { component: selector, focus: selector };
	});
}
