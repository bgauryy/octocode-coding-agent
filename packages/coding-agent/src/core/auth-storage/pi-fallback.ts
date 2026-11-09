import { join } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@octocodeai/octocode-ai";
import type { AuthStorage, HeldCredential } from "../auth-storage.ts";
import { isCommandConfigValue, resolveConfigValue } from "../config-value.ts";
import { providerSourceGate } from "../provider-sources/gate.ts";
import { ReadOnlyAuthStorage } from "./read-only.ts";

/**
 * Octocode's credential store with Pi's `auth.json` files as a read-only fallback. A provider with an Octocode
 * credential never sees Pi's; every write (login, refresh, logout) goes to Octocode's store, so a refreshed Pi OAuth
 * token is saved in Octocode's file and Pi's files are never changed. A Pi key held in a secret command (`!cmd`) is not
 * used: its command runs only after the user configures the provider in Octocode. While the `pi` provider source is
 * off, Pi's files are not read at all.
 */
export class PiFallbackCredentialStore implements CredentialStore {
	private readonly primary: AuthStorage;
	private readonly piAuthPaths: readonly string[];

	private readonly isEnabled: () => boolean;

	constructor(
		primary: AuthStorage,
		piDirs: readonly string[],
		isEnabled: () => boolean = () => providerSourceGate.isEnabled("pi"),
	) {
		this.isEnabled = isEnabled;
		this.primary = primary;
		this.piAuthPaths = piDirs.map((dir) => join(dir, "auth.json"));
	}

	/** Octocode's file only; Pi's files are read fresh on every read. */
	watch(onChange: () => void): () => void {
		return this.primary.watch(onChange);
	}

	/** The first Pi entry for the provider, unresolved; read fresh so edits to Pi's file apply. */
	private async readPi(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		if (!this.isEnabled()) return undefined;
		for (const path of this.piAuthPaths) {
			const credential = await new ReadOnlyAuthStorage(path).readRaw(providerId, options);
			if (!credential) continue;
			if (credential.type === "api_key" && credential.key && isCommandConfigValue(credential.key)) return undefined;
			return credential;
		}
		return undefined;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		const own = await this.primary.read(providerId, options);
		if (own) return own;
		const pi = await this.readPi(providerId, options);
		if (pi?.type !== "api_key" || !pi.key) return pi;
		return { ...pi, key: resolveConfigValue(pi.key, pi.env) };
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = new Map((await this.primary.list(options)).map((entry) => [entry.providerId, entry]));
		for (const path of this.isEnabled() ? this.piAuthPaths : []) {
			for (const entry of await new ReadOnlyAuthStorage(path).list(options)) {
				if (entries.has(entry.providerId)) continue;
				if (await this.readPi(entry.providerId, options)) entries.set(entry.providerId, entry);
			}
		}
		return [...entries.values()];
	}

	/** Writes Octocode's store; when it holds nothing yet, `fn` sees Pi's credential (an OAuth refresh starts from it). */
	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.primary.modify(providerId, this.seeded(providerId, fn, options), options);
	}

	/** `AuthStorage`'s lock-held compensation hook, kept so keychain write transforms stay safe through this wrapper. */
	modifyGuarded(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options: AuthOperationOptions | undefined,
		onFailure: (held: HeldCredential) => Promise<void>,
	): Promise<Credential | undefined> {
		return this.primary.modifyGuarded(providerId, this.seeded(providerId, fn, options), options, onFailure);
	}

	private seeded(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options: AuthOperationOptions | undefined,
	) {
		return async (current: Credential | undefined) => fn(current ?? (await this.readPi(providerId, options)));
	}

	/** Removes Octocode's credential only; a Pi credential stays in Pi's file and remains the fallback. */
	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.primary.delete(providerId, options);
	}
}
