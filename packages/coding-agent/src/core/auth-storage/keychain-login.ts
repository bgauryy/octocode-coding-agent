/**
 * One API-key login's keychain choice. It watches the secret prompt, asks where to store the key, and rewrites the
 * credential just before it is saved, so the key never reaches auth.json when the keychain is chosen and works.
 */

import type { AuthPrompt, Credential } from "@octocodeai/octocode-ai";
import { clearConfigValueCache } from "../resolve-config-value.ts";
import type { KeychainBackend } from "./keychain.ts";

export type KeychainChoice = "keychain" | "file";

export class KeychainLoginSession {
	private choice: KeychainChoice = "file";
	private asked = false;
	private secret: string | undefined;
	private readonly keychain: KeychainBackend;
	private readonly providerId: string;
	private readonly askStorage: () => Promise<KeychainChoice>;

	constructor(keychain: KeychainBackend, providerId: string, askStorage: () => Promise<KeychainChoice>) {
		this.keychain = keychain;
		this.providerId = providerId;
		this.askStorage = askStorage;
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

	/** Stores the typed key in the keychain and swaps it for a reference; any other credential passes through. */
	readonly transformCredential = async (credential: Credential): Promise<Credential> => {
		const { secret } = this;
		if (this.choice !== "keychain" || secret === undefined || credential.type !== "api_key") return credential;
		const key = credential.key;
		if (key === undefined || (key !== secret && key !== secret.trim())) return credential;
		try {
			await this.keychain.store(this.providerId, key);
		} catch {
			throw new Error("Could not save to the system keychain. No plaintext fallback was written.");
		}
		clearConfigValueCache();
		return { ...credential, key: this.keychain.referenceFor(this.providerId) };
	};
}
