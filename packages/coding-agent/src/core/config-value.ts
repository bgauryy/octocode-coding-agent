/**
 * The host's entry to `@octocodeai/octocode-ai/utils/resolve-config-value`: binds `!command` config values to the shell
 * the bash tool uses (it matters on Windows) before any caller can resolve one. Coding-agent code imports the
 * resolver from here, so every path that runs a command, including standalone SDK and web-daemon reads, gets that shell.
 * Every value it resolves is a credential (an API key or a credential header), so it is also registered for redaction.
 */
import {
	resolveConfigValue as resolveConfigValueBase,
	resolveConfigValueAsync as resolveConfigValueAsyncBase,
	resolveConfigValueOrThrow as resolveConfigValueOrThrowBase,
	resolveHeadersOrThrow as resolveHeadersOrThrowBase,
	setConfigValueShell,
} from "@octocodeai/octocode-ai/utils/resolve-config-value";
import { getShellConfig } from "../utils/shell.ts";
import { registerNamedSecrets, registerResolvedSecret } from "./secret-redaction.ts";

setConfigValueShell(() => getShellConfig());

export * from "@octocodeai/octocode-ai/utils/resolve-config-value";

export function resolveConfigValue(config: string, env?: Record<string, string>): string | undefined {
	const value = resolveConfigValueBase(config, env);
	registerResolvedSecret(value);
	return value;
}

/** `resolveConfigValue` that does not block the thread while a `!command` runs. */
export async function resolveConfigValueAsync(
	config: string,
	env?: Record<string, string>,
): Promise<string | undefined> {
	const value = await resolveConfigValueAsyncBase(config, env);
	registerResolvedSecret(value);
	return value;
}

export function resolveConfigValueOrThrow(config: string, description: string, env?: Record<string, string>): string {
	const value = resolveConfigValueOrThrowBase(config, description, env);
	registerResolvedSecret(value);
	return value;
}

/** A header resolved from a `!command` or `$VAR` reference is a secret whatever its name; a literal one only when its name says so. */
export function resolveHeadersOrThrow(
	headers: Record<string, string> | undefined,
	description: string,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	const resolved = resolveHeadersOrThrowBase(headers, description, env);
	for (const [name, value] of Object.entries(resolved ?? {})) {
		const raw = headers?.[name] ?? "";
		if (raw.startsWith("!") || raw.includes("$")) registerResolvedSecret(value);
		else registerNamedSecrets({ [name]: value });
	}
	return resolved;
}
