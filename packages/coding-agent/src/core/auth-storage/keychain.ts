/**
 * OS keychain storage for API keys. The secret lives in the keychain; auth.json keeps only a `!command` reference
 * that `resolveConfigValue` runs to read it back, so the credential format does not change.
 *
 * Writes never use a shell and never put the secret in argv: macOS reads commands from `security -i` on stdin and
 * Linux passes the secret to `secret-tool store` on stdin.
 */

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { clearConfigValueCache } from "../config-value.ts";

/** Keychain service name shared by every entry; the account is the provider id. */
const SERVICE = "octocode";
const MACOS_SECURITY = "/usr/bin/security";
const SECRET_TOOL = "secret-tool";
const MACOS_ITEM_NOT_FOUND = 44;
const COMMAND_TIMEOUT_MS = 15_000;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface KeychainRunResult {
	code: number | null;
	stderr: string;
}

/** Runs `file` with `args` (no shell) and optional stdin. Rejects only when the process cannot start. */
export type KeychainRunner = (file: string, args: readonly string[], input?: string) => Promise<KeychainRunResult>;

/** Resolves a command name or absolute path to an executable path, or undefined when it is unavailable. */
export type KeychainWhich = (command: string) => string | undefined;

export interface KeychainBackend {
	readonly name: string;
	/** Stores `secret` for `provider`, replacing any earlier entry. Rejects with a message that never contains the secret. */
	store(provider: string, secret: string): Promise<void>;
	/** Removes the entry for `provider`; a missing entry is not an error. */
	remove(provider: string): Promise<void>;
	/** The `!command` auth.json key that reads the entry back. */
	referenceFor(provider: string): string;
	/** True when `key` is exactly this backend's reference for `provider`. */
	isOwnReference(key: string | undefined, provider: string): boolean;
}

export function isValidKeychainProviderId(provider: string): boolean {
	return PROVIDER_ID.test(provider);
}

function assertProvider(provider: string): void {
	if (!isValidKeychainProviderId(provider))
		throw new Error(`Invalid provider id for keychain storage: ${JSON.stringify(provider)}`);
}

function assertSecret(secret: string): void {
	if (secret.length === 0) throw new Error("Cannot store an empty key in the keychain.");
	if (CONTROL_CHARACTERS.test(secret)) throw new Error("Cannot store a key with control characters in the keychain.");
}

/** A keychain command ran and failed. `code` is null when it was killed (a timeout): then it may have taken effect. */
export class KeychainCommandError extends Error {
	readonly code: number | null;
	constructor(message: string, code: number | null) {
		super(message);
		this.name = "KeychainCommandError";
		this.code = code;
	}
}

function failure(action: string, backend: string, result: KeychainRunResult): Error {
	const detail = result.stderr.trim();
	return new KeychainCommandError(
		`${backend} could not ${action} (exit code ${result.code ?? "none"})${detail ? `: ${detail}` : ""}`,
		result.code,
	);
}

interface BackendSpec {
	name: string;
	file: string;
	store(provider: string, secret: string): { args: string[]; input: string };
	remove(provider: string): string[];
	reference(provider: string): string;
	isNotFound(result: KeychainRunResult): boolean;
}

function macSpec(file: string): BackendSpec {
	return {
		name: "macOS Keychain",
		file,
		store: (provider, secret) => ({
			args: ["-i"],
			input: `add-generic-password -U -s ${SERVICE} -a ${provider} -w "${secret.replace(/[\\"]/g, "\\$&")}"\n`,
		}),
		remove: (provider) => ["delete-generic-password", "-s", SERVICE, "-a", provider],
		reference: (provider) => `!${file} find-generic-password -s ${SERVICE} -a ${provider} -w`,
		isNotFound: (result) => result.code === MACOS_ITEM_NOT_FOUND,
	};
}

function linuxSpec(): BackendSpec {
	return {
		name: "Secret Service",
		file: SECRET_TOOL,
		store: (provider, secret) => ({
			args: ["store", `--label=${SERVICE} ${provider}`, "service", SERVICE, "account", provider],
			input: secret,
		}),
		remove: (provider) => ["clear", "service", SERVICE, "account", provider],
		reference: (provider) => `!${SECRET_TOOL} lookup service ${SERVICE} account ${provider}`,
		isNotFound: (result) => result.code === 1 && result.stderr.trim() === "",
	};
}

function createBackend(spec: BackendSpec, run: KeychainRunner): KeychainBackend {
	return {
		name: spec.name,
		async store(provider, secret) {
			assertProvider(provider);
			assertSecret(secret);
			const { args, input } = spec.store(provider, secret);
			const result = await run(spec.file, args, input);
			clearConfigValueCache();
			// Secret-write output can echo escaped or partial input, which exact token replacement cannot redact safely.
			if (result.code !== 0) throw failure("store the key", spec.name, { ...result, stderr: "" });
		},
		async remove(provider) {
			assertProvider(provider);
			const result = await run(spec.file, spec.remove(provider));
			clearConfigValueCache();
			if (result.code !== 0 && !spec.isNotFound(result)) throw failure("remove the key", spec.name, result);
		},
		referenceFor(provider) {
			assertProvider(provider);
			return spec.reference(provider);
		},
		isOwnReference(key, provider) {
			return key !== undefined && isValidKeychainProviderId(provider) && key === spec.reference(provider);
		},
	};
}

/** Default command lookup: an absolute path must be executable; a bare name is searched on PATH. */
function whichCommand(command: string): string | undefined {
	const candidates = isAbsolute(command)
		? [command]
		: (process.env.PATH ?? "")
				.split(delimiter)
				.filter(Boolean)
				.map((dir) => join(dir, command));
	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Try the next PATH entry.
		}
	}
	return undefined;
}

/** Default runner: spawns without a shell, writes `input` to stdin and keeps only stderr. */
const runKeychainCommand: KeychainRunner = (file, args, input) =>
	new Promise((resolve, reject) => {
		const child = spawn(file, [...args], { stdio: ["pipe", "ignore", "pipe"], timeout: COMMAND_TIMEOUT_MS });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 4096) stderr += chunk.toString();
		});
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stderr }));
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});

/** The keychain for `platform`, or undefined when there is none (Windows, other platforms or a missing tool). */
export function detectKeychain(
	platform: NodeJS.Platform,
	which: KeychainWhich = whichCommand,
	run: KeychainRunner = runKeychainCommand,
): KeychainBackend | undefined {
	if (platform === "darwin") {
		const security = which(MACOS_SECURITY);
		return security ? createBackend(macSpec(MACOS_SECURITY), run) : undefined;
	}
	if (platform === "linux") {
		return which(SECRET_TOOL) ? createBackend(linuxSpec(), run) : undefined;
	}
	return undefined;
}
