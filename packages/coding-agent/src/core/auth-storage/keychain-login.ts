/**
 * One login's keychain choice. It watches the secret prompt, asks where to store the key, and rewrites the
 * credential just before it is saved, so the key never reaches auth.json when the keychain is chosen and works. An
 * OAuth credential passed through `KeychainWrite` goes to the keychain as one blob (`keychain-oauth.ts`).
 */

import type { AuthPrompt, Credential } from "@octocodeai/octocode-ai";
import { clearConfigValueCache, resolveConfigValue } from "../config-value.ts";
import type { CredentialWriteTransform } from "../runtime-credentials.ts";
import { KeychainCommandError, type KeychainBackend, KeychainSecretTooLargeError } from "./keychain.ts";
import { oauthAccount, oauthBlob, oauthReference, oauthStub } from "./keychain-oauth.ts";

export type KeychainChoice = "keychain" | "file";

/** The keychain refused the key. The text is fixed: it never carries the key or the tool's output. */
export class KeychainSaveError extends Error {
	constructor() {
		super("Could not save to the system keychain. No plaintext fallback was written.");
		this.name = "KeychainSaveError";
	}
}

/**
 * One keychain-first save of an API key or OAuth credential: stores the key (or the OAuth blob) in the keychain and
 * swaps it for the keychain's `!` reference (or an OAuth stub that holds it) before auth.json is written. When auth.json is then not written, `rollback` puts the keychain back as it was: the
 * entry is removed when there was none, and the earlier key is restored when auth.json already referenced one (the
 * earlier key is read before it is replaced). The attempt counts from before the keychain call starts, so a call that
 * timed out after writing is still undone. When the earlier key could not be read it cannot be put back: `rollback`
 * then throws and the caller must report that the keychain may have changed.
 */
export class KeychainWrite {
	private readonly keychain: KeychainBackend;
	private readonly provider: string;
	/** The keychain account the last `save` wrote: the provider's, or its OAuth account. */
	private account: string;
	private attempted = false;
	private hadEntry = false;
	private earlierSecret: string | undefined;

	constructor(keychain: KeychainBackend, provider: string) {
		this.keychain = keychain;
		this.provider = provider;
		this.account = provider;
	}

	async save(credential: Credential, previous?: Credential): Promise<Credential> {
		if (credential.type === "oauth") {
			if (credential.signedOut || oauthReference(credential)) return credential;
			this.account = oauthAccount(this.provider);
			const earlier = oauthReference(previous);
			this.hadEntry = !!earlier && this.keychain.isOwnReference(earlier, this.account);
			this.earlierSecret = this.hadEntry && earlier ? resolveConfigValue(earlier) : undefined;
			try {
				await this.store(oauthBlob(credential));
			} catch (error) {
				// A sign-in too large for the keychain's write channel stays in auth.json (owner-only), as without a keychain.
				if (error instanceof KeychainSecretTooLargeError) return credential;
				throw error;
			}
			return oauthStub(credential, this.keychain.referenceFor(this.account));
		}
		if (credential.type !== "api_key" || credential.key === undefined) return credential;
		this.account = this.provider;
		const earlierKey = previous?.type === "api_key" ? previous.key : undefined;
		this.hadEntry = !!earlierKey && this.keychain.isOwnReference(earlierKey, this.provider);
		this.earlierSecret =
			this.hadEntry && earlierKey && previous?.type === "api_key"
				? resolveConfigValue(earlierKey, previous.env)
				: undefined;
		await this.store(credential.key);
		return { ...credential, key: this.keychain.referenceFor(this.provider) };
	}

	/** Writes `secret` to the keychain account of this save. */
	private async store(secret: string): Promise<void> {
		// Before awaiting: a store that times out may still have written the entry.
		this.attempted = true;
		try {
			await this.keychain.store(this.account, secret);
		} catch (error) {
			// A secret the channel cannot take was refused before anything ran: nothing to undo, and the caller decides.
			if (error instanceof KeychainSecretTooLargeError) {
				this.attempted = false;
				throw error;
			}
			// A command that ran and exited non-zero stored nothing: there is nothing to undo, and an undo would only
			// fail the same way on a locked keychain. A kill (code null) or any other failure may have written.
			if (error instanceof KeychainCommandError && error.code !== null) this.attempted = false;
			throw new KeychainSaveError();
		}
		clearConfigValueCache();
	}

	/** Undoes `save` once; does nothing when `save` never reached the keychain. */
	readonly rollback = async (): Promise<void> => {
		if (!this.attempted) return;
		this.attempted = false;
		if (!this.hadEntry) await this.keychain.remove(this.account);
		else if (this.earlierSecret !== undefined) await this.keychain.store(this.account, this.earlierSecret);
		else throw new Error("The earlier key could not be read, so it cannot be restored.");
		clearConfigValueCache();
	};

	/** This write as a credential write transform, for `RuntimeCredentials.withWriteTransform`. */
	asTransform(): CredentialWriteTransform {
		return Object.assign((credential: Credential, previous?: Credential) => this.save(credential, previous), {
			rollback: this.rollback,
		});
	}
}

export class KeychainLoginSession {
	private choice: KeychainChoice = "file";
	private asked = false;
	/** The choice was made for an account sign-in (`chooseForSignIn`), so it covers the OAuth credential it returns. */
	private forSignIn = false;
	private secret: string | undefined;
	private readonly write: KeychainWrite;
	private readonly askStorage: () => Promise<KeychainChoice>;

	constructor(keychain: KeychainBackend, providerId: string, askStorage: () => Promise<KeychainChoice>) {
		this.write = new KeychainWrite(keychain, providerId);
		this.askStorage = askStorage;
	}

	/**
	 * For an account sign-in, which types no secret: asks where to store it before the sign-in starts, so the question
	 * never waits inside a credential write.
	 */
	async chooseForSignIn(): Promise<void> {
		if (this.asked) return;
		this.asked = true;
		this.forSignIn = true;
		this.choice = await this.askStorage();
	}

	/** Wraps the login prompt: after the first non-empty secret is typed, asks where to store it. */
	wrapPrompt(prompt: (prompt: AuthPrompt) => Promise<string>): (prompt: AuthPrompt) => Promise<string> {
		return async (request) => {
			const answer = await prompt(request);
			if (request.type === "secret" && !this.asked && answer.trim() !== "") {
				this.asked = true;
				this.secret = answer;
				this.choice = await this.askStorage();
			}
			return answer;
		};
	}

	/**
	 * Stores the typed key, or an account sign-in, in the keychain and swaps it for a reference (an OAuth sign-in too large
	 * for the keychain stays in auth.json); any other credential passes through.
	 */
	readonly transformCredential: CredentialWriteTransform = Object.assign(
		async (credential: Credential, previous?: Credential): Promise<Credential> => {
			const { secret } = this;
			if (this.choice !== "keychain") return credential;
			if (credential.type === "oauth") return this.forSignIn ? this.write.save(credential, previous) : credential;
			if (secret === undefined || credential.type !== "api_key") return credential;
			const key = credential.key;
			if (key === undefined || (key !== secret && key !== secret.trim())) return credential;
			return this.write.save(credential, previous);
		},
		{ rollback: () => this.write.rollback() },
	);
}
