import type { CredentialInfo } from "@octocodeai/octocode-ai";
import { CredentialSynchronizationError } from "../../../core/model-runtime.ts";
import { errorMessage } from "../../../utils/guards.ts";
import { OAuthSelectorComponent, type AuthSelectorProvider } from "../components/oauth-selector.ts";
import type { InteractiveModeHost } from "./host.ts";
import { showPiProviders } from "./provider-pi.ts";

export type ProviderManagerHost = Pick<
	InteractiveModeHost,
	| "session"
	| "getLoginProviderOptions"
	| "showSelector"
	| "showExtensionSelector"
	| "showLoginDialog"
	| "showApiKeyLoginDialog"
	| "showAmbientAuthDialog"
	| "showModelSelector"
	| "showStatus"
	| "showError"
	| "updateAvailableProviderCount"
	| "ui"
>;

/** Describe configuration without resolving secrets or claiming a successful network login. */
function providerStatus(host: Pick<ProviderManagerHost, "session">, id: string): string {
	const runtime = host.session.modelRuntime;
	const status = runtime.getProviderAuthStatus(id);
	if (!status.configured) return "Not configured";
	const method = runtime.isUsingOAuth(id) ? "Account" : "API key";
	const source =
		status.label ??
		{
			stored: "saved credential",
			runtime: "session credential",
			environment: "environment",
			fallback: "extension configuration",
			models_json_key: "models.json",
			models_json_command: "secret command in models.json",
		}[status.source ?? "environment"];
	return `${method} configured · ${source}`;
}

export async function removeProviderCredential(host: ProviderManagerHost, id: string, name: string): Promise<void> {
	const sessionOverride = host.session.modelRuntime.getProviderAuthStatus(id).source === "runtime";
	const removeLabel = sessionOverride
		? "Remove saved and session credentials — environment and models.json stay unchanged"
		: "Remove credential — environment and models.json stay unchanged";
	const choice = await host.showExtensionSelector(
		`Remove ${sessionOverride ? "saved and session credentials" : "saved credential"} for ${name}?`,
		["Cancel", removeLabel],
	);
	if (choice !== removeLabel) return;
	try {
		await host.session.modelRuntime.logout(id, { signal: AbortSignal.timeout(15_000) });
		host.updateAvailableProviderCount();
		const remains = host.session.modelRuntime.getProviderAuthStatus(id).configured;
		host.showStatus(
			`Removed ${sessionOverride ? "saved and session credentials" : "saved credential"} for ${name}.${remains ? ` Still configured: ${providerStatus(host, id)}.` : ""} Environment and models.json are unchanged.`,
		);
	} catch (error) {
		host.showError(
			error instanceof CredentialSynchronizationError
				? `Credential removed for ${name}, but model availability could not be updated. Reopen /providers.`
				: `Could not remove credential: ${errorMessage(error)}`,
		);
	}
}

async function manageProvider(host: ProviderManagerHost, id: string, saved: readonly CredentialInfo[]): Promise<void> {
	const runtime = host.session.modelRuntime;
	const provider = runtime.getProvider(id);
	const name = provider?.name ?? id;
	const sessionOverride = runtime.getProviderAuthStatus(id).source === "runtime";
	const methods = host.getLoginProviderOptions().filter((option) => option.id === id);
	const choices = new Map<string, () => void | Promise<void>>();
	if (sessionOverride)
		choices.set("Clear session API key override — keep saved credentials", async () => {
			await runtime.removeRuntimeApiKey(id, { signal: AbortSignal.timeout(15_000) });
			host.updateAvailableProviderCount();
			host.showStatus(`Cleared session override for ${name}. ${providerStatus(host, id)}.`);
		});
	if (runtime.getAvailableSnapshot().some((model) => model.provider === id)) {
		choices.set("Choose a model for this chat", () => host.showModelSelector(`${id}/`));
	}
	for (const option of methods) {
		const back = () => {
			void showProviderManager(host, id);
		};
		if (option.authType === "oauth") {
			choices.set(
				`${runtime.isUsingOAuth(id) ? "Sign in again" : "Sign in"} — ${option.method?.name ?? "account"}`,
				() => host.showLoginDialog(id, name, back),
			);
		} else if (option.method?.login) {
			choices.set(
				`${sessionOverride ? "Update saved" : saved.some((entry) => entry.providerId === id) ? "Replace" : "Add"} API key`,
				() => host.showApiKeyLoginDialog(id, name, back),
			);
		} else {
			choices.set(`Setup instructions — ${option.method?.name ?? "external credentials"}`, () =>
				host.showAmbientAuthDialog(option, back),
			);
		}
	}
	if (saved.some((entry) => entry.providerId === id)) {
		choices.set(sessionOverride ? "Remove saved and session credentials" : "Remove saved credential", () =>
			removeProviderCredential(host, id, name),
		);
	}
	if (!choices.size) {
		host.showStatus(`${name}: ${providerStatus(host, id)}. Configure this provider in models.json.`);
		return;
	}
	const choice = await host.showExtensionSelector(`${name} — ${providerStatus(host, id)}`, [...choices.keys()]);
	if (choice) await choices.get(choice)?.();
}

export async function showProviderManager(host: ProviderManagerHost, query = ""): Promise<void> {
	if (query.trim().toLowerCase() === "pi") {
		await showPiProviders(host, (id) => showProviderManager(host, id));
		return;
	}
	let saved: readonly CredentialInfo[];
	try {
		saved = await host.session.modelRuntime.listCredentials({ signal: AbortSignal.timeout(15_000) });
	} catch {
		host.showError("Could not read saved provider credentials. No credentials were changed.");
		return;
	}
	const runtime = host.session.modelRuntime;
	const ids = new Set([
		...runtime.getProviders().map((provider) => provider.id),
		...saved.map((entry) => entry.providerId),
	]);
	const providers: AuthSelectorProvider[] = [...ids].map((id) => ({
		id,
		name: runtime.getProvider(id)?.name ?? id,
		authType: "api_key",
		detail: `${providerStatus(host, id)} · ${runtime.getAvailableSnapshot().filter((model) => model.provider === id).length} models`,
	}));
	providers.sort(
		(a, b) =>
			Number(runtime.hasConfiguredAuth(b.id)) - Number(runtime.hasConfiguredAuth(a.id)) || a.name.localeCompare(b.name),
	);
	const exact = providers.find((provider) =>
		[provider.id, provider.name].some((value) => value.toLowerCase() === query.trim().toLowerCase()),
	);
	if (exact) {
		await manageProvider(host, exact.id, saved);
		return;
	}
	providers.push({
		id: "__pi__",
		name: "Pi (config)",
		authType: "api_key",
		detail: "Use models.json providers or import saved sign-ins",
	});
	host.showSelector((done) => {
		const selector = new OAuthSelectorComponent(
			"manage",
			providers,
			async (id) => {
				done();
				try {
					if (id === "__pi__") await showPiProviders(host, (providerId) => showProviderManager(host, providerId));
					else await manageProvider(host, id, saved);
				} catch (error) {
					host.showError(errorMessage(error));
				}
			},
			done,
			query,
		);
		return { component: selector, focus: selector };
	});
}
