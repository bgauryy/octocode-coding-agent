/**
 * Creating a custom provider from a template, as the terminal's `/providers` → `Add from a template` does: the same
 * templates, entry builder, host check, keychain storage and atomic 0600 models.json write (`core/provider-templates/`).
 * The key goes to the OS keychain by default (models.json holds only its reference), to auth.json as plain text only
 * when the request acknowledges it, or is an environment variable reference. When models.json cannot be written, the
 * keychain entry or credential this request created is taken back. A key is never read back, logged or audited.
 */

import { join } from "node:path";
import { builtinProviders } from "@octocodeai/octocode-ai/providers/all";
import { DEFAULT_CONTEXT_WINDOW, type ConfigProviderCommand } from "@octocodeai/octocode-contracts/config";
import { detectKeychain, type KeychainBackend } from "../../core/auth-storage/keychain.ts";
import type { ModelsJsonModel } from "../../core/model-config.ts";
import { addTemplateProvider, templateProviderEntry } from "../../core/provider-templates/apply.ts";
import { removeTemplateKey, saveTemplateKey } from "../../core/provider-templates/key-store.ts";
import { removeModelsProvider } from "../../core/provider-templates/models-file.ts";
import { templateModelEntries } from "../../core/provider-templates/models.ts";
import { PROVIDER_TEMPLATES, type ProviderTemplate } from "../../core/provider-templates/templates.ts";
import { customModelsFiles } from "../../core/provider-sources/models-files.ts";
import { ConfigWriteError } from "./config-write.ts";
import { type CustomProviderOptions, writeFailure } from "./custom-provider-write.ts";
import { writeConfigCredential } from "./credential-write.ts";

export type TemplateProviderCommand = Extract<ConfigProviderCommand, { action: "create-from-template" }>;

export const isTemplateProviderCommand = (command: ConfigProviderCommand): command is TemplateProviderCommand =>
	command.action === "create-from-template";

const invalid = (message: string) => new ConfigWriteError(400, message, "invalid");

/** The model entries with the limits the request gave; a local server has no default, so it needs both. */
function modelEntries(template: ProviderTemplate, command: TemplateProviderCommand): ModelsJsonModel[] {
	const entries = templateModelEntries(
		template,
		command.models.map((model) => model.id),
		{},
	);
	return entries.map((entry) => {
		const limits = command.models.find((model) => model.id.trim() === entry.id);
		const contextWindow = limits?.contextWindow;
		const maxTokens = limits?.maxOutput;
		if (template.kind === "local" && (contextWindow === undefined || maxTokens === undefined))
			throw invalid(`${entry.id}: a local server needs its context window and maximum output.`);
		if (maxTokens !== undefined && maxTokens > (contextWindow ?? DEFAULT_CONTEXT_WINDOW))
			throw invalid(`${entry.id}: the maximum output cannot exceed the context window.`);
		return {
			...entry,
			...(contextWindow === undefined ? {} : { contextWindow }),
			...(maxTokens === undefined ? {} : { maxTokens }),
		};
	});
}

/** Refuses an id an official provider owns or models.json already defines, before any key is stored. */
async function refuseTakenId(id: string, options: CustomProviderOptions): Promise<void> {
	if (builtinProviders().some((provider) => provider.id === id))
		throw new ConfigWriteError(409, "This id belongs to an official provider. Choose another id.", "official");
	const [file] = await customModelsFiles({ ownDir: options.agentDir, piDirs: [] }, false, options.env);
	if (file?.defines.includes(id))
		throw new ConfigWriteError(409, "models.json already defines this provider. Choose another id.", "exists");
}

/** Creates the provider; throws `ConfigWriteError` when it is refused or fails. Nothing stays behind on failure. */
export async function createProviderFromTemplate(
	command: TemplateProviderCommand,
	options: CustomProviderOptions,
): Promise<void> {
	const template = PROVIDER_TEMPLATES.find((each) => each.id === command.template);
	if (!template) throw new ConfigWriteError(404, "Unknown provider template.", "unknown");
	const id = command.provider;
	await refuseTakenId(id, options);
	const models = modelEntries(template, command);
	const { key } = command;
	const keychain: KeychainBackend | undefined =
		options.keychain === undefined ? detectKeychain(process.platform) : (options.keychain ?? undefined);
	if (key.kind === "keychain" && !keychain)
		throw new ConfigWriteError(
			409,
			"This computer has no OS keychain. Use an environment variable, or confirm plain text.",
			"no-keychain",
		);
	// Checked first with a stand-in reference: a refused request stores no key.
	const plan = (reference: string) => {
		try {
			return templateProviderEntry(template, {
				host: command.host,
				models,
				key:
					key.kind === "env"
						? { kind: "env", name: key.name.replace(/^\$/, "") }
						: key.kind === "none"
							? { kind: "none" }
							: key.kind === "keychain"
								? { kind: "keychain", reference }
								: { kind: "saved" },
			});
		} catch (error) {
			throw invalid(error instanceof Error ? error.message : "The provider is not valid.");
		}
	};
	plan("!stand-in");
	const file = join(options.agentDir, "models.json");
	let stored = false;
	try {
		let reference = "";
		if (key.kind === "keychain" && keychain) {
			reference = await saveTemplateKey(keychain, id, key.key.trim());
			stored = true;
		}
		await addTemplateProvider(file, id, plan(reference));
	} catch (error) {
		if (stored && keychain) await removeKeyAfterFailure(keychain, id);
		throw writeFailure(error);
	}
	if (key.kind !== "plaintext") return;
	try {
		// No keychain on purpose: the request chose plain text, which only auth.json holds.
		await writeConfigCredential(
			{ action: "set", provider: id, key: key.key, acknowledgePlaintext: true },
			{ ...options, keychain: null },
		);
	} catch (error) {
		// The provider without its key would show as needing attention; take the entry back instead.
		await removeModelsProvider(file, id).catch(() => undefined);
		throw writeFailure(error);
	}
}

/** Takes back the keychain entry of a provider that was not written; a leftover is reported, never hidden. */
async function removeKeyAfterFailure(keychain: KeychainBackend, id: string): Promise<void> {
	try {
		await removeTemplateKey(keychain, id);
	} catch {
		throw new ConfigWriteError(
			500,
			`models.json was not changed, but the key saved in ${keychain.name} could not be removed. Delete the octocode entry for ${id} there.`,
			"keychain-leftover",
		);
	}
}
