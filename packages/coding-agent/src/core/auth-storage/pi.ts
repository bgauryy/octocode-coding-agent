import { join } from "node:path";
import type { CredentialInfo } from "@octocodeai/octocode-ai";
import { getAgentDir, getLegacyConfigDirs } from "../../config.ts";
import { configDiscovery, discoveryInput } from "../discovery/service.ts";
import { ReadOnlyAuthStorage } from "./read-only.ts";
import { ModelConfig } from "../model-config.ts";
import { resolveConfigValue } from "../config-value.ts";

export interface PiProviderCredential extends CredentialInfo {
	authPath: string;
}

/**
 * The read-only fallback folders whose auth.json the runtime uses: the Octocode Pi extension's, then Pi's (none when an
 * explicit home is set). The same list the credential store reads, so what is listed is what is used.
 */
function piDirs(): string[] {
	return getLegacyConfigDirs(getAgentDir());
}

/** Inspect Pi's credential metadata only. Import is an explicit, separate user action. */
export async function listPiProviderCredentials(dirs = piDirs()): Promise<PiProviderCredential[]> {
	const entries = new Map<string, PiProviderCredential>();
	for (const dir of dirs) {
		const authPath = join(dir, "auth.json");
		const metadata = await new ReadOnlyAuthStorage(authPath).list().catch(() => {
			throw new Error(`Could not read Pi credentials at ${authPath}. Check the auth.json format.`);
		});
		for (const entry of metadata) {
			if (!entries.has(entry.providerId)) entries.set(entry.providerId, { ...entry, authPath });
		}
	}
	return [...entries.values()];
}

/** Preserve file references when copying; resolve keys only when moving their value into a keychain. */
export async function readPiProviderCredential(entry: PiProviderCredential, resolveApiKey = false) {
	const credential = await new ReadOnlyAuthStorage(entry.authPath).readRaw(entry.providerId).catch(() => {
		throw new Error(`Could not read the selected Pi credential at ${entry.authPath}. Check the auth.json format.`);
	});
	if (!credential) throw new Error("The Pi credential was removed. Reopen /providers pi.");
	if (credential.type !== entry.type) throw new Error("The Pi credential changed. Reopen /providers pi.");
	if (credential.type === "api_key" && credential.key?.startsWith("!")) {
		throw new Error(
			"Pi uses a secret command. Configure this provider directly in /providers; its command was not executed.",
		);
	}
	if (resolveApiKey && credential.type === "api_key") {
		const key = credential.key === undefined ? undefined : resolveConfigValue(credential.key, credential.env);
		if (!key) throw new Error("The Pi API key could not be resolved. Set its referenced environment variables first.");
		return { ...credential, key };
	}
	return credential;
}

/** Provider definitions use the same schema and precedence as normal model discovery. */
export async function listPiModelProviders(dirs?: string[]): Promise<Map<string, string>> {
	const providers = new Map<string, string>();
	// Pi's model files as discovery lists them (existing files, in precedence order), unless the caller names the folders.
	const input = discoveryInput({ cwd: process.cwd(), agentDir: getAgentDir(), projectTrusted: false });
	const files = dirs
		? dirs.map((dir) => join(dir, "models.json"))
		: configDiscovery
				.discover("model", input)
				.filter((item) => item.provenance.product === "pi")
				.map((item) => item.provenance.path);
	for (const path of files) {
		const config = await ModelConfig.loadFile(path);
		if (config.getError()) throw new Error(`Could not load Pi model definitions from ${path}. Check models.json.`);
		for (const id of config.getProviderIds()) if (!providers.has(id)) providers.set(id, path);
	}
	return providers;
}
