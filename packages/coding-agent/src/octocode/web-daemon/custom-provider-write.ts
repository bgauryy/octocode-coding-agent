/**
 * Edits of a custom provider defined in Octocode's own models.json, as the terminal's provider page offers them: its
 * host, one model's limits, and its removal. It reuses the terminal's models.json writer (atomic, refuses a file with
 * comments), host check and keychain cleanup. Only the providers that file defines can change: never a built-in one,
 * never Pi's files. A key is never read or shown; removal deletes what the entry's reference points at.
 */

import { join } from "node:path";
import { normalizeEndpointHost } from "@octocodeai/octocode-ai";
import { builtinProviders } from "@octocodeai/octocode-ai/providers/all";
import type { ConfigProviderCommand } from "@octocodeai/octocode-contracts/config";
import { detectKeychain } from "../../core/auth-storage/keychain.ts";
import { editModelsProvider, removeModelsProvider } from "../../core/provider-templates/models-file.ts";
import { isTemplateKeyReference, removeTemplateKey } from "../../core/provider-templates/key-store.ts";
import { customModelsFiles, type CustomProviderDetails } from "../../core/provider-sources/models-files.ts";
import { ConfigWriteError } from "./config-write.ts";
import { writeConfigCredential, type CredentialWriteOptions } from "./credential-write.ts";

export type CustomProviderCommand = Extract<
	ConfigProviderCommand,
	{ action: "edit-host" | "edit-limits" | "remove-custom" }
>;

export const isCustomProviderCommand = (command: ConfigProviderCommand): command is CustomProviderCommand =>
	command.action === "edit-host" || command.action === "edit-limits" || command.action === "remove-custom";

export type CustomProviderOptions = Pick<CredentialWriteOptions, "agentDir" | "keychain" | "env" | "actor" | "audit">;

/** The entry of Octocode's models.json for `id`; 404 when that file does not define it or a built-in provider owns the id. */
async function ownEntry(id: string, options: CustomProviderOptions): Promise<CustomProviderDetails> {
	const [file] = await customModelsFiles({ ownDir: options.agentDir, piDirs: [] }, false, options.env);
	const details = file?.defines.includes(id) ? file.details[id] : undefined;
	if (!details || builtinProviders().some((provider) => provider.id === id))
		throw new ConfigWriteError(404, "Octocode's models.json does not define this provider.", "unknown");
	return details;
}

/** A models.json failure, as text the page can show: the writer's messages name the file and never a key. */
export function writeFailure(error: unknown): ConfigWriteError {
	if (error instanceof ConfigWriteError) return error;
	const message = error instanceof Error ? error.message : "models.json could not be changed.";
	// A file with comments or invalid JSON needs the user's hand; anything else is a failed write.
	return /comments|not valid JSON|must hold|must be an object|does not fit|already defines/.test(message)
		? new ConfigWriteError(409, message, "invalid-file")
		: new ConfigWriteError(500, "models.json could not be changed. Nothing was changed.", "write");
}

/** Applies one edit; throws `ConfigWriteError` when it is refused or fails. */
export async function applyCustomProviderChange(
	command: CustomProviderCommand,
	options: CustomProviderOptions,
): Promise<void> {
	const file = join(options.agentDir, "models.json");
	const details = await ownEntry(command.provider, options);
	try {
		if (command.action === "edit-host") {
			let baseUrl: string;
			try {
				baseUrl = normalizeEndpointHost(command.host);
			} catch (error) {
				// The ai package's host errors are fixed texts that never quote the URL.
				throw new ConfigWriteError(400, error instanceof Error ? error.message : "The host is not valid.", "invalid");
			}
			await editModelsProvider(file, command.provider, { baseUrl });
		} else if (command.action === "edit-limits") {
			if (!details.models.includes(command.model))
				throw new ConfigWriteError(404, "This provider has no such model.", "unknown");
			if (command.maxOutput > command.contextWindow)
				throw new ConfigWriteError(400, "The maximum output cannot exceed the context window.", "invalid");
			await editModelsProvider(file, command.provider, {
				limits: { [command.model]: { contextWindow: command.contextWindow, maxTokens: command.maxOutput } },
			});
		} else {
			const apiKey = await removeModelsProvider(file, command.provider);
			const keychain =
				options.keychain === undefined ? detectKeychain(process.platform) : (options.keychain ?? undefined);
			if (keychain && isTemplateKeyReference(keychain, command.provider, apiKey))
				await removeTemplateKey(keychain, command.provider);
			// A key saved through sign-in goes with the provider: nothing would use it afterwards.
			await writeConfigCredential({ action: "clear", provider: command.provider }, options);
		}
	} catch (error) {
		throw writeFailure(error);
	}
}
