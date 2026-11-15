import {
	CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL,
	carriesClaudeSubscriptionToken,
} from "@octocodeai/octocode-ai/api/anthropic-messages/token";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { CredentialSynchronizationError } from "../../../core/model-runtime.ts";
import { type CredentialState, credentialState } from "../../../core/provider-composer/credential-state.ts";
import { credentialSourceLabel } from "../../../core/provider-composer/types.ts";
import { providerAccessLabel } from "../../../core/provider-label.ts";
import type { ProviderManagerHost } from "./provider-manager-host.ts";
import { confirmAction, successNotice } from "./provider-ui.ts";

/** Describe configuration without resolving secrets or claiming a successful network login. */
export async function providerStatus(host: Pick<ProviderManagerHost, "session">, id: string): Promise<string> {
	const runtime = host.session.modelRuntime;
	const status = runtime.getProviderAuthStatus(id);
	const state = await providerCredentialState(host, id);
	if (state === "signed out") return "Signed out";
	if (state === "expired") return `Expired · ${credentialSource(host, id)} · sign in again`;
	if (!status.configured) {
		const refusal = await claudeSubscriptionRefusal(host, id);
		return refusal ? `Not set: ${refusal}` : "Not set";
	}
	const kind = await runtime.getCredentialKind(id);
	const label = kind === "key" ? providerAccessLabel(runtime, id) : KIND_LABELS[kind];
	return `Connected · ${label} · ${credentialSource(host, id)}`;
}

/** Connected, expired, signed out or not set; a credential that cannot be read counts as none saved. */
export async function providerCredentialState(
	host: Pick<ProviderManagerHost, "session">,
	id: string,
): Promise<CredentialState> {
	const runtime = host.session.modelRuntime;
	const credential = await runtime.readCredential(id, { signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
	return credentialState(runtime.getProviderAuthStatus(id), credential);
}

/**
 * Why a provider has no usable credential although one is saved or set: it is a Claude subscription token, which
 * configures nothing (no model is offered) and which every request refuses. The key is resolved the way a request
 * resolves it, inspected and not kept; a lookup that fails reports nothing.
 */
export async function claudeSubscriptionRefusal(
	host: Pick<ProviderManagerHost, "session">,
	id: string,
): Promise<string | undefined> {
	try {
		const auth = (await host.session.modelRuntime.getAuth(id))?.auth;
		return carriesClaudeSubscriptionToken(auth?.apiKey, auth?.headers) ? CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL : undefined;
	} catch {
		return undefined;
	}
}

/** The credential kind in a provider's words, for its page. */
const KIND_LABELS = { account: "Account", subscription: "Subscription", key: "API key" } as const;

/** Where the credential comes from, for a row: a label or variable name, never a value. */
function credentialSource(host: Pick<ProviderManagerHost, "session">, id: string): string {
	return credentialSourceLabel(host.session.modelRuntime.getProviderAuthStatus(id));
}

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
