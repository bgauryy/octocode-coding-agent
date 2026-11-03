/**
 * The credential write path of the configuration page. Keychain first: with an OS keychain the key is stored there and
 * `auth.json` receives only the keychain's reference; if `auth.json` then cannot be written the keychain is put back
 * as it was (`RuntimeCredentials` rolls the external write back while it still holds the `auth.json` lock). Without a
 * keychain the key would be plain text, so it is stored only when the request acknowledges that, and an existing
 * `auth.json` that other users can read is made owner-only first. Every refusal message is fixed text: nothing here
 * quotes the key, a `!` reference or a parser message, and the audit entry carries kinds and codes only.
 */

import fs from "node:fs";
import { join } from "node:path";
import type { Credential } from "@octocodeai/octocode-ai";
import type { ConfigCredentialCommand } from "@octocodeai/octocode-contracts/config";
import { AuthStorage, KeychainReleaseError } from "../../core/auth-storage.ts";
import { detectKeychain, type KeychainBackend } from "../../core/auth-storage/keychain.ts";
import { KeychainSaveError, KeychainWrite } from "../../core/auth-storage/keychain-login.ts";
import { ReadOnlyAuthStorage } from "../../core/auth-storage/read-only.ts";
import { CredentialWriteFailure, RuntimeCredentials } from "../../core/runtime-credentials.ts";
import type { ConfigAuditEntry } from "../../../../db/src/api.ts";
import { classify, referenceMatchers } from "./config-status.ts";
import { ConfigWriteError } from "./config-write.ts";

export interface CredentialWriteOptions {
	agentDir: string;
	/** The keychain to use; default: this platform's. `null`: none (the plaintext rule applies). */
	keychain?: KeychainBackend | null;
	env?: NodeJS.ProcessEnv;
	/** Who is acting, for the audit entry, such as `web:<daemon instance>`. */
	actor: string;
	/** Receives one entry per attempt, accepted or refused. It must not throw; the write does not depend on it. */
	audit?: (entry: ConfigAuditEntry) => void;
}

/** The `ConfigRoutes.auditRefused` callback: one `credential.refused` row with a fixed code, no target and no body. */
export function refusalAuditor(
	actor: string,
	audit: (entry: ConfigAuditEntry) => void,
): (code: "invalid" | "forbidden") => void {
	return (code) => {
		try {
			audit({
				at: Date.now(),
				actor,
				action: "credential.refused",
				target: "",
				scope: "global",
				outcome: "refused",
				errorCode: code,
			});
		} catch {
			// Best effort, like every audit row.
		}
	};
}

const PLAINTEXT_NOTICE =
	"This computer has no OS keychain, so the key would be saved as plain text in auth.json, and auth.json is made readable by you only. Confirm to save it anyway.";

const OAUTH_NOTICE = "This provider is signed in with OAuth. Clear it first to use an API key.";

/** An existing `auth.json` that group or others can read is restricted to its owner before plain text goes into it. */
function restrictAuthFile(path: string): void {
	if (process.platform === "win32") return;
	let mode: number;
	try {
		mode = fs.statSync(path).mode;
	} catch {
		return; // Not there yet: it is created owner-only.
	}
	if ((mode & 0o077) === 0) return;
	try {
		fs.chmodSync(path, 0o600);
	} catch {
		throw new ConfigWriteError(
			500,
			"auth.json can be read by other users and its permissions could not be restricted, so the key was not saved.",
			"permissions",
		);
	}
}

/** What the caller may truthfully say about a failed write, from what `RuntimeCredentials` found under the lock. */
function setFailure(error: unknown): ConfigWriteError {
	if (error instanceof ConfigWriteError) return error;
	const failure = error instanceof CredentialWriteFailure ? error : undefined;
	if (failure?.outcome === "saved")
		return new ConfigWriteError(
			500,
			"The key was saved, but the write could not be confirmed. Reload the page to check.",
			"unconfirmed",
		);
	if (failure?.outcome === "unknown")
		return new ConfigWriteError(
			500,
			"The key may or may not have changed: the earlier state could not be checked or restored. Check the provider's key before trying again.",
			"unknown",
		);
	if ((failure?.cause ?? error) instanceof KeychainSaveError)
		return new ConfigWriteError(502, "Could not save to the system keychain. Nothing was changed.", "keychain");
	return new ConfigWriteError(500, "The key could not be saved. Nothing was changed.", "write");
}

/** The kind of source `auth.json` holds for `provider` now: `none` when it has no entry. Reads the shape only. */
async function currentKind(options: CredentialWriteOptions, keychain: KeychainBackend | undefined, provider: string) {
	let entry: Credential | undefined;
	try {
		entry = await new ReadOnlyAuthStorage(join(options.agentDir, "auth.json")).readRaw(provider);
	} catch {
		throw new ConfigWriteError(
			409,
			"auth.json could not be read, so it was not changed. Fix it in a terminal first.",
			"invalid-file",
		);
	}
	if (!entry) return "none";
	return classify(provider, entry, referenceMatchers(keychain), options.env ?? process.env)[0]?.kind ?? "env";
}

async function setKey(
	command: Extract<ConfigCredentialCommand, { action: "set" }>,
	openStorage: () => AuthStorage,
	authPath: string,
	keychain: KeychainBackend | undefined,
	before: string,
): Promise<void> {
	const secret = command.key.trim();
	if (!secret) throw new ConfigWriteError(400, "Enter a key.", "invalid");
	if (before === "oauth") throw new ConfigWriteError(409, OAUTH_NOTICE, "oauth");
	if (!keychain && command.acknowledgePlaintext !== true)
		throw new ConfigWriteError(409, PLAINTEXT_NOTICE, "plaintext");
	// Opened only now: creating the storage creates auth.json, which a refused request must not do.
	const storage = openStorage();
	if (!keychain) restrictAuthFile(authPath);
	const credentials = new RuntimeCredentials(storage);
	const next = async (current: Credential | undefined): Promise<Credential> => {
		// Checked under the auth.json lock: a sign-in that finished after the check above is not overwritten.
		if (current?.type === "oauth") throw new ConfigWriteError(409, OAUTH_NOTICE, "oauth");
		return {
			type: "api_key",
			key: secret,
			...(current?.type === "api_key" && current.env ? { env: current.env } : {}),
		};
	};
	// Plain text has nothing outside auth.json to undo; the transform still reports what a failed write left behind.
	const transform = keychain
		? new KeychainWrite(keychain, command.provider).asTransform()
		: Object.assign(async (credential: Credential) => credential, {});
	try {
		await credentials.withWriteTransform(command.provider, transform, () => credentials.modify(command.provider, next));
	} catch (error) {
		throw setFailure(error);
	}
}

/** Removes the credential. A keychain entry that stays is reported, and the `auth.json` entry is kept so a retry works. */
async function clearKey(
	provider: string,
	openStorage: () => AuthStorage,
	options: CredentialWriteOptions,
	keychain: KeychainBackend | undefined,
): Promise<void> {
	try {
		await openStorage().deleteOrKeep(provider);
	} catch (error) {
		if (error instanceof KeychainReleaseError) {
			throw error.restored
				? new ConfigWriteError(
						500,
						"The key could not be removed from the OS keychain, so it was kept. Nothing was changed.",
						"keychain",
					)
				: new ConfigWriteError(
						500,
						"The key was removed from auth.json, but the OS keychain entry could not be removed. Delete the octocode entry for this provider in your keychain app.",
						"keychain-leftover",
					);
		}
		// A failure after the file was replaced (a compromised lock) leaves the entry gone; do not say nothing changed.
		const after = await currentKind(options, keychain, provider).catch(() => undefined);
		throw after === "none"
			? new ConfigWriteError(
					500,
					"The credential was removed, but the write could not be confirmed. Reload the page to check.",
					"unconfirmed",
				)
			: new ConfigWriteError(500, "The credential could not be cleared. Nothing was changed.", "write");
	}
}

/** The newest write per provider; the next one for that provider starts after it settles. */
const writing = new Map<string, Promise<unknown>>();

/**
 * Sets, replaces or clears one provider's stored credential. Resolves once saved; throws `ConfigWriteError` otherwise.
 * Writes for one provider run one after another, keychain calls included: the keychain removal after a Clear or a
 * replacement happens outside the `auth.json` lock, so a concurrent Set must not slip in between.
 */
export async function writeConfigCredential(
	command: ConfigCredentialCommand,
	options: CredentialWriteOptions,
): Promise<void> {
	const earlier = writing.get(command.provider);
	const turn = (earlier ?? Promise.resolve()).catch(() => undefined).then(() => writeCredentialNow(command, options));
	writing.set(command.provider, turn);
	try {
		await turn;
	} finally {
		if (writing.get(command.provider) === turn) writing.delete(command.provider);
	}
}

async function writeCredentialNow(command: ConfigCredentialCommand, options: CredentialWriteOptions): Promise<void> {
	const keychain = options.keychain === undefined ? detectKeychain(process.platform) : (options.keychain ?? undefined);
	const entry: ConfigAuditEntry = {
		at: Date.now(),
		actor: options.actor,
		action: `credential.${command.action}`,
		target: command.provider,
		scope: "global",
		outcome: "failed",
	};
	try {
		const before = await currentKind(options, keychain, command.provider);
		entry.beforeKind = before;
		const openStorage = () =>
			AuthStorage.create(join(options.agentDir, "auth.json"), keychain ? { keychain } : undefined);
		if (command.action === "set") {
			await setKey(command, openStorage, join(options.agentDir, "auth.json"), keychain, before);
			entry.afterKind = keychain ? "keychain" : "auth-json";
		} else {
			// Nothing stored: nothing to clear, and no auth.json is created for it.
			if (before !== "none") {
				await clearKey(command.provider, openStorage, options, keychain);
			}
			entry.afterKind = "none";
		}
		entry.outcome = "ok";
	} catch (error) {
		if (error instanceof ConfigWriteError) {
			entry.outcome = error.status >= 500 ? "failed" : "refused";
			entry.errorCode = error.code;
		} else entry.errorCode = "write";
		throw error;
	} finally {
		try {
			options.audit?.(entry);
		} catch {
			// The audit is best effort: a missing database must not undo or hide a change that was made.
		}
	}
}
