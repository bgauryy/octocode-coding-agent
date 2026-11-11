/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */

import { execSync, spawn, spawnSync } from "node:child_process";

/** How to start a shell on this host; `getShellConfig` of the coding agent is the usual provider. */
export interface ConfigValueShell {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

let configuredShell: (() => ConfigValueShell) | undefined;

/** Sets how `!command` values find the shell on Windows. Without one they run through the default shell. */
export function setConfigValueShell(provider: (() => ConfigValueShell) | undefined): void {
	configuredShell = provider;
}

// Successful shell command results are cached briefly so rotating tokens (gcloud, keychains) refresh; failures never are.
const COMMAND_RESULT_TTL_MS = 5 * 60_000;
// In its last minute a cached result is still served while the command runs again in the background, so a request
// does not wait for it; a failed refresh keeps the cached result until it expires.
const COMMAND_REFRESH_AHEAD_MS = 60_000;
const COMMAND_TIMEOUT_MS = 10_000;
interface CachedCommandResult {
	value: string;
	expiresAt: number;
	refreshing?: boolean;
}
const commandResultCache = new Map<string, CachedCommandResult>();
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

type ConfigValueReference = { type: "command"; config: string } | { type: "template"; parts: TemplatePart[] };

function appendLiteral(parts: TemplatePart[], value: string): void {
	if (!value) return;
	const previousPart = parts[parts.length - 1];
	if (previousPart?.type === "literal") {
		previousPart.value += value;
		return;
	}
	parts.push({ type: "literal", value });
}

function parseConfigValueTemplate(config: string): TemplatePart[] {
	const parts: TemplatePart[] = [];
	let index = 0;

	while (index < config.length) {
		const dollarIndex = config.indexOf("$", index);
		if (dollarIndex < 0) {
			appendLiteral(parts, config.slice(index));
			break;
		}

		appendLiteral(parts, config.slice(index, dollarIndex));
		const nextChar = config[dollarIndex + 1];

		if (nextChar === "$" || nextChar === "!") {
			appendLiteral(parts, nextChar);
			index = dollarIndex + 2;
			continue;
		}

		if (nextChar === "{") {
			const endIndex = config.indexOf("}", dollarIndex + 2);
			if (endIndex < 0) {
				appendLiteral(parts, "$");
				index = dollarIndex + 1;
				continue;
			}

			const name = config.slice(dollarIndex + 2, endIndex);
			if (ENV_VAR_NAME_RE.test(name)) {
				parts.push({ type: "env", name });
			} else {
				appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
			}
			index = endIndex + 1;
			continue;
		}

		const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
		if (match) {
			parts.push({ type: "env", name: match[0] });
			index = dollarIndex + 1 + match[0].length;
			continue;
		}

		appendLiteral(parts, "$");
		index = dollarIndex + 1;
	}

	return parts;
}

function parseConfigValueReference(config: string): ConfigValueReference {
	if (config.startsWith("!")) {
		return { type: "command", config };
	}

	return { type: "template", parts: parseConfigValueTemplate(config) };
}

function resolveEnvConfigValue(name: string, env?: Record<string, string>): string | undefined {
	return env?.[name] || process.env[name] || undefined;
}

function getTemplateEnvVarNames(parts: TemplatePart[]): string[] {
	const names: string[] = [];
	for (const part of parts) {
		if (part.type !== "env" || names.includes(part.name)) continue;
		names.push(part.name);
	}
	return names;
}

function resolveTemplate(parts: TemplatePart[], env?: Record<string, string>): string | undefined {
	let resolved = "";
	for (const part of parts) {
		if (part.type === "literal") {
			resolved += part.value;
			continue;
		}
		const envValue = resolveEnvConfigValue(part.name, env);
		if (envValue === undefined) return undefined;
		resolved += envValue;
	}
	return resolved;
}

export function getConfigValueEnvVarNames(config: string): string[] {
	const reference = parseConfigValueReference(config);
	return reference.type === "template" ? getTemplateEnvVarNames(reference.parts) : [];
}

function getMissingConfigValueEnvVarNames(config: string, env?: Record<string, string>): string[] {
	return getConfigValueEnvVarNames(config).filter((name) => resolveEnvConfigValue(name, env) === undefined);
}

export function isCommandConfigValue(config: string): boolean {
	return parseConfigValueReference(config).type === "command";
}

export function isConfigValueConfigured(config: string, env?: Record<string, string>): boolean {
	return getMissingConfigValueEnvVarNames(config, env).length === 0;
}

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (successes cached for a few minutes and
 *   refreshed in the background in their last minute, failures never)
 * - Interpolates "$ENV_VAR" or "${ENV_VAR}" references with the named environment variable
 * - In non-command values, "$$" escapes a literal "$" and "$!" escapes a literal "!"
 * - Otherwise treats the value as a literal
 */
export function resolveConfigValue(config: string, env?: Record<string, string>): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommand(reference.config);
	}
	return resolveTemplate(reference.parts, env);
}

function executeWithConfiguredShell(command: string): { executed: boolean; value: string | undefined } {
	try {
		if (!configuredShell) return { executed: false, value: undefined };
		const { shell, args, commandTransport } = configuredShell();
		const commandFromStdin = commandTransport === "stdin";
		const result = spawnSync(shell, commandFromStdin ? args : [...args, command], {
			encoding: "utf-8",
			input: commandFromStdin ? command : undefined,
			timeout: COMMAND_TIMEOUT_MS,
			stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "ignore"],
			shell: false,
			windowsHide: true,
		});

		if (result.error) {
			const error = result.error as NodeJS.ErrnoException;
			if (error.code === "ENOENT") {
				return { executed: false, value: undefined };
			}
			return { executed: true, value: undefined };
		}

		if (result.status !== 0) {
			return { executed: true, value: undefined };
		}

		const value = (result.stdout ?? "").trim();
		return { executed: true, value: value || undefined };
	} catch {
		return { executed: false, value: undefined };
	}
}

function executeWithDefaultShell(command: string): string | undefined {
	try {
		const output = execSync(command, {
			encoding: "utf-8",
			timeout: COMMAND_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output.trim() || undefined;
	} catch {
		return undefined;
	}
}

function executeCommandUncached(commandConfig: string): string | undefined {
	const command = commandConfig.slice(1);
	return process.platform === "win32"
		? (() => {
				const configuredResult = executeWithConfiguredShell(command);
				return configuredResult.executed ? configuredResult.value : executeWithDefaultShell(command);
			})()
		: executeWithDefaultShell(command);
}

/**
 * Run a command without blocking: stdout trimmed when it exits 0, else undefined. `executed` is false when the shell
 * itself could not start. The child does not keep the process alive.
 */
function runCommandInBackground(
	file: string,
	args: string[],
	options: { input?: string; shell: boolean },
): Promise<{ executed: boolean; value: string | undefined }> {
	return new Promise((resolve) => {
		let stdout = "";
		let settled = false;
		const finish = (result: { executed: boolean; value: string | undefined }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const child = spawn(file, args, {
			shell: options.shell,
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
			windowsHide: true,
		});
		const timer = setTimeout(() => {
			child.kill();
			finish({ executed: true, value: undefined });
		}, COMMAND_TIMEOUT_MS);
		timer.unref();
		child.unref();
		(child.stdout as { unref?: () => void } | null)?.unref?.();
		child.stdout?.setEncoding("utf-8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", (error: NodeJS.ErrnoException) =>
			finish({ executed: error.code !== "ENOENT", value: undefined }),
		);
		child.on("close", (status) =>
			finish({ executed: true, value: status === 0 ? stdout.trim() || undefined : undefined }),
		);
		if (options.input !== undefined) child.stdin?.end(options.input);
	});
}

/** `executeCommandUncached` without blocking the thread. */
async function executeCommandInBackground(commandConfig: string): Promise<string | undefined> {
	const command = commandConfig.slice(1);
	if (process.platform === "win32" && configuredShell) {
		try {
			const { shell, args, commandTransport } = configuredShell();
			const fromStdin = commandTransport === "stdin";
			const result = await runCommandInBackground(shell, fromStdin ? args : [...args, command], {
				shell: false,
				...(fromStdin ? { input: command } : {}),
			});
			if (result.executed) return result.value;
		} catch {
			// Falls back to the default shell, as the synchronous path does.
		}
	}
	return (await runCommandInBackground(command, [], { shell: true })).value;
}

function refreshCommandResult(commandConfig: string, entry: CachedCommandResult): void {
	if (entry.refreshing) return;
	entry.refreshing = true;
	void executeCommandInBackground(commandConfig).then(
		(value) => {
			// Cleared or replaced meanwhile; a failure leaves the cached result to expire.
			if (value === undefined || commandResultCache.get(commandConfig) !== entry) return;
			commandResultCache.set(commandConfig, { value, expiresAt: Date.now() + COMMAND_RESULT_TTL_MS });
		},
		() => undefined,
	);
}

function executeCommand(commandConfig: string): string | undefined {
	const cached = commandResultCache.get(commandConfig);
	const now = Date.now();
	if (cached && cached.expiresAt > now) {
		if (cached.expiresAt - now <= COMMAND_REFRESH_AHEAD_MS) refreshCommandResult(commandConfig, cached);
		return cached.value;
	}
	commandResultCache.delete(commandConfig);

	const result = executeCommandUncached(commandConfig);
	if (result !== undefined) {
		commandResultCache.set(commandConfig, { value: result, expiresAt: Date.now() + COMMAND_RESULT_TTL_MS });
	}
	return result;
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveConfigValueUncached(config: string, env?: Record<string, string>): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommandUncached(reference.config);
	}
	return resolveTemplate(reference.parts, env);
}

export function resolveConfigValueOrThrow(config: string, description: string, env?: Record<string, string>): string {
	const resolvedValue = resolveConfigValueUncached(config, env);
	if (resolvedValue !== undefined) {
		return resolvedValue;
	}

	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		throw new Error(`Failed to resolve ${description} from shell command: ${reference.config.slice(1)}`);
	}

	if (reference.type === "template") {
		const missingEnvVars = getMissingConfigValueEnvVarNames(config, env);
		if (missingEnvVars.length === 1) {
			throw new Error(`Failed to resolve ${description} from environment variable: ${missingEnvVars[0]}`);
		}
		if (missingEnvVars.length > 1) {
			throw new Error(`Failed to resolve ${description} from environment variables: ${missingEnvVars.join(", ")}`);
		}
	}

	throw new Error(`Failed to resolve ${description}`);
}

export function resolveHeadersOrThrow(
	headers: Record<string, string> | undefined,
	description: string,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`, env);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Clear the config value command cache. Exported for testing. */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
}
