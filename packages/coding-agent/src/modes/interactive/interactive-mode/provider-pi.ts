import { detectKeychain } from "../../../core/auth-storage/keychain.ts";
import { discoveryInput } from "../../../core/discovery/service.ts";
import {
	listPiProviderCredentials,
	listPiModelProviders,
	readPiProviderCredential,
} from "../../../core/auth-storage/pi.ts";
import { CredentialSynchronizationError } from "../../../core/model-runtime.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { ProviderManagerHost } from "./provider-manager-host.ts";

/** Pi is a setup source. Its providers still own authentication, model IDs and requests. */
export async function showPiProviders(
	host: ProviderManagerHost,
	openProvider: (id: string) => Promise<void>,
): Promise<void> {
	try {
		const directory = host.session.modelRuntime.getConfigurationDirectory();
		const dirs = directory
			? [...discoveryInput({ cwd: process.cwd(), agentDir: directory, projectTrusted: false }).piRoots]
			: [];
		const [entries, definitions] = await Promise.all([listPiProviderCredentials(dirs), listPiModelProviders(dirs)]);
		const ids = [...new Set([...entries.map((entry) => entry.providerId), ...definitions.keys()])];
		if (!ids.length) {
			host.showStatus(
				"No Pi providers found in models.json or auth.json. Pi discovery is disabled with an explicit Octocode home or SDK directory. Use /login to connect directly.",
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
		const choice = await host.showExtensionSelector("Pi (config) — models.json providers and saved sign-ins", choices);
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
			const action = await host.showExtensionSelector(`Pi · ${id}`, ["Choose a model", "Import Pi credential"]);
			if (action === "Choose a model") host.showModelSelector(`${id}/`);
			if (action !== "Import Pi credential") return;
		}
		const keychain = entry.type === "api_key" ? detectKeychain(process.platform) : undefined;
		const confirm = await host.showExtensionSelector(
			`Import ${entry.providerId} from Pi? This replaces its saved Octocode credential.`,
			[
				"Cancel",
				...(keychain ? [`Import API key into ${keychain.name}`] : []),
				"Import into local auth.json (plaintext; created with owner-only permissions)",
			],
		);
		if (!confirm || confirm === "Cancel") return;
		const useKeychain = keychain && confirm === `Import API key into ${keychain.name}`;
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
			`Imported ${entry.providerId} from Pi. Pi files are unchanged. Choose a model to start using this provider.`,
		);
		host.showModelSelector(`${entry.providerId}/`);
	} catch (error) {
		host.showError(
			error instanceof CredentialSynchronizationError
				? "Pi credential imported, but local model availability could not be updated. Reopen /login."
				: `Could not import from Pi: ${errorMessage(error)}`,
		);
	}
}
