import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { CredentialSynchronizationError } from "../../../core/model-runtime.ts";
import { credentialSourceLabel } from "../../../core/provider-composer/types.ts";
import type { ProviderManagerHost } from "./provider-manager-host.ts";
import { confirmAction, successNotice } from "./provider-ui.ts";

/** Describe configuration without resolving secrets or claiming a successful network login. */
export async function providerStatus(host: Pick<ProviderManagerHost, "session">, id: string): Promise<string> {
	const runtime = host.session.modelRuntime;
	const status = runtime.getProviderAuthStatus(id);
	if (!status.configured) return "Not configured";
	return `${KIND_LABELS[await runtime.getCredentialKind(id, AbortSignal.timeout(15_000))]} configured · ${credentialSource(host, id)}`;
}

/** The credential kind in a provider's words, for its page. */
const KIND_LABELS = { account: "Account", subscription: "Subscription", key: "API key" } as const;

/** Where the credential comes from, for a row: a label or variable name, never a value. */
export function credentialSource(host: Pick<ProviderManagerHost, "session">, id: string): string {
	return credentialSourceLabel(host.session.modelRuntime.getProviderAuthStatus(id));
}

export const isProviderDisabled = (host: Pick<ProviderManagerHost, "session">, id: string): boolean =>
	host.session.settingsManager.getDisabledProviders().includes(id);

export const modelCount = (host: Pick<ProviderManagerHost, "session">, id: string): number =>
	host.session.modelRuntime.getAvailableSnapshot().filter((model) => model.provider === id).length;

/** Turn a provider on or off in settings and the live runtime. Saved credentials are never touched. */
export function setProviderEnabled(host: ProviderManagerHost, id: string, name: string, enabled: boolean): void {
	const { settingsManager, modelRuntime } = host.session;
	const others = settingsManager.getDisabledProviders().filter((entry) => entry !== id);
	const disabled = enabled ? others : [...others, id];
	settingsManager.setDisabledProviders(disabled);
	modelRuntime.setDisabledProviders(disabled);
	host.updateAvailableProviderCount();
	if (enabled) {
		host.showStatus(successNotice("Enabled", name, "Its models are available again."));
		return;
	}
	host.showStatus(successNotice("Disabled", name, "Its models are hidden; saved credentials are unchanged."));
	const current = host.session.model;
	if (current?.provider === id) {
		host.showWarning(
			`This chat still runs on ${id}/${current.id}. Switch with /model or Ctrl+P; to keep using ${name}, run /providers ${id} and choose Enable provider.`,
		);
	}
}

/** Remove the saved (and session) credential for a provider after one confirmation. Returns true when it was removed. */
export async function removeProviderCredential(host: ProviderManagerHost, id: string, name: string): Promise<boolean> {
	const sessionOverride = host.session.modelRuntime.getProviderAuthStatus(id).source === "runtime";
	const what = sessionOverride ? "saved and session credentials" : "saved credential";
	const confirmed = await confirmAction(host, `Remove ${what} for ${name}?`, [
		sessionOverride
			? "Remove saved and session credentials — environment and models.json stay unchanged"
			: "Remove credential — environment and models.json stay unchanged",
	]);
	if (!confirmed) return false;
	try {
		await host.session.modelRuntime.logout(id, { signal: AbortSignal.timeout(15_000) });
		host.updateAvailableProviderCount();
		const remains = host.session.modelRuntime.getProviderAuthStatus(id).configured;
		host.showStatus(
			successNotice(
				`Removed ${what} for`,
				name,
				`${remains ? `Still configured: ${await providerStatus(host, id)}. ` : ""}Environment and models.json are unchanged.`,
			),
		);
		return true;
	} catch (error) {
		host.showError(
			error instanceof CredentialSynchronizationError
				? `Credential removed for ${name}, but model availability could not be updated. Reopen /providers.`
				: `Could not remove credential: ${errorMessage(error)}`,
		);
		return false;
	}
}
