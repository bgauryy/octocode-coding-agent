import { homedir } from "node:os";
import { join } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@octocodeai/octocode-ai";
import type { AuthStorage, HeldCredential } from "../auth-storage.ts";
import { isCommandConfigValue, resolveConfigValue } from "../config-value.ts";
import { providerSourceGate } from "../provider-sources/gate.ts";
import { ReadOnlyAuthStorage } from "./read-only.ts";

interface FallbackCredentialOptions {
	/**
	 * Whether the user's own configuration gives this provider a key (`apiKey` in Octocode's models.json). Such a
	 * provider never uses a fallback file: Octocode's own files win over Pi's.
	 */
	ownsKey?: (providerId: string) => boolean | Promise<boolean>;
	/** Whether Octocode can use an OAuth sign-in for this provider. A fallback OAuth entry it cannot use is skipped. */
	supportsOAuth?: (providerId: string) => boolean;
}

/**
 * Octocode's credential store with Pi's `auth.json` files as a read-only fallback. A provider with an Octocode
 * credential, or with an `apiKey` in Octocode's own models.json, never sees Pi's; every write (login, refresh, logout)
 * goes to Octocode's store, so a refreshed Pi OAuth token is saved in Octocode's file and Pi's files are never changed.
 * A Pi key held in a secret command (`!cmd`) is not used (a later file's entry is): its command runs only after the
 * user configures the provider in Octocode. A fallback file that cannot be read, or an entry Octocode does not
 * recognize, is skipped with a warning naming the file. While the `pi` provider source is off, Pi's files are not read.
 */
export class PiFallbackCredentialStore implements CredentialStore {
	private readonly primary: AuthStorage | ReadOnlyAuthStorage;
	private readonly piAuthPaths: readonly string[];
	private readonly options: FallbackCredentialOptions;
	/** The fallback file each provider's credential was last read from; a provider served by Octocode's file has none. */
	private readonly origins = new Map<string, string>();

	constructor(
		primary: AuthStorage | ReadOnlyAuthStorage,
		piDirs: readonly string[],
		options: FallbackCredentialOptions = {},
	) {
		this.primary = primary;
		this.piAuthPaths = piDirs.map((dir) => join(dir, "auth.json"));
		this.options = options;
	}

	private isEnabled(): boolean {
		return providerSourceGate.isEnabled("pi");
	}

	/**
	 * A fallback file read leniently: a bad entry or file is skipped. The user sees why at startup
	 * (`checkAuthFileSafety`), so the problem needs no second report here.
	 */
	private file(path: string): ReadOnlyAuthStorage {
		return new ReadOnlyAuthStorage(path, { onProblem: () => {} });
	}

	/** Octocode's file only; Pi's files are read fresh on every read. */
	watch(onChange: () => void): () => void {
		return "watch" in this.primary ? this.primary.watch(onChange) : () => {};
	}

	/** The file (home shown as `~`) that last supplied the provider's credential when it is a fallback file. */
	credentialOrigin(providerId: string): string | undefined {
		const path = this.origins.get(providerId);
		const home = homedir();
		return path?.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
	}

	/** Where Octocode's own `auth.json` keeps the provider's secret; undefined when it has no entry there. */
	storedIn(providerId: string): "keychain" | "auth.json" | undefined {
		return "storedIn" in this.primary ? this.primary.storedIn(providerId) : undefined;
	}

	/** The first usable fallback entry for the provider, unresolved; read fresh so edits to Pi's file apply. */
	private async readPi(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		const found = await this.findPi(providerId, options);
		if (found) this.origins.set(providerId, found.path);
		else this.origins.delete(providerId);
		return found?.credential;
	}

	private async findPi(
		providerId: string,
		options?: AuthOperationOptions,
	): Promise<{ credential: Credential; path: string } | undefined> {
		if (!this.isEnabled()) return undefined;
		if (await this.options.ownsKey?.(providerId)) return undefined;
		for (const path of this.piAuthPaths) {
			const credential = await this.file(path).readRaw(providerId, options);
			if (!credential) continue;
			if (credential.type === "api_key" && credential.key && isCommandConfigValue(credential.key)) continue;
			if (credential.type === "oauth" && this.options.supportsOAuth?.(providerId) === false) continue;
			return { credential, path };
		}
		return undefined;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		const own = await this.primary.read(providerId, options);
		if (own) {
			this.origins.delete(providerId);
			return own;
		}
		const pi = await this.readPi(providerId, options);
		if (pi?.type !== "api_key" || !pi.key) return pi;
		return { ...pi, key: resolveConfigValue(pi.key, pi.env) };
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = new Map((await this.primary.list(options)).map((entry) => [entry.providerId, entry]));
		for (const providerId of entries.keys()) this.origins.delete(providerId);
		for (const path of this.isEnabled() ? this.piAuthPaths : []) {
			for (const entry of await this.file(path).list(options)) {
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
		const seeded = this.seeded(providerId, fn, options);
		return "modifyGuarded" in this.primary
			? this.primary.modifyGuarded(providerId, seeded, options, onFailure)
			: this.primary.modify(providerId, seeded, options);
	}

	private seeded(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options: AuthOperationOptions | undefined,
	) {
		return async (current: Credential | undefined) => fn(current ?? (await this.readPi(providerId, options)));
	}

	/**
	 * Removes Octocode's credential. When Pi's file still holds a usable one, Octocode's store keeps a signed-out
	 * marker (an empty OAuth record with `signedOut`) so the provider stays unconfigured here; Pi's files are never
	 * changed. A later login or saved key replaces the marker.
	 */
	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		await this.primary.delete(providerId, options);
		if (!(await this.readPi(providerId, options))) return;
		await this.primary.modify(
			providerId,
			async (current) => current ?? { type: "oauth", access: "", refresh: "", expires: 0, signedOut: true },
			options,
		);
	}
}
