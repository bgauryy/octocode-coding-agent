/**
 * The read model behind the configuration page: which credential sources exist per provider, the allow-listed
 * settings with the file they come from, and whether the workspace is trusted. Nothing here returns a key value.
 *
 * Credentials come from `ReadOnlyAuthStorage`, which never creates or writes `auth.json`. `list()` gives the provider
 * IDs and credential types; `readRaw()` (not `read()`) gives the stored entry so its shape can be classified. `read()`
 * would run a `!` reference, which is a shell command. A raw entry stays inside `classify` and only a source kind
 * leaves it. Precedence between `auth.json` and environment variables is not verified (RFC N3), so the snapshot lists
 * the sources that are present and never names an effective one.
 */

import { join } from "node:path";
import type { Credential } from "@octocodeai/octocode-ai";
import { findEnvKeys } from "@octocodeai/octocode-ai/compat";
import { builtinProviders } from "@octocodeai/octocode-ai/providers/all";
import {
	CONFIG_PROTOCOL_VERSION,
	type ConfigSetting,
	type ConfigSnapshot,
	type CredentialSourceStatus,
	type ProviderCredentialStatus,
	type SettingsFileError,
} from "@octocodeai/octocode-contracts/config";
import { ReadOnlyAuthStorage } from "../../core/auth-storage/read-only.ts";
import { detectKeychain, type KeychainBackend } from "../../core/auth-storage/keychain.ts";
import { getConfigValueEnvVarNames, isCommandConfigValue } from "../../core/resolve-config-value.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { ProjectTrustStore } from "../../core/trust-manager.ts";
import { repoKey } from "../shared/home/repo.ts";

export interface ConfigStatusOptions {
	agentDir: string;
	/** The workspace whose settings and trust to report. Without it only global settings are shown. */
	cwd?: string;
	/** Variables that override `process.env` when looking for provider variables, as requests do. */
	env?: NodeJS.ProcessEnv;
	/** The keychain to report on and to recognise references of; default: this platform's. `null`: none. */
	keychain?: KeychainBackend | null;
}

/** The settings the page shows, in order. Each is a string; project values replace global ones. */
const CONFIG_SETTING_KEYS = ["defaultProvider", "defaultModel"] as const;

const CREDENTIALS_ERROR = "auth.json could not be read; only environment variables are shown.";
const SETTINGS_ERROR = "This settings file is invalid, so its values are not shown. Fix it in a terminal.";

/** References made by either platform's keychain tool are ours wherever the file was written; nothing is run. */
function referenceMatchers(extra: KeychainBackend | null | undefined): KeychainBackend[] {
	const never = async () => {
		throw new Error("not used");
	};
	const found = (platform: NodeJS.Platform) => detectKeychain(platform, (command) => command, never);
	return [extra, found("darwin"), found("linux")].filter((keychain): keychain is KeychainBackend => !!keychain);
}

function isSet(name: string, credential: Credential | undefined, env: NodeJS.ProcessEnv): boolean {
	const own = credential?.type === "api_key" ? credential.env?.[name] : undefined;
	return !!(own || env[name] || process.env[name]);
}

/** The sources one `auth.json` entry provides. Reads only the entry's shape; no value or reference text is kept. */
function classify(
	provider: string,
	credential: Credential,
	matchers: readonly KeychainBackend[],
	env: NodeJS.ProcessEnv,
): CredentialSourceStatus[] {
	if (credential.type === "oauth") {
		return [{ kind: "oauth", ...(credential.expires > 0 ? { expiresAt: credential.expires } : {}) }];
	}
	const key = credential.key;
	if (!key) return [];
	if (isCommandConfigValue(key)) {
		return [
			{ kind: matchers.some((matcher) => matcher.isOwnReference(key, provider)) ? "keychain" : "custom-command" },
		];
	}
	// "$NAME" is a reference to a variable, not a stored key; it counts only while the variable is set.
	const names = getConfigValueEnvVarNames(key);
	if (names.length === 0) return [{ kind: "auth-json" }];
	return names.filter((name) => isSet(name, credential, env)).map((envVar) => ({ kind: "env", envVar }));
}

interface StoredSources {
	byProvider: Map<string, CredentialSourceStatus[]>;
	error?: string;
}

async function readStoredSources(
	agentDir: string,
	matchers: readonly KeychainBackend[],
	env: NodeJS.ProcessEnv,
): Promise<StoredSources> {
	const byProvider = new Map<string, CredentialSourceStatus[]>();
	try {
		const store = new ReadOnlyAuthStorage(join(agentDir, "auth.json"));
		for (const { providerId } of await store.list()) {
			const credential = await store.readRaw(providerId);
			if (credential) byProvider.set(providerId, classify(providerId, credential, matchers, env));
		}
		return { byProvider };
	} catch {
		return { byProvider: new Map(), error: CREDENTIALS_ERROR };
	}
}

function envSources(provider: string, env: NodeJS.ProcessEnv): CredentialSourceStatus[] {
	return (findEnvKeys(provider, env as Record<string, string>) ?? []).map((envVar) => ({ kind: "env", envVar }));
}

function mergeSources(...lists: CredentialSourceStatus[][]): CredentialSourceStatus[] {
	const seen = new Set<string>();
	return lists.flat().filter((source) => {
		const id = `${source.kind}:${source.envVar ?? ""}`;
		if (seen.has(id)) return false;
		seen.add(id);
		return true;
	});
}

function providerRows(stored: StoredSources, env: NodeJS.ProcessEnv): ProviderCredentialStatus[] {
	const known = new Map(builtinProviders().map((provider) => [provider.id, provider.name]));
	const ids = [...known.keys(), ...[...stored.byProvider.keys()].filter((id) => !known.has(id)).sort()];
	return ids.map((provider) => {
		const sources = mergeSources(stored.byProvider.get(provider) ?? [], envSources(provider, env));
		const name = known.get(provider);
		return { provider, ...(name ? { name } : {}), configured: sources.length > 0, sources };
	});
}

function settingRows(manager: SettingsManager): ConfigSetting[] {
	const global = manager.getGlobalSettings();
	const project = manager.getProjectSettings();
	return CONFIG_SETTING_KEYS.map((key) => {
		if (project[key] !== undefined) return { key, value: project[key], source: "workspace" };
		if (global[key] !== undefined) return { key, value: global[key], source: "global" };
		return { key, source: "default" };
	});
}

export async function buildConfigSnapshot(options: ConfigStatusOptions): Promise<ConfigSnapshot> {
	const env = options.env ?? process.env;
	const keychain = options.keychain === undefined ? detectKeychain(process.platform) : options.keychain;
	const stored = await readStoredSources(options.agentDir, referenceMatchers(keychain), env);

	// Project settings load only for a project the user trusted, as at startup.
	const trusted =
		options.cwd !== undefined && new ProjectTrustStore(options.agentDir, () => {}).get(options.cwd) === true;
	const manager = SettingsManager.create(options.cwd ?? options.agentDir, options.agentDir, {
		projectTrusted: trusted,
	});
	const settingsErrors: SettingsFileError[] = manager
		.drainErrors()
		.map(({ scope }) => ({ scope: scope === "project" ? "workspace" : "global", message: SETTINGS_ERROR }));

	return {
		protocolVersion: CONFIG_PROTOCOL_VERSION,
		generatedAt: Date.now(),
		keychainAvailable: keychain !== undefined && keychain !== null,
		providers: providerRows(stored, env),
		...(stored.error ? { credentialsError: stored.error } : {}),
		settings: settingRows(manager),
		...(settingsErrors.length > 0 ? { settingsErrors } : {}),
		...(options.cwd !== undefined ? { workspace: { repo: repoKey(options.cwd).name, trusted } } : {}),
	};
}
