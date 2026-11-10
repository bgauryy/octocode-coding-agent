/**
 * Model and thinking-level controls: the /model and /effort commands, their selectors, the scoped-models selector,
 * keyboard cycling, and the Anthropic subscription warning.
 */

import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { Model } from "@octocodeai/octocode-ai/compat";
import { getApplicationPort } from "../../../core/application/index.ts";
import { DEFAULT_THINKING_LEVEL } from "../../../core/defaults.ts";
import { findExactModelReferenceMatch, resolveModelScopeFromModels } from "../../../core/model-resolver.ts";
import { ModelSelectorComponent } from "../components/model-selector.ts";
import { ScopedModelsSelectorComponent } from "../components/scoped-models-selector.ts";
import { ThinkingSelectorComponent } from "../components/thinking-selector.ts";
import { refreshModelCatalogs } from "../model-catalog-refresh.ts";
import { ANTHROPIC_SUBSCRIPTION_AUTH_WARNING } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

/** Interactive-mode members used by the model and thinking controls. */
type ModelControlsHost = Pick<
	InteractiveModeHost,
	| "anthropicSubscriptionWarningShown"
	| "findExactModelMatch"
	| "maybeWarnAboutAnthropicSubscriptionAuth"
	| "session"
	| "settingsManager"
	| "showError"
	| "showModelSelector"
	| "showSelector"
	| "showStatus"
	| "showWarning"
	| "ui"
	| "updateAvailableProviderCount"
	| "updateEditorBorderColor"
>;

export function cycleThinkingLevel(host: ModelControlsHost): void {
	const newLevel = getApplicationPort(host.session).invoke("cycleThinkingLevel");
	if (newLevel === undefined) {
		host.showStatus("Current model does not support thinking");
	} else {
		host.updateEditorBorderColor();
		host.showStatus(`Thinking level: ${newLevel}`);
	}
}

export async function cycleModel(host: ModelControlsHost, direction: "forward" | "backward"): Promise<void> {
	try {
		const result = await getApplicationPort(host.session).invoke("cycleModel", direction);
		if (result === undefined) {
			const msg = host.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
			host.showStatus(msg);
		} else {
			host.updateEditorBorderColor();
			const thinkingStr =
				result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
			host.showStatus(`Switched to ${result.model.name || result.model.id}${thinkingStr}`);
			void host.maybeWarnAboutAnthropicSubscriptionAuth(result.model);
		}
	} catch (error) {
		host.showError(errorMessage(error));
	}
}

export function handleThinkingCommand(host: ModelControlsHost, searchTerm?: string): void {
	const availableLevels = host.session.getAvailableThinkingLevels();
	if (!searchTerm) {
		const saved = host.settingsManager.getDefaultThinkingLevel();
		if (saved && saved !== host.session.thinkingLevel)
			host.showStatus(`Saved default thinking level: ${saved}; this session runs at ${host.session.thinkingLevel}`);
		showThinkingSelector(host);
		return;
	}

	const normalized = searchTerm.trim().toLowerCase();
	const level = availableLevels.find((candidate) => candidate.toLowerCase() === normalized);
	if (!level) {
		host.showError(`Unknown thinking level "${searchTerm}". Available levels: ${availableLevels.join(", ")}.`);
		return;
	}

	selectThinkingLevel(host, level, false);
}

function selectThinkingLevel(host: ModelControlsHost, level: ThinkingLevel, persist: boolean): void {
	try {
		getApplicationPort(host.session).invoke("setThinkingLevel", level, { persist });
		host.updateEditorBorderColor();
		const effective = host.session.thinkingLevel;
		const clamped = effective !== level ? ` (this model runs at ${effective})` : "";
		host.showStatus(`${persist ? "Default thinking level" : "Thinking level"}: ${level}${clamped}`);
	} catch (error) {
		host.showError(errorMessage(error));
	}
}

function showThinkingSelector(host: ModelControlsHost): void {
	host.showSelector((done) => {
		const selectLevel = (level: ThinkingLevel, persist: boolean) => {
			selectThinkingLevel(host, level, persist);
			done();
		};
		const selector = new ThinkingSelectorComponent(
			host.session.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
			host.session.getAvailableThinkingLevels(),
			(level) => selectLevel(level, false),
			() => {
				done();
				host.ui.requestRender();
			},
			(level) => selectLevel(level, true),
			host.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL,
		);
		return { component: selector, focus: selector };
	});
}

export async function handleModelCommand(host: ModelControlsHost, searchTerm?: string): Promise<void> {
	if (!searchTerm) {
		host.showModelSelector();
		return;
	}

	const model = await host.findExactModelMatch(searchTerm);
	if (model) {
		try {
			await getApplicationPort(host.session).invoke("setModel", model, { persist: false });
			host.updateEditorBorderColor();
			host.showStatus(`Model: ${model.id}`);
			void host.maybeWarnAboutAnthropicSubscriptionAuth(model);
		} catch (error) {
			host.showError(errorMessage(error));
		}
		return;
	}

	host.showModelSelector(searchTerm);
}

export async function findExactModelMatch(
	host: ModelControlsHost,
	searchTerm: string,
): Promise<Model<any> | undefined> {
	const cachedModels =
		host.session.scopedModels.length > 0
			? host.session.scopedModels.map((scoped) => scoped.model)
			: [...host.session.modelRuntime.getAvailableSnapshot()];
	const cachedMatch = findExactModelReferenceMatch(searchTerm, cachedModels);
	if (cachedMatch || host.session.scopedModels.length > 0) return cachedMatch;

	host.showStatus("Refreshing model catalogs…");
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, 15_000);
	try {
		const result = await refreshModelCatalogs(host.session.modelRuntime, controller.signal);
		if (result.aborted && timedOut) {
			host.showWarning("Model refresh timed out; searching cached models.");
		} else if (result.errors.size > 0) {
			host.showWarning(`Could not refresh ${[...result.errors.keys()].join(", ")}; searching cached models.`);
		}
	} catch (error) {
		host.showWarning(
			timedOut
				? "Model refresh timed out; searching cached models."
				: `Could not refresh model catalogs: ${errorMessage(error)}`,
		);
	} finally {
		clearTimeout(timeout);
	}
	return findExactModelReferenceMatch(searchTerm, [...host.session.modelRuntime.getAvailableSnapshot()]);
}

export async function maybeWarnAboutAnthropicSubscriptionAuth(
	host: ModelControlsHost,
	model: Model<any> | undefined = host.session.model,
): Promise<void> {
	if (host.settingsManager.getWarnings().anthropicExtraUsage === false) {
		return;
	}
	if (host.anthropicSubscriptionWarningShown) {
		return;
	}
	if (!model || model.provider !== "anthropic") {
		return;
	}

	try {
		if ((await host.session.modelRuntime.getCredentialKind(model.provider)) !== "subscription") {
			return;
		}
		host.anthropicSubscriptionWarningShown = true;
		host.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
	} catch {
		// Ignore auth lookup failures for warning-only checks.
	}
}

export function showModelSelector(host: ModelControlsHost, initialSearchInput?: string): void {
	host.showSelector((done) => {
		const selectModel = async (model: Model<any>, persist: boolean) => {
			try {
				await getApplicationPort(host.session).invoke("setModel", model, { persist });
				host.updateAvailableProviderCount();
				host.updateEditorBorderColor();
				done();
				host.showStatus(persist ? `Default model: ${model.provider}/${model.id}` : `Model: ${model.id}`);
				void host.maybeWarnAboutAnthropicSubscriptionAuth(model);
			} catch (error) {
				done();
				host.showError(errorMessage(error));
			}
		};
		const defaultProvider = host.settingsManager.getDefaultProvider();
		const defaultModel = host.settingsManager.getDefaultModel();
		const selector = new ModelSelectorComponent(
			host.ui,
			host.session.model,
			host.session.modelRuntime,
			host.session.scopedModels,
			(model) => void selectModel(model, false),
			() => {
				done();
				host.ui.requestRender();
			},
			initialSearchInput,
			(model) => void selectModel(model, true),
			defaultProvider && defaultModel ? { provider: defaultProvider, id: defaultModel } : undefined,
		);
		return { component: selector, focus: selector, dispose: () => selector.dispose() };
	});
}

export function showModelsSelector(host: ModelControlsHost): void {
	let availableModels = [...host.session.modelRuntime.getAvailableSnapshot()];
	let availableModelIds = new Set(availableModels.map((model) => `${model.provider}/${model.id}`));
	const configuredPatterns = host.settingsManager.getEnabledModels();
	const sessionScopedModels = host.session.scopedModels;
	const configuredEnabledIds = (models: readonly Model<any>[]): string[] | null => {
		if (!configuredPatterns?.length) return null;
		const resolved = resolveModelScopeFromModels(configuredPatterns, models);
		const ids = resolved.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
		for (const diagnostic of resolved.diagnostics) {
			if (diagnostic.code === "no-match" && !ids.includes(diagnostic.pattern)) ids.push(diagnostic.pattern);
		}
		return ids;
	};

	let currentEnabledIds =
		sessionScopedModels.length > 0
			? sessionScopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)
			: configuredEnabledIds(availableModels);
	let selectionChanged = false;

	const updateSessionModels = (enabledIds: string[] | null): void => {
		currentEnabledIds = enabledIds === null ? null : [...enabledIds];
		const hasEnabledAvailableModel = enabledIds?.some((id) => availableModelIds.has(id)) ?? false;
		const allAvailableModelsEnabled =
			enabledIds !== null && [...availableModelIds].every((id) => enabledIds.includes(id));
		if (enabledIds && hasEnabledAvailableModel && !allAvailableModelsEnabled) {
			const newScopedModels = resolveModelScopeFromModels(enabledIds, availableModels).scopedModels;
			getApplicationPort(host.session).invoke(
				"setScopedModels",
				newScopedModels.map((scoped) => ({
					model: scoped.model,
					thinkingLevel: scoped.thinkingLevel,
				})),
			);
		} else {
			getApplicationPort(host.session).invoke("setScopedModels", []);
		}
		host.updateAvailableProviderCount();
		host.ui.requestRender();
	};

	host.showSelector((done) => {
		let disposed = false;
		let timedOut = false;
		const controller = new AbortController();
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, 15_000);
		const selector = new ScopedModelsSelectorComponent(
			{
				allModels: availableModels,
				enabledModelIds: currentEnabledIds,
				refreshStatus: "Refreshing model catalogs…",
			},
			{
				onChange: (enabledIds) => {
					selectionChanged = true;
					updateSessionModels(enabledIds);
				},
				onPersist: (enabledIds) => {
					const allEnabled =
						enabledIds !== null &&
						enabledIds.length === availableModels.length &&
						enabledIds.every((id) => availableModelIds.has(id));
					const newPatterns = enabledIds === null || allEnabled ? undefined : enabledIds;
					host.settingsManager.setEnabledModels(newPatterns ? [...newPatterns] : undefined);
					host.showStatus("Model selection saved to settings");
				},
				onCancel: () => {
					done();
					host.ui.requestRender();
				},
			},
		);
		void refreshModelCatalogs(host.session.modelRuntime, controller.signal)
			.then((result) => {
				if (disposed) return;
				availableModels = [...host.session.modelRuntime.getAvailableSnapshot()];
				availableModelIds = new Set(availableModels.map((model) => `${model.provider}/${model.id}`));
				if (!selectionChanged && sessionScopedModels.length === 0) {
					currentEnabledIds = configuredEnabledIds(availableModels);
					selector.updateModels(availableModels, currentEnabledIds);
				} else {
					selector.updateModels(availableModels);
				}
				if (currentEnabledIds !== null) updateSessionModels(currentEnabledIds);
				if (result.aborted && timedOut) {
					selector.setRefreshStatus("Model refresh timed out; showing cached models.", "warning");
				} else if (result.errors.size > 0) {
					selector.setRefreshStatus(
						`Could not refresh ${[...result.errors.keys()].join(", ")}; showing cached models.`,
						"warning",
					);
				} else {
					selector.setRefreshStatus("Model catalogs refreshed.", "success");
				}
				host.ui.requestRender();
			})
			.catch((error: unknown) => {
				if (disposed) return;
				selector.setRefreshStatus(
					timedOut
						? "Model refresh timed out; showing cached models."
						: `Could not refresh model catalogs: ${errorMessage(error)}`,
					"warning",
				);
				host.ui.requestRender();
			})
			.finally(() => clearTimeout(timeout));
		return {
			component: selector,
			focus: selector,
			dispose: () => {
				disposed = true;
				clearTimeout(timeout);
				controller.abort();
			},
		};
	});
}
