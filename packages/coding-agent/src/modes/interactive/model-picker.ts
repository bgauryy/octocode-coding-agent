/**
 * The /model picker: Enter switches this chat; the save key switches it and saves the global or project default; the
 * details' key saves the provider's preferred model.
 */

import { isBedrockCandidate, preflightBedrockSelection } from "../../core/bedrock-model-access.ts";
import type { Model } from "@octocodeai/octocode-ai/compat";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { DefaultModelSaveError } from "../../core/agent-session/model-default.ts";
import { getApplicationPort } from "../../core/application/index.ts";
import { type ModelSave, ModelSelectorComponent } from "./components/model-selector.ts";
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
		const closed = new AbortController();
		let checking = false;
		const selectModel = async (model: Model<any>, choice: "chat" | ModelSave) => {
			if (checking || closed.signal.aborted) return;
			if (isBedrockCandidate(model)) {
				checking = true;
				host.showStatus(`Checking Bedrock access for ${model.id}…`);
				try {
					const warning = await preflightBedrockSelection(session.modelRuntime, model, closed.signal);
					if (closed.signal.aborted) return;
					if (warning) host.showWarning(warning);
				} catch (error) {
					if (!closed.signal.aborted) {
						done();
						host.showError(errorMessage(error));
					}
					return;
				} finally {
					checking = false;
				}
			}
			const persist = choice === "both";
			if (choice === "provider") {
				try {
					await settingsManager.saveProviderModel(model.provider, model.id);
					host.showStatus(`Preferred model for ${model.provider}: ${model.id}`);
				} catch (error) {
					host.showError(errorMessage(error));
				} finally {
					done();
				}
				return;
			}
			let scope: "global" | "project" = "global";
			if (persist && settingsManager.isProjectTrusted()) {
				// A default saved from a session defaults to this project (per-process isolated) so it never leaks to
				// every process; "Global: every project" is the explicit choice to change the default for all.
				// Stacked on the editor slot so pressing Esc restores the live `/model` picker with its search & cursor intact.
				const choice = await host.showSelectorDialog(
					`Save ${model.provider}/${model.id} as the default model`,
					[SAVE_PROJECT, SAVE_GLOBAL],
					{ stack: true },
				);
				if (choice === undefined) return;
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
				} else {
					host.showError(errorMessage(error));
				}
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
		const startupModel =
			defaultModel ?? (defaultProvider ? settingsManager.getProviderModels()[defaultProvider] : undefined);
		const selector = new ModelSelectorComponent(
			host.ui,
			session.model,
			session.modelRuntime,
			session.scopedModels,
			(model) => void selectModel(model, "chat"),
			() => {
				done();
				host.ui.requestRender();
			},
			initialSearchInput,
			(model, save) => void selectModel(model, save),
			defaultProvider && startupModel ? { provider: defaultProvider, id: startupModel } : undefined,
			{ source, providerOnly: defaultProvider },
		);
		return {
			component: selector,
			focus: selector,
			dispose: () => {
				closed.abort();
				selector.dispose();
			},
		};
	});
}
