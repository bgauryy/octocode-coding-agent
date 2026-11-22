import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import { SETTINGS_DEFAULTS } from "../../settings-defaults.ts";
import type { Settings, ThinkingBudgetsSettings, TransportSetting } from "../../settings-schema.ts";
import { normalizeProviderSources, SOURCE_DEFAULTS } from "../../provider-sources/gate.ts";
import { type HiddenModels, normalizeHiddenModels } from "../../provider-models.ts";
import type { ProviderSourceOverrides, ToggleableSourceId } from "../../provider-sources/types.ts";
import type { ModelSettingsApi } from "../api/model.ts";
import { type DefaultModelSelectionOptions, saveDefaultModelSelection, saveEnabledModels } from "../model-default.ts";
import { DEFAULT_TOOL_NAMES, resolveDefaultTools } from "../tool-list.ts";
import { SettingsAccessorBase } from "./base.ts";

/** Default model and provider, thinking levels, message delivery modes, transport and the model and tool selections. */
export abstract class ModelSettingsAccessors extends SettingsAccessorBase implements ModelSettingsApi {
	saveEnabledModels(patterns: readonly string[] | undefined): Promise<void> {
		return saveEnabledModels(this.state, this.persistence, patterns);
	}
	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.globalSettings.defaultProvider = provider;
		this.markModified("defaultProvider");
		this.save();
	}

	setDefaultModel(modelId: string): void {
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultModel");
		this.save();
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.setDefaultModelFields(provider, modelId);
		this.save();
	}

	/** Save a model and its options together; success means this write reached storage. */
	saveDefaultModelSelection(provider: string, modelId: string, options?: DefaultModelSelectionOptions): Promise<void> {
		return saveDefaultModelSelection(this.state, this.persistence, provider, modelId, options);
	}

	private setDefaultModelFields(provider: string, modelId: string): void {
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
	}

	setDefaultSelection(
		scope: "global" | "project",
		field: "defaultProvider" | "defaultModel",
		value: string | undefined,
	): void {
		const update = (settings: Settings) => {
			if (value === undefined) delete settings[field];
			else settings[field] = value;
		};
		if (scope === "project") return this.updateProjectSettings(field, update);
		update(this.globalSettings);
		this.markModified(field);
		this.save();
	}

	setDefaultSelectionPair(
		scope: "global" | "project",
		selection: { provider: string; model: string } | undefined,
	): void {
		const update = (settings: Settings) => {
			if (selection) {
				settings.defaultProvider = selection.provider;
				settings.defaultModel = selection.model;
			} else {
				delete settings.defaultProvider;
				delete settings.defaultModel;
			}
		};
		if (scope === "project") return this.updateProjectSettings(["defaultProvider", "defaultModel"], update);
		update(this.globalSettings);
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	getProviderModels(): Record<string, string> {
		return { ...this.settings.providerModels };
	}

	/** A hand-edited value that is not "full" or a whole number of at least 8,192 tokens falls back to the default. */
	getContextBudget(): number | "full" {
		const value: unknown = this.settings.contextBudget;
		if (value === "full") return value;
		return Number.isSafeInteger(value) && (value as number) >= 8192
			? (value as number)
			: SETTINGS_DEFAULTS.contextBudget;
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || SETTINGS_DEFAULTS.steeringMode;
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.steeringMode = mode;
		this.markModified("steeringMode");
		this.save();
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || SETTINGS_DEFAULTS.followUpMode;
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.followUpMode = mode;
		this.markModified("followUpMode");
		this.save();
	}

	getDefaultThinkingLevel(): ThinkingLevel | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: ThinkingLevel): void {
		this.globalSettings.defaultThinkingLevel = level;
		this.markModified("defaultThinkingLevel");
		this.save();
	}

	getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined {
		return this.settings.modelThinkingLevels?.[`${provider}/${modelId}`];
	}

	getAllModelThinkingLevels(): Record<string, ThinkingLevel> {
		return { ...this.settings.modelThinkingLevels };
	}

	setModelThinkingLevel(provider: string, modelId: string, level: ThinkingLevel): void {
		this.globalSettings.modelThinkingLevels ??= {};
		this.globalSettings.modelThinkingLevels[`${provider}/${modelId}`] = level;
		this.markModified("modelThinkingLevels");
		this.save();
	}

	removeModelThinkingLevel(provider: string, modelId: string): void {
		if (!this.globalSettings.modelThinkingLevels) return;
		delete this.globalSettings.modelThinkingLevels[`${provider}/${modelId}`];
		if (Object.keys(this.globalSettings.modelThinkingLevels).length === 0) {
			delete this.globalSettings.modelThinkingLevels;
		}
		this.markModified("modelThinkingLevels");
		this.save();
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? SETTINGS_DEFAULTS.transport;
	}

	setTransport(transport: TransportSetting): void {
		this.globalSettings.transport = transport;
		this.markModified("transport");
		this.save();
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	/** Provider ids the user turned off. Global only: a project file cannot hide a provider. */
	getDisabledProviders(): string[] {
		return [...(this.globalSettings.disabledProviders ?? [])];
	}

	setDisabledProviders(providerIds: readonly string[]): void {
		this.globalSettings.disabledProviders = [...new Set(providerIds)];
		this.markModified("disabledProviders");
		this.save();
	}

	/** Model ids the user hid per provider. Global only: a project file cannot hide a model. */
	getHiddenModels(): Record<string, string[]> {
		return normalizeHiddenModels(this.globalSettings.hiddenModels);
	}

	setHiddenModels(hidden: HiddenModels): void {
		const next = normalizeHiddenModels(hidden);
		if (Object.keys(next).length === 0) delete this.globalSettings.hiddenModels;
		else this.globalSettings.hiddenModels = next;
		this.markModified("hiddenModels");
		this.save();
	}

	/** Global only: a project file cannot turn a source on. Unknown ids and values equal to the default are dropped. */
	getProviderSources(): ProviderSourceOverrides {
		return normalizeProviderSources(this.globalSettings.providerSources);
	}

	setProviderSourceEnabled(id: ToggleableSourceId, enabled: boolean): void {
		const next = { ...this.getProviderSources() };
		if (enabled === SOURCE_DEFAULTS[id]) delete next[id];
		else next[id] = enabled;
		this.globalSettings.providerSources = next;
		this.markModified("providerSources");
		this.save();
	}

	getDefaultTools(defaults: readonly string[] = DEFAULT_TOOL_NAMES): string[] | undefined {
		const tools = this.settings.defaultTools;
		if (tools === undefined) return undefined;
		return resolveDefaultTools(Array.isArray(tools) ? tools.filter((tool) => typeof tool === "string") : [], defaults);
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.globalSettings.enabledModels = patterns;
		this.markModified("enabledModels");
		this.save();
	}
}
