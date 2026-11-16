import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { CredentialSynchronizationError } from "../../../core/model-runtime.ts";
import { buildProviderSnapshot, claudeSubscriptionRefusal as refusalOf } from "../../../core/provider-view/snapshot.ts";
import type { ProviderManagerHost } from "./provider-manager-host.ts";
import { confirmAction, successNotice } from "./provider-ui.ts";

type SessionHost = Pick<ProviderManagerHost, "session">;

/** The provider's one status sentence, from the snapshot. */
export async function providerStatus(host: SessionHost, id: string): Promise<string> {
	const { modelRuntime, settingsManager } = host.session;
	const snapshot = await buildProviderSnapshot({
		runtime: modelRuntime,
		disabledProviders: settingsManager.getDisabledProviders(),
		ids: [id],
	});
	const entry = snapshot.entry(id);
	if (!entry) throw new Error(`Provider ${id} is neither defined nor has a saved credential`);
	return entry.statusText;
}

/** Why a saved or set credential configures nothing because it is a Claude subscription token, or undefined. */
export const claudeSubscriptionRefusal = (host: SessionHost, id: string): Promise<string | undefined> =>
	refusalOf(host.session.modelRuntime, id);

export const isProviderDisabled = (host: Pick<ProviderManagerHost, "session">, id: string): boolean =>
	host.session.settingsManager.getDisabledProviders().includes(id);

const modelCount = (host: Pick<ProviderManagerHost, "session">, id: string): number =>
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
		const count = modelCount(host, id);
		host.showStatus(
			successNotice(
				"Enabled",
				name,
				`${count} ${count === 1 ? "model" : "models"} available${count ? "." : "; check credentials and plan status."}`,
			),
		);
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
	const authStatus = host.session.modelRuntime.getProviderAuthStatus(id);
	const sessionOverride = authStatus.source === "runtime";
	const what = sessionOverride ? "saved and session credentials" : "saved credential";
	// A credential that lives in Pi's or a legacy auth file is signed out in Octocode only; that file is never edited.
	const fileNote =
		authStatus.source === "stored" && authStatus.label ? `${authStatus.label}; that file stays unchanged` : "";
	const confirmed = await confirmAction(host, `Remove ${what} for ${name}?`, [
		sessionOverride
			? "Remove saved and session credentials — environment and models.json stay unchanged"
			: `Remove credential — ${fileNote ? `${fileNote}; ` : ""}environment and models.json stay unchanged`,
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
