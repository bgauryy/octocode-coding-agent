/** The /model picker: choosing a model for this chat, or saving it as the global or project default. */

import type { Model } from "@octocodeai/octocode-ai/compat";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { DefaultModelSaveError } from "../../core/agent-session/model-default.ts";
import { getApplicationPort } from "../../core/application/index.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import type { InteractiveModeHost } from "./interactive-mode/host.ts";

type ModelPickerHost = Pick<
	InteractiveModeHost,
	| "maybeWarnAboutAnthropicSubscriptionAuth"
	| "session"
	| "settingsManager"
	| "showError"
	| "showSelectorDialog"
	| "showSelector"
	| "showStatus"
	| "showWarning"
	| "ui"
	| "updateAvailableProviderCount"
	| "updateEditorBorderColor"
>;

const SAVE_GLOBAL = "Global: every project";
const SAVE_PROJECT = "This project only";

export function showModelSelector(host: ModelPickerHost, initialSearchInput?: string): void {
	// The picker and its pending save belong to the session that opened it.
	const { session, settingsManager } = host;
	host.showSelector((done) => {
		// "Both" fires the chat switch and the default save back to back: run them one after the other.
		let queue: Promise<void> = Promise.resolve();
		const enqueue = (model: Model<any>, persist: boolean): void => {
			queue = queue.then(() => selectModel(model, persist));
		};
		const selectModel = async (model: Model<any>, persist: boolean) => {
			let scope: "global" | "project" = "global";
			if (persist && settingsManager.isProjectTrusted()) {
				// A default saved from a session defaults to this project (per-process isolated) so it never leaks to
				// every process; "Global: every project" is the explicit choice to change the default for all.
				const choice = await host.showSelectorDialog(`Save ${model.provider}/${model.id} as the default model`, [
					SAVE_PROJECT,
					SAVE_GLOBAL,
				]);
				if (choice === undefined) {
					done();
					host.ui.requestRender();
					return;
				}
				if (choice === SAVE_PROJECT) scope = "project";
			}
			if (persist) host.showStatus(`Saving default model: ${model.provider}/${model.id}…`);
			try {
				await getApplicationPort(session).invoke("setModel", model, { persist, scope });
				host.updateAvailableProviderCount();
				host.updateEditorBorderColor();
				done();
				const scopedOverride =
					Boolean(settingsManager.getEnabledModels()?.length) &&
					JSON.stringify(settingsManager.getEnabledModels()) !==
						JSON.stringify(settingsManager.getGlobalSettings().enabledModels);
				const projectWins =
					persist &&
					scope === "global" &&
					settingsManager.getProjectSettings().defaultModel !== undefined &&
					(settingsManager.getDefaultProvider() !== model.provider || settingsManager.getDefaultModel() !== model.id);
				const overridden =
					persist &&
					scope === "global" &&
					(settingsManager.getDefaultProvider() !== model.provider ||
						settingsManager.getDefaultModel() !== model.id ||
						scopedOverride);
				host.showStatus(
					persist
						? `Saved ${scope} default: ${model.provider}/${model.id}${
								projectWins
									? `. This project's default (${settingsManager.getDefaultProvider()}/${settingsManager.getDefaultModel()}) wins here; change it with "This project" or /settings set --local.`
									: overridden
										? ". Workspace or run settings take precedence here."
										: ""
							}`
						: `Model: ${model.id}`,
				);
				void host.maybeWarnAboutAnthropicSubscriptionAuth(model);
			} catch (error) {
				done();
				if (error instanceof DefaultModelSaveError) {
					host.updateAvailableProviderCount();
					host.updateEditorBorderColor();
					host.showWarning(error.message);
				} else host.showError(errorMessage(error));
			}
		};
		const defaultProvider = settingsManager.getDefaultProvider();
		const defaultModel = settingsManager.getDefaultModel();
		const global = settingsManager.getGlobalSettings();
		const project = settingsManager.getProjectSettings();
		const configured = { ...global, ...project };
		const source =
			defaultProvider !== configured.defaultProvider || defaultModel !== configured.defaultModel
				? "run"
				: project.defaultProvider !== undefined || project.defaultModel !== undefined
					? "project"
					: "global";
		const selector = new ModelSelectorComponent(
			host.ui,
			session.model,
			session.modelRuntime,
			session.scopedModels,
			(model) => enqueue(model, false),
			() => {
				done();
				host.ui.requestRender();
			},
			initialSearchInput,
			(model) => enqueue(model, true),
			defaultProvider && defaultModel ? { provider: defaultProvider, id: defaultModel } : undefined,
			{ source },
		);
		return { component: selector, focus: selector, dispose: () => selector.dispose() };
	});
}
