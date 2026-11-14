import type { CredentialInfo } from "@octocodeai/octocode-ai";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { OAuthSelectorComponent, type AuthSelectorProvider } from "../components/oauth-selector.ts";
import type { ProviderManagerHost } from "./provider-manager-host.ts";

/** What the page modules need to move between pages: the host, and a way back after a dialog closes. */
export interface PageContext {
	host: ProviderManagerHost;
	/** Reopen `/providers`: the list, or one provider's page. Dialogs call it synchronously, so it reports its own failure. */
	reopen(providerId?: string): void;
}

/**
 * The ways to sign in to one provider, as action rows: browser or device sign-in, an API key, or setup instructions
 * for ambient credentials. Dialogs return to the provider's page through `reopen`.
 */
export function signInActions(
	ctx: PageContext,
	id: string,
	name: string,
	saved: readonly CredentialInfo[],
): Map<string, () => void | Promise<void>> {
	const { host } = ctx;
	const runtime = host.session.modelRuntime;
	const sessionOverride = runtime.getProviderAuthStatus(id).source === "runtime";
	const back = () => ctx.reopen(id);
	const actions = new Map<string, () => void | Promise<void>>();
	for (const option of host.getLoginProviderOptions().filter((entry) => entry.id === id)) {
		if (option.authType === "oauth") {
			actions.set(
				`${runtime.isUsingOAuth(id) ? "Sign in again" : "Sign in"} — ${option.method?.name ?? "account"}`,
				() => host.showLoginDialog(id, name, back),
			);
		} else if (option.method?.login) {
			const methodName = option.method.name;
			const verb = sessionOverride
				? "Update saved"
				: saved.some((entry) => entry.providerId === id)
					? "Replace"
					: "Add";
			actions.set(/\bAPI key\b/i.test(methodName) ? `${verb} API key` : `Configure — ${methodName}`, () =>
				host.showApiKeyLoginDialog(id, name, back),
			);
		} else {
			actions.set(`Setup instructions — ${option.method?.name ?? "external credentials"}`, () =>
				host.showAmbientAuthDialog(option, back),
			);
		}
	}
	return actions;
}

/**
 * Open the sign-in flow for one provider with Octocode's own sign-in. With `prefer`, that method runs directly when the
 * provider offers it; otherwise the user chooses among the provider's methods.
 */
export async function signInToProvider(
	ctx: PageContext,
	id: string,
	saved: readonly CredentialInfo[],
	prefer?: "oauth" | "api_key",
): Promise<boolean> {
	const { host } = ctx;
	const name = host.session.modelRuntime.getProvider(id)?.name ?? id;
	const options = host.getLoginProviderOptions().filter((entry) => entry.id === id);
	if (options.length === 0) {
		host.showError(`${name} has no sign-in method in this build. Define it in models.json with an API key.`);
		return false;
	}
	const actions = signInActions(ctx, id, name, saved);
	const preferred = options.find((option) => option.authType === prefer);
	const labels = [...actions.keys()];
	const picked =
		preferred && labels.length > 0
			? labels[options.indexOf(preferred)]
			: labels.length === 1
				? labels[0]
				: await host.showExtensionSelector(`Sign in to ${name}`, labels);
	if (!picked) return false;
	await actions.get(picked)?.();
	return true;
}

/** The `Sign in` row: a provider picker (every provider with a sign-in method), then that provider's sign-in. */
export async function showSignIn(ctx: PageContext, saved: readonly CredentialInfo[], query = ""): Promise<boolean> {
	const { host } = ctx;
	const runtime = host.session.modelRuntime;
	const methods = new Map<string, AuthSelectorProvider[]>();
	for (const option of host.getLoginProviderOptions())
		methods.set(option.id, [...(methods.get(option.id) ?? []), option]);
	const signIns = new Set<string>();
	const providers: AuthSelectorProvider[] = [...methods].map(([id, options]) => {
		const kinds = options.map((option) =>
			option.authType === "api_key"
				? (option.method?.name ?? "API key")
				: option.subscription
					? "subscription sign-in"
					: "account sign-in",
		);
		// The sign-in's own name ("OpenAI (ChatGPT subscription)") makes it findable by what the user pays for.
		const oauth = options.find((option) => option.authType === "oauth");
		if (oauth) signIns.add(id);
		return {
			id,
			name: runtime.getProvider(id)?.name ?? id,
			authType: "api_key",
			...(oauth?.method ? { method: oauth.method } : {}),
			detail: `${kinds.join(" or ")}${runtime.getProviderPlan(id)?.billing === "plan" ? " · billed by plan" : ""}${runtime.getProviderAuthStatus(id).configured ? " · configured" : ""}`,
		};
	});
	// Sign-ins (subscriptions and accounts) first: a few among dozens of API-key providers, and what most users come for.
	providers.sort((a, b) => Number(!signIns.has(a.id)) - Number(!signIns.has(b.id)) || a.name.localeCompare(b.name));
	const id = await new Promise<string | undefined>((resolve) => {
		host.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				"sign-in",
				providers,
				(providerId) => {
					done();
					resolve(providerId);
				},
				() => {
					done();
					resolve(undefined);
				},
				query,
			);
			return { component: selector, focus: selector };
		});
	});
	if (!id) return false;
	try {
		return await signInToProvider(ctx, id, saved);
	} catch (error) {
		host.showError(errorMessage(error));
		return false;
	}
}
