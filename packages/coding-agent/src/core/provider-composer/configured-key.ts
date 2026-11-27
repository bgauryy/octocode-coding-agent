/**
 * Where a provider's own configuration takes its key from: an extension's `apiKey`, then models.json `auth` (a key
 * command), `env` (variable names), `apiKey` (Pi's literal, `$VAR`, `!command`, or `keychain:<name>`).
 */

import type { AuthContext } from "@octocodeai/octocode-ai";
import {
	type CredentialCommand,
	forgetCredentialCommand,
	runCredentialCommand,
} from "@octocodeai/octocode-ai/utils/resolve-config-value";
import { keychainReadCommand } from "../auth-storage/keychain.ts";
import type { ModelsJsonProvider } from "../model-config.ts";
import { getConfigValueEnvVarNames, isCommandConfigValue, isConfigValueConfigured } from "../config-value.ts";
import type { AuthStatus, ProviderConfigInput } from "./types.ts";

const KEYCHAIN_PREFIX = "keychain:";

export type ConfiguredKey =
	| { kind: "command"; spec: CredentialCommand }
	| { kind: "keychain"; name: string }
	| { kind: "env"; names: readonly string[]; fallback?: string }
	/** Pi's `apiKey` forms, resolved by `resolveConfigValue`. */
	| { kind: "value"; raw: string; fromFeature: boolean };

function apiKeyValue(raw: string, fromFeature: boolean): ConfiguredKey {
	return raw.startsWith(KEYCHAIN_PREFIX)
		? { kind: "keychain", name: raw.slice(KEYCHAIN_PREFIX.length) }
		: { kind: "value", raw, fromFeature };
}

export function configuredKey(
	config: ModelsJsonProvider | undefined,
	feature: ProviderConfigInput | undefined,
): ConfiguredKey | undefined {
	if (feature?.apiKey !== undefined) return apiKeyValue(feature.apiKey, true);
	if (config?.auth) return { kind: "command", spec: config.auth };
	if (config?.env) return { kind: "env", names: config.env, fallback: config.apiKey };
	return config?.apiKey === undefined ? undefined : apiKeyValue(config.apiKey, false);
}

/** How the key is configured, from the settings alone: nothing runs and no value is read. */
export function configuredKeyStatus(key: ConfiguredKey | undefined): AuthStatus | undefined {
	if (!key) return undefined;
	switch (key.kind) {
		case "command":
			return { configured: true, source: "models_json_command" };
		case "keychain":
			return { configured: true, source: "models_json_command", label: `keychain entry ${key.name}` };
		case "env": {
			const set = key.names.find((name) => process.env[name]);
			if (set) return { configured: true, source: "environment", label: set };
			return key.fallback === undefined ? { configured: false } : configuredKeyStatus(apiKeyValue(key.fallback, false));
		}
		case "value": {
			if (isCommandConfigValue(key.raw)) return { configured: true, source: "models_json_command" };
			const names = getConfigValueEnvVarNames(key.raw);
			if (names.length > 0) {
				return isConfigValueConfigured(key.raw)
					? { configured: true, source: "environment", label: names.join(", ") }
					: { configured: false, source: "environment", label: names.join(", ") };
			}
			return { configured: true, source: key.fromFeature ? "fallback" : "models_json_key" };
		}
	}
}

/** The first of `names` the context sets, with its value. */
async function firstSetEnv(
	names: readonly string[],
	ctx: AuthContext,
): Promise<{ name: string; value: string } | undefined> {
	for (const name of names) {
		const value = await ctx.env(name);
		if (value) return { name, value };
	}
	return undefined;
}

/**
 * The `auth`, `keychain:` or `env` key with what it came from; `renew` drops a command's cached key. Pi's `apiKey` forms
 * come back as `{ value }` for `resolveConfigValue`. Throws when no listed variable is set and there is no `apiKey`.
 */
export async function resolveConfiguredKey(
	key: ConfiguredKey,
	ctx: AuthContext,
	signal: AbortSignal,
): Promise<{ key: string; source?: string; renew?: () => void } | { value: string }> {
	switch (key.kind) {
		case "command":
		case "keychain": {
			const spec = key.kind === "command" ? key.spec : keychainReadCommand(key.name);
			return { key: await runCredentialCommand(spec, signal), renew: () => forgetCredentialCommand(spec) };
		}
		case "env": {
			const found = await firstSetEnv(key.names, ctx);
			if (found) return { key: found.value, source: found.name };
			if (key.fallback === undefined) throw new Error(`None of ${key.names.join(", ")} is set`);
			return resolveConfiguredKey(apiKeyValue(key.fallback, false), ctx, signal);
		}
		case "value":
			return { value: key.raw };
	}
}

/** Whether `check` can report the key without running anything: env names are looked up, programs are trusted to run. */
export async function configuredKeyAvailable(key: ConfiguredKey, ctx: AuthContext): Promise<boolean> {
	switch (key.kind) {
		case "command":
		case "keychain":
			return true;
		case "env":
			if (await firstSetEnv(key.names, ctx)) return true;
			return key.fallback === undefined ? false : configuredKeyAvailable(apiKeyValue(key.fallback, false), ctx);
		case "value":
			if (isCommandConfigValue(key.raw)) return true;
			for (const name of getConfigValueEnvVarNames(key.raw)) {
				if ((await ctx.env(name)) === undefined) return false;
			}
			return true;
	}
}
