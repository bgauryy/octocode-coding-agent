import { join } from "node:path";
import { getLegacyProviderDirs } from "../../../config.ts";
import { detectKeychain } from "../../../core/auth-storage/keychain.ts";
import { ReadOnlyAuthStorage } from "../../../core/auth-storage/read-only.ts";
import { providerSourceGate } from "../../../core/provider-sources/gate.ts";
import { discoveryInput } from "../../../core/discovery/service.ts";
import {
	listPiProviderCredentials,
	listPiModelProviders,
	readPiProviderCredential,
} from "../../../core/auth-storage/pi.ts";
import { CredentialSynchronizationError } from "../../../core/model-runtime.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { ProviderManagerHost } from "./provider-manager-host.ts";
import { confirmAction, successNotice } from "./provider-ui.ts";

/** Pi's configuration folders, empty when Pi discovery is off (explicit Octocode home or SDK directory). */
export function piConfigDirs(host: Pick<ProviderManagerHost, "session">): string[] {
	const directory = host.session.modelRuntime.getConfigurationDirectory();
	return directory
		? [...discoveryInput({ cwd: process.cwd(), agentDir: directory, projectTrusted: false }).piRoots]
		: [];
}

/**
 * Why a Pi (or legacy `~/.octocode`) account sign-in for `id` is not used, when the provider has no account sign-in in
 * Octocode: Pi's Claude Pro/Max sign-in is one. Undefined when there is none or Pi is off.
 */
export async function unsupportedPiSignIn(
	host: Pick<ProviderManagerHost, "session">,
	id: string,
	name: string,
): Promise<string | undefined> {
	const runtime = host.session.modelRuntime;
	const directory = runtime.getConfigurationDirectory();
	if (!directory || !providerSourceGate.isEnabled("pi") || runtime.getProvider(id)?.auth.oauth) return undefined;
	for (const dir of getLegacyProviderDirs(directory)) {
		const path = join(dir, "auth.json");
		// Problems in the file are startup warnings; here they only mean no sign-in.
		const credential = await new ReadOnlyAuthStorage(path, { onProblem: () => {} }).readRaw(id);
		if (credential?.type !== "oauth") continue;
		const next = runtime.getProviderAuthStatus(id).configured
			? "Octocode uses this provider's other credentials."
			: "Add an API key to use it.";
		return `The account sign-in in ${path} is a type Octocode's ${name} provider does not support, so it is not used. ${next}`;
	}
	return undefined;
}

/** Pi is a setup source. Its providers still own authentication, model IDs and requests. */
export async function showPiProviders(
	host: ProviderManagerHost,
	openProvider: (id: string) => Promise<void>,
): Promise<void> {
	try {
		const dirs = piConfigDirs(host);
		const [entries, definitions] = await Promise.all([listPiProviderCredentials(dirs), listPiModelProviders(dirs)]);
		const ids = [...new Set([...entries.map((entry) => entry.providerId), ...definitions.keys()])];
		if (!ids.length) {
			host.showStatus(
				"No Pi providers found in models.json or auth.json. Pi discovery is disabled with an explicit Octocode home or SDK directory. Use /providers to connect directly.",
			);
			return;
		}
		const runtime = host.session.modelRuntime;
		const choices = ids.map((id) => {
			const provider = runtime.getProvider(id);
			const count = runtime.getModels(id).length;
			const entry = entries.find((candidate) => candidate.providerId === id);
			return `${provider?.name ?? id} (${id}) — ${entry ? (entry.type === "oauth" ? "account" : "API key") : "models.json"} · ${count} catalog models${provider ? "" : " · provider definition missing"}`;
		});
		const choice = await host.showSelectorDialog("Pi (config) — models.json providers and saved sign-ins", choices);
		if (!choice) return;
		const id = ids[choices.indexOf(choice)];
		const entry = entries.find((candidate) => candidate.providerId === id);
		if (!id || !runtime.getProvider(id)) {
			host.showError("This Pi provider has no model definition. Add its definition to models.json first.");
			return;
		}
		if (!entry) {
			await openProvider(id);
			return;
		}
		if (runtime.getAvailableSnapshot().some((model) => model.provider === id)) {
			const action = await host.showSelectorDialog(`Pi · ${id}`, ["Choose a model", "Import Pi credential"]);
			if (action === "Choose a model") host.showModelSelector(`${id}/`);
			if (action !== "Import Pi credential") return;
		}
		const keychain = entry.type === "api_key" ? detectKeychain(process.platform) : undefined;
		const keychainLabel = keychain ? `Import API key into ${keychain.name}` : undefined;
		const fileLabel = "Import into local auth.json (plaintext; created with owner-only permissions)";
		const confirm = await confirmAction(
			host,
			`Import ${entry.providerId} from Pi? This replaces its saved Octocode credential.`,
			[...(keychainLabel ? [keychainLabel] : []), fileLabel],
		);
		if (!confirm) return;
		const useKeychain = keychain && confirm === keychainLabel;
		const credential = await readPiProviderCredential(entry, Boolean(useKeychain));
		await runtime.importCredential(
			entry.providerId,
			credential,
			{ signal: AbortSignal.timeout(15_000) },
			useKeychain
				? {
						transformCredential: async (value) => {
							if (value.type !== "api_key" || !value.key) throw new Error("Pi credential has no API key to store.");
							await keychain.store(entry.providerId, value.key);
							return { ...value, key: keychain.referenceFor(entry.providerId) };
						},
					}
				: undefined,
		);
		host.updateAvailableProviderCount();
		host.showStatus(
			successNotice(
				"Imported",
				entry.providerId,
				"Pi files are unchanged. Choose a model to start using this provider.",
			),
		);
		host.showModelSelector(`${entry.providerId}/`);
	} catch (error) {
		host.showError(
			error instanceof CredentialSynchronizationError
				? "Pi credential imported, but local model availability could not be updated. Reopen /providers."
				: `Could not import from Pi: ${errorMessage(error)}`,
		);
	}
}
