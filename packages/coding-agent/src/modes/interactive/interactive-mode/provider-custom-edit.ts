import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { normalizeEndpointHost } from "@octocodeai/octocode-ai";
import { editModelsProvider, removeModelsProvider } from "../../../core/provider-templates/models-file.ts";
import { detectKeychain, type KeychainBackend } from "../../../core/auth-storage/keychain.ts";
import { isTemplateKeyReference, removeTemplateKey } from "../../../core/provider-templates/key-store.ts";
import { removeProviderCredential } from "./provider-actions.ts";
import type { ProviderManagerHost } from "./provider-manager-host.ts";
import { confirmAction, successNotice } from "./provider-ui.ts";

type EditHost = Pick<
	ProviderManagerHost,
	| "session"
	| "showSelectorDialog"
	| "showInputDialog"
	| "showStatus"
	| "showError"
	| "showWarning"
	| "updateAvailableProviderCount"
	| "showSelector"
	| "ui"
>;

/**
 * The base URL requests of a provider go to, and where it comes from: the host saved with its key, else the
 * provider's own (a built-in's default, or the `baseUrl` of its models.json entry).
 */
export async function effectiveBaseUrl(
	ui: Pick<ProviderManagerHost, "session">,
	id: string,
): Promise<{ url: string; source: string } | undefined> {
	const runtime = ui.session.modelRuntime;
	const credential = await runtime.readCredential(id, { signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
	if (credential?.type === "api_key" && credential.endpoint) {
		return { url: credential.endpoint.baseUrl, source: "custom host saved with the key in /providers" };
	}
	const url = runtime.getModels(id)[0]?.baseUrl;
	if (!url) return undefined;
	return { url, source: runtime.getProviderDefinitionFile(id) ? "models.json" : "provider default" };
}

export async function refreshAfterChange(ui: EditHost): Promise<void> {
	await ui.session.modelRuntime.refresh({ allowNetwork: false });
	ui.updateAvailableProviderCount();
}

/** Ask for a new host until it is valid; undefined when cancelled or left empty. */
async function askHost(ui: EditHost, name: string, current: string | undefined): Promise<string | undefined> {
	for (;;) {
		const answer = await ui.showInputDialog(
			`${name}: new API base URL (https)`,
			current ?? "https://llm.example.com/v1",
		);
		if (!answer?.trim()) return undefined;
		try {
			return normalizeEndpointHost(answer);
		} catch (error) {
			ui.showError(errorMessage(error));
		}
	}
}

/** Change the host of a custom provider defined in Octocode's models.json. Returns true when it was written. */
export async function editCustomProviderHost(ui: EditHost, id: string, name: string, file: string): Promise<boolean> {
	const runtime = ui.session.modelRuntime;
	const baseUrl = await askHost(ui, name, runtime.getModels(id)[0]?.baseUrl);
	if (!baseUrl) return false;
	try {
		await editModelsProvider(file, id, { baseUrl });
		await refreshAfterChange(ui);
	} catch (error) {
		ui.showError(errorMessage(error));
		return false;
	}
	ui.showStatus(successNotice("Changed the host of", name, `Requests now go to ${baseUrl}.`));
	return true;
}

/** Change context window and maximum output of one model of a custom provider. Returns true when it was written. */
export async function editCustomProviderLimits(ui: EditHost, id: string, name: string, file: string): Promise<boolean> {
	const models = ui.session.modelRuntime.getModels(id);
	if (models.length === 0) return false;
	const labels = models.map((model) => `${model.id} — ${model.contextWindow} context · ${model.maxTokens} output`);
	const picked = await ui.showSelectorDialog(`Limits for ${name}`, labels);
	const model = picked ? models[labels.indexOf(picked)] : undefined;
	if (!model) return false;
	const ask = async (title: string, current: number) => {
		const answer = await ui.showInputDialog(title, `${current} (Enter keeps it)`);
		if (answer === undefined) return undefined;
		if (!answer.trim()) return current;
		const tokens = Number(answer.trim().replace(/k$/i, "000"));
		return Number.isInteger(tokens) && tokens > 0 ? tokens : Number.NaN;
	};
	const contextWindow = await ask(`${model.id}: context window`, model.contextWindow);
	if (contextWindow === undefined) return false;
	const maxTokens = await ask(`${model.id}: maximum output tokens`, model.maxTokens);
	if (maxTokens === undefined) return false;
	if (Number.isNaN(contextWindow) || Number.isNaN(maxTokens) || maxTokens > contextWindow) {
		ui.showError("Enter positive whole numbers of tokens; the maximum output cannot exceed the context window.");
		return false;
	}
	try {
		await editModelsProvider(file, id, { limits: { [model.id]: { contextWindow, maxTokens } } });
		await refreshAfterChange(ui);
	} catch (error) {
		ui.showError(errorMessage(error));
		return false;
	}
	ui.showStatus(
		successNotice("Changed the limits of", `${id}/${model.id}`, `${contextWindow} context, ${maxTokens} output.`),
	);
	return true;
}

/**
 * Remove a custom provider from Octocode's models.json after one confirmation. A credential saved for it is signed
 * out too (its key and host go together), and so is the keychain entry its models.json key referenced, since
 * nothing would use them afterwards. Returns true when it was removed.
 */
export async function removeCustomProvider(
	ui: ProviderManagerHost,
	id: string,
	name: string,
	file: string,
	hasCredential: boolean,
	keychain: KeychainBackend | undefined = detectKeychain(process.platform),
): Promise<boolean> {
	const detail = hasCredential
		? "Remove from models.json and remove its saved credential (key and host)"
		: "Remove from models.json (and its key, when one is saved in the system keychain)";
	if (!(await confirmAction(ui, `Remove the provider ${name} (${id})?`, [`${detail} — ${file}`]))) return false;
	try {
		const apiKey = await removeModelsProvider(file, id);
		await refreshAfterChange(ui);
		if (keychain && isTemplateKeyReference(keychain, id, apiKey)) await removeTemplateKey(keychain, id);
	} catch (error) {
		ui.showError(errorMessage(error));
		return false;
	}
	if (hasCredential) await removeProviderCredential(ui, id, name, { confirmed: true });
	else ui.showStatus(successNotice("Removed", name, "from models.json."));
	return true;
}
