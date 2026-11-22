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
import { usablePiCredential } from "../../core/auth-storage/validation.ts";
import type { Credential, Provider, ProviderAuth } from "@octocodeai/octocode-ai";
import { findEnvKeys } from "@octocodeai/octocode-ai/compat";
import { builtinProviders } from "@octocodeai/octocode-ai/providers/all";
import { Value } from "typebox/value";
import {
	CONFIG_PROTOCOL_VERSION,
	CONFIG_SETTING_KEYS,
	ProviderIdSchema,
	deriveAgentRoute,
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
import { providerFallbackDirs } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { providerTemplateInfos } from "./provider-template-infos.ts";
import { readProviderOrigins, type ProviderOriginsView } from "./provider-origins.ts";
import {
	customEdit,
	effectiveBaseUrl,
	hostQuestion,
	isOwnEndpointStub,
	savedHost,
	type SavedHost,
} from "./provider-hosts.ts";
import { resolveFolderTrust } from "../trust/resolve.ts";
import { repoKey } from "../../utils/git-repository.ts";

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
	// A key saved with a custom host: auth.json keeps a stub that points at the keychain record holding both.
	if (isOwnEndpointStub(provider, credential, matchers)) return [{ kind: "keychain" }];
	const key = credential.key;
	if (!key) return [];
	if (isCommandConfigValue(key)) {
		return [
			{ kind: matchers.some((matcher) => matcher.isOwnReference(key, provider)) ? "keychain" : "custom-command" },
		];
	}
	// "$NAME" is a reference to a variable, not a stored key; it counts only while the variable is set.
	const names = getConfigValueEnvVarNames(key);
	if (names.some((name) => !isSet(name, credential, env))) return [];
	if (names.length === 0) return [{ kind: "auth-json" }];
	return names.map((envVar) => ({ kind: "env", envVar }));
}

interface StoredSources {
	owned: Set<string>;
	byProvider: Map<string, CredentialSourceStatus[]>;
	/** The host saved with each provider's key, when it has one. */
	hosts: Map<string, SavedHost>;
	error?: string;
}

async function readStoredSources(
	agentDir: string,
	matchers: readonly KeychainBackend[],
	env: NodeJS.ProcessEnv,
): Promise<StoredSources> {
	const byProvider = new Map<string, CredentialSourceStatus[]>();
	const hosts = new Map<string, SavedHost>();
	try {
		const store = new ReadOnlyAuthStorage(join(agentDir, "auth.json"));
		const metadata = store.listStored();
		const owned = new Set(metadata.map((entry) => entry.providerId));
		for (const { providerId, signedOut } of metadata) {
			if (signedOut) continue;
			const credential = await store.readRaw(providerId);
			if (!credential) continue;
			byProvider.set(providerId, classify(providerId, credential, matchers, env));
			const host = await savedHost(providerId, credential, matchers);
			if (host) hosts.set(providerId, host);
		}
		return { byProvider, hosts, owned };
	} catch {
		return { byProvider: new Map(), hosts: new Map(), owned: new Set(), error: CREDENTIALS_ERROR };
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
		...(auth.plan
			? {
					plan: {
						billing: auth.plan.billing,
						terms: auth.plan.terms,
						...(auth.plan.disabled ? { disabled: auth.plan.disabled } : {}),
					},
				}
			: {}),
		...(oauth
			? {
					oauth: {
						name: oauth.name,
						...(oauth.isSubscription ? { isSubscription: true } : {}),
						...(oauth.loginLabel ? { loginLabel: oauth.loginLabel } : {}),
					},
				}
			: {}),
		...(apiKey
			? {
					keyAuth: {
						name: apiKey.name,
						...(keyPage ? { keyPage } : {}),
						...(apiKey.host ? { host: hostQuestion(apiKey.host) } : {}),
					},
				}
			: {}),
	};
	return methods.oauth || methods.keyAuth || methods.plan ? methods : undefined;
}

function providerRows(
	providers: ReadonlyMap<string, Provider>,
	stored: StoredSources,
	origins: ProviderOriginsView,
	env: NodeJS.ProcessEnv,
	hiddenModels: Record<string, string[]>,
): ProviderCredentialStatus[] {
	const known = new Map([...providers].map(([id, provider]) => [id, provider.name]));
	const extra = new Set([...stored.byProvider.keys(), ...origins.origins.keys(), ...origins.disabled]);
	const ids = [...known.keys(), ...[...extra].filter((id) => !known.has(id)).sort()];
	return ids.map((provider) => {
		const sources = mergeSources(stored.byProvider.get(provider) ?? [], envSources(provider, env));
		const found = origins.origins.get(provider) ?? [];
		// The first model definition wins as a whole. An own key also takes precedence over Pi's auth.json.
		const model = found.find((origin) => origin.file === "models-json");
		const inheritedAuth = found.some((origin) => origin.product === "pi" && origin.file === "auth-json");
		const configured =
			sources.length > 0 ||
			!!(model?.hasKey && !model.keyUnset) ||
			(inheritedAuth && !(model?.product === "octocode" && model.hasKey));
		const custom = origins.custom.get(provider);
		const name = known.get(provider) ?? custom?.name;
		const models = custom?.models.slice(0, 64) ?? [];
		// The credential endpoint accepts only ids its schema accepts; the page must not offer edits it would refuse.
		const editable = Value.Check(ProviderIdSchema, provider) ? {} : { editable: false };
		const definition = providers.get(provider);
		const auth = authMethods(definition?.auth);
		const baseUrl = effectiveBaseUrl(definition, stored.hosts.get(provider), custom);
		const edit = customEdit(definition, custom);
		const ids = [...new Set([...(definition?.getModels().map((model) => model.id) ?? []), ...models])].slice(0, 1024);
		const hidden = (hiddenModels[provider] ?? []).slice(0, 1024);
		return {
			provider,
			...(name ? { name } : {}),
			...(models.length > 0 ? { models } : {}),
			configured,
			...editable,
			sources,
			...(found.length > 0 ? { origins: found } : {}),
			...(origins.disabled.has(provider) ? { disabled: true } : {}),
			...(auth ? { auth } : {}),
			...(baseUrl ? { baseUrl } : {}),
			...(edit ? { customEdit: edit } : {}),
			...(ids.length > 0 ? { modelChoice: { ids, hidden } } : {}),
			route: deriveAgentRoute({
				subscription:
					auth?.plan?.billing === "plan" ||
					(auth?.oauth?.isSubscription === true && sources.some((source) => source.kind === "oauth")),
			}),
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
	const definitions = new Map(builtinProviders().map((provider) => [provider.id, provider]));
	const origins = await readProviderOrigins({
		acceptPiCredential: (id, credential) =>
			!stored.owned.has(id) &&
			usablePiCredential(credential, definitions.get(id)?.auth.oauth !== undefined || !definitions.has(id), env),
		agentDir: options.agentDir,
		piDirs: options.piDirs ?? providerFallbackDirs(options.agentDir, options.home, env),
		...(options.home ? { home: options.home } : {}),
		// Only entries that give a usable credential: signed-out, keyless and unset-reference entries are not an origin.
		octocodeAuthIds: [...stored.byProvider].filter(([, sources]) => sources.length > 0).map(([id]) => id),
		settings: manager,
		env,
	});
	const credentialsError = stored.error ?? origins.error;

	return {
		protocolVersion: CONFIG_PROTOCOL_VERSION,
		generatedAt: Date.now(),
		keychainAvailable: keychain !== undefined && keychain !== null,
		providers: providerRows(definitions, stored, origins, env, manager.getHiddenModels()),
		providerTemplates: providerTemplateInfos(),
		modelsPath: join(options.agentDir, "models.json"),
		sources: origins.sources,
		...(credentialsError ? { credentialsError } : {}),
		settings: settingRows(manager),
		...(settingsErrors.length > 0 ? { settingsErrors } : {}),
		...(options.cwd !== undefined ? { workspace: { repo: repoKey(options.cwd).name, trusted } } : {}),
	};
}
