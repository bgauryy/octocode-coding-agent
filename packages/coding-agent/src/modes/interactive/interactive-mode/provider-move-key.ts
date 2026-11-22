import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stripJsonComments } from "@octocodeai/octocode-common/json";
import { stripBom } from "@octocodeai/octocode-common/text";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { providerFallbackDirs } from "../../../config.ts";
import { detectKeychain, type KeychainBackend } from "../../../core/auth-storage/keychain.ts";
import { saveTemplateKey, templateKeyAccount } from "../../../core/provider-templates/key-store.ts";
import { readModelsProviderKey, replaceModelsProviderKey } from "../../../core/provider-templates/models-file.ts";
import { refreshAfterChange } from "./provider-custom-edit.ts";
import type { ProviderManagerHost } from "./provider-manager-host.ts";
import { successNotice } from "./provider-ui.ts";

type MoveHost = ProviderManagerHost;

/** Every models.json that may read a keychain reference: the given file, Pi's global ones, the project's. */
export function modelsFilesToCheck(file: string, cwd = process.cwd()): string[] {
	const dirs = [...providerFallbackDirs(), join(cwd, ".octocode"), join(cwd, ".pi")];
	return [...new Set([file, ...dirs.map((dir) => join(dir, "models.json"))])];
}

/** The first file whose providers' `apiKey` is `keychain`'s reference to `account`; a missing file is skipped. */
async function fileReferencing(
	keychain: KeychainBackend,
	account: string,
	files: readonly string[],
): Promise<string | undefined> {
	for (const each of files) {
		let text: string;
		try {
			text = await readFile(each, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const parsed: unknown = JSON.parse(stripJsonComments(stripBom(text)));
		const providers = isRecord(parsed) && isRecord(parsed.providers) ? Object.values(parsed.providers) : [];
		const keys = providers.map((provider) => (isRecord(provider) ? provider.apiKey : undefined));
		if (keys.some((key) => typeof key === "string" && keychain.isOwnReference(key, account))) return each;
	}
	return undefined;
}

/**
 * Move a literal `apiKey` of an Octocode models.json provider into the system keychain: the key is stored first,
 * then the entry is atomically rewritten to the reference that reads it back, so the provider keeps working. When
 * the rewrite fails the file still holds the literal key and the keychain entry holds the same key, so nothing is
 * deleted (a removal could drop an entry another file reads). The move is refused when any of `files` already reads
 * the keychain entry it would write, so no key another provider uses is replaced. The key is never shown. Returns
 * true when moved.
 */
export async function moveKeyToKeychain(
	host: MoveHost,
	id: string,
	name: string,
	file: string,
	keychain: KeychainBackend | null = detectKeychain(process.platform) ?? null,
	files: readonly string[] = modelsFilesToCheck(file),
): Promise<boolean> {
	if (!keychain) {
		host.showError(
			`No system keychain is available on this machine, so the key of ${name} stays in ${file}. Use sign-in with an API key instead.`,
		);
		return false;
	}
	try {
		const key = await readModelsProviderKey(file, id);
		if (!key) throw new Error(`${name} has no literal apiKey in ${file}.`);
		const holder = await fileReferencing(keychain, templateKeyAccount(id), files);
		if (holder)
			throw new Error(`the ${keychain.name} entry it would use is already read by ${holder}; nothing was replaced.`);
		const reference = await saveTemplateKey(keychain, id, key);
		await replaceModelsProviderKey(file, id, key, reference);
	} catch (error) {
		host.showError(`The key of ${name} stays in ${file}: ${errorMessage(error)}`);
		return false;
	}
	host.showStatus(
		successNotice("Moved the key of", name, `to the ${keychain.name}; models.json now holds only a reference.`),
	);
	try {
		await refreshAfterChange(host);
	} catch (error) {
		host.showError(`The key moved, but reloading providers failed; run /reload. ${errorMessage(error)}`);
	}
	return true;
}
