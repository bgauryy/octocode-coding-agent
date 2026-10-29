import { join } from "node:path";
import type { CredentialInfo } from "@octocodeai/octocode-ai";
import { getLegacyConfigDirs } from "../../config.ts";
import { ReadOnlyAuthStorage } from "./read-only.ts";
import { ModelConfig } from "../model-config.ts";
import { resolveConfigValue } from "../resolve-config-value.ts";

export interface PiProviderCredential extends CredentialInfo {
	authPath: string;
}

/** Inspect Pi's credential metadata only. Import is an explicit, separate user action. */
export async function listPiProviderCredentials(dirs = getLegacyConfigDirs()): Promise<PiProviderCredential[]> {
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
		throw new Error("Could not read the selected Pi credential. Check the auth.json format.");
	});
	if (!credential) throw new Error("The Pi credential was removed. Reopen /login pi.");
	if (credential.type !== entry.type) throw new Error("The Pi credential changed. Reopen /login pi.");
	if (credential.type === "api_key" && credential.key?.startsWith("!")) {
		throw new Error(
			"Pi uses a secret command. Configure this provider directly in /login; its command was not executed.",
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
export async function listPiModelProviders(dirs = getLegacyConfigDirs()): Promise<Map<string, string>> {
	const providers = new Map<string, string>();
	for (const dir of dirs) {
		const path = join(dir, "models.json");
		const config = await ModelConfig.load(path);
		if (config.getError()) throw new Error(`Could not load Pi model definitions from ${path}. Check models.json.`);
		for (const id of config.getProviderIds()) if (!providers.has(id)) providers.set(id, path);
	}
	return providers;
}
