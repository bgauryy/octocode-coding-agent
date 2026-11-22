import type { KeychainBackend } from "../auth-storage/keychain.ts";
import { clearConfigValueCache } from "../config-value.ts";

/**
 * The key of a provider added from a template, kept in the system keychain under its own account, so the entry in
 * models.json holds only the `!command` reference that reads it back. The account is beside the ones `/providers`
 * sign-in uses for the same provider id (`<id>`, `<id>.endpoint`), so removing one never removes another.
 */
export const templateKeyAccount = (providerId: string): string => `${providerId}.models`;

/** Stores `key` for `providerId` and returns the reference to put in models.json. Never logs or returns the key. */
export async function saveTemplateKey(keychain: KeychainBackend, providerId: string, key: string): Promise<string> {
	const account = templateKeyAccount(providerId);
	await keychain.store(account, key);
	clearConfigValueCache();
	return keychain.referenceFor(account);
}

/** Removes the keychain entry of a template provider; a missing entry is not an error. */
export async function removeTemplateKey(keychain: KeychainBackend, providerId: string): Promise<void> {
	await keychain.remove(templateKeyAccount(providerId));
	clearConfigValueCache();
}

/** Whether `apiKey` (a models.json value) is the keychain reference `saveTemplateKey` wrote for `providerId`. */
export function isTemplateKeyReference(keychain: KeychainBackend, providerId: string, apiKey: unknown): boolean {
	return typeof apiKey === "string" && keychain.isOwnReference(apiKey, templateKeyAccount(providerId));
}
