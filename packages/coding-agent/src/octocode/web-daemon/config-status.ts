/**
 * The read model behind the configuration page: which credential sources exist per provider, the allow-listed
 * settings with the file they come from, and whether the workspace is trusted. Nothing here returns a key value.
 *
 * Credentials come from `ReadOnlyAuthStorage`, which never creates or writes `auth.json`. `list()` gives the provider
 * IDs and credential types; `readRaw()` (not `read()`) gives the stored entry so its shape can be classified. `read()`
 * would run a `!` reference, which is a shell command. A raw entry stays inside `classify` and only a source kind
 * leaves it. Precedence between `auth.json` and environment variables is not verified, so the snapshot lists
 * the sources that are present and never names an effective one.
 */

import { join } from "node:path";
import type { Credential, ProviderAuth } from "@octocodeai/octocode-ai";
import { findEnvKeys } from "@octocodeai/octocode-ai/compat";
import { builtinProviders } from "@octocodeai/octocode-ai/providers/all";
import { Value } from "typebox/value";
import {
	CONFIG_PROTOCOL_VERSION,
	CONFIG_SETTING_KEYS,
	ProviderIdSchema,
	type ConfigSetting,
	type ConfigSnapshot,
	type CredentialSourceStatus,
	type ProviderAuthMethods,
	type ProviderCredentialStatus,
	type SettingsFileError,
} from "@octocodeai/octocode-contracts/config";
import { ReadOnlyAuthStorage } from "../../core/auth-storage/read-only.ts";
import { detectKeychain, type KeychainBackend } from "../../core/auth-storage/keychain.ts";
import { getConfigValueEnvVarNames, isCommandConfigValue } from "../../core/config-value.ts";
import { discoveryInput } from "../../core/discovery/service.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { readProviderOrigins, type ProviderOriginsView } from "./provider-origins.ts";
import { resolveFolderTrust } from "../trust/resolve.ts";
import { repoKey } from "../shared/home/repo.ts";

export interface ConfigStatusOptions {
	agentDir: string;
	/** The workspace whose settings and trust to report. Without it only global settings are shown. */
	cwd?: string;
	/** Variables that override `process.env` when looking for provider variables, as requests do. */
	env?: NodeJS.ProcessEnv;
	/** The keychain to report on and to recognise references of; default: this platform's. `null`: none. */
	keychain?: KeychainBackend | null;
	/** Pi's configuration folders; default: the ones discovery uses for `agentDir` (none for an explicit home). */
	piDirs?: readonly string[];
	/** The home directory for the sources' file checks; default: the real one. */
	home?: string;
}

const CREDENTIALS_ERROR = "auth.json could not be read; only environment variables are shown.";
const SETTINGS_ERROR = "This settings file is invalid, so its values are not shown. Fix it in a terminal.";

/** References made by either platform's keychain tool are ours wherever the file was written; nothing is run. */
export function referenceMatchers(extra: KeychainBackend | null | undefined): KeychainBackend[] {
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
export function classify(
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

/** The sign-ins a provider offers, as names and a public link. Nothing is resolved, so no command or request runs. */
function authMethods(auth: ProviderAuth | undefined): ProviderAuthMethods | undefined {
	if (!auth) return undefined;
	const { oauth, apiKey } = auth;
	const keyPage = apiKey?.keyPage && /^https:\/\/\S+$/.test(apiKey.keyPage) ? apiKey.keyPage : undefined;
	const methods: ProviderAuthMethods = {
		...(oauth
			? {
					oauth: {
						name: oauth.name,
						...(oauth.isSubscription ? { isSubscription: true } : {}),
						...(oauth.loginLabel ? { loginLabel: oauth.loginLabel } : {}),
					},
				}
			: {}),
		...(apiKey ? { keyAuth: { name: apiKey.name, ...(keyPage ? { keyPage } : {}) } } : {}),
	};
	return methods.oauth || methods.keyAuth ? methods : undefined;
}

function providerRows(
	stored: StoredSources,
	origins: ProviderOriginsView,
	env: NodeJS.ProcessEnv,
): ProviderCredentialStatus[] {
	const providers = new Map(builtinProviders().map((provider) => [provider.id, provider]));
	const known = new Map([...providers].map(([id, provider]) => [id, provider.name]));
	const extra = new Set([...stored.byProvider.keys(), ...origins.origins.keys(), ...origins.disabled]);
	const ids = [...known.keys(), ...[...extra].filter((id) => !known.has(id)).sort()];
	return ids.map((provider) => {
		const sources = mergeSources(stored.byProvider.get(provider) ?? [], envSources(provider, env));
		const found = origins.origins.get(provider) ?? [];
		// A models.json entry counts only when it sets a key; a definition alone says nothing about credentials.
		const configured = sources.length > 0 || found.some((origin) => origin.file === "auth-json" || origin.hasKey);
		const name = known.get(provider);
		// The credential endpoint accepts only ids its schema accepts; the page must not offer edits it would refuse.
		const editable = Value.Check(ProviderIdSchema, provider) ? {} : { editable: false };
		const auth = authMethods(providers.get(provider)?.auth);
		return {
			provider,
			...(name ? { name } : {}),
			configured,
			...editable,
			sources,
			...(found.length > 0 ? { origins: found } : {}),
			...(origins.disabled.has(provider) ? { disabled: true } : {}),
			...(auth ? { auth } : {}),
		};
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
	const trusted = options.cwd !== undefined && resolveFolderTrust(options.cwd).state === "trusted";
	const manager = SettingsManager.create(options.cwd ?? options.agentDir, options.agentDir, {
		projectTrusted: trusted,
	});
	const settingsErrors: SettingsFileError[] = manager
		.drainErrors()
		.map(({ scope }) => ({ scope: scope === "project" ? "workspace" : "global", message: SETTINGS_ERROR }));
	const origins = await readProviderOrigins({
		agentDir: options.agentDir,
		piDirs:
			options.piDirs ??
			discoveryInput({ cwd: options.cwd ?? options.agentDir, agentDir: options.agentDir, projectTrusted: false })
				.piRoots,
		...(options.home ? { home: options.home } : {}),
		// Only entries that give a usable credential: signed-out, keyless and unset-reference entries are not an origin.
		octocodeAuthIds: [...stored.byProvider].filter(([, sources]) => sources.length > 0).map(([id]) => id),
		settings: manager,
	});
	const credentialsError = stored.error ?? origins.error;

	return {
		protocolVersion: CONFIG_PROTOCOL_VERSION,
		generatedAt: Date.now(),
		keychainAvailable: keychain !== undefined && keychain !== null,
		providers: providerRows(stored, origins, env),
		sources: origins.sources,
		...(credentialsError ? { credentialsError } : {}),
		settings: settingRows(manager),
		...(settingsErrors.length > 0 ? { settingsErrors } : {}),
		...(options.cwd !== undefined ? { workspace: { repo: repoKey(options.cwd).name, trusted } } : {}),
	};
}
