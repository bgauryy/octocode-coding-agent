import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { HiddenModels } from "../../provider-models.ts";
import type { ProviderSourceOverrides, ToggleableSourceId } from "../../provider-sources/types.ts";
import type { ThinkingBudgetsSettings, TransportSetting } from "../../settings-schema.ts";
import type { DefaultModelSelectionOptions } from "../model-default.ts";

/** Default model and provider, thinking levels, message delivery modes, transport and the model and tool selections. */
export interface ModelSettingsApi {
	getDefaultProvider(): string | undefined;
	getDefaultModel(): string | undefined;
	setDefaultProvider(provider: string): void;
	setDefaultModel(modelId: string): void;
	setDefaultModelAndProvider(provider: string, modelId: string): void;
	/** Saves provider, model and its options together; rejects on invalid settings or storage failure. */
	saveDefaultModelSelection(provider: string, modelId: string, options?: DefaultModelSelectionOptions): Promise<void>;
	/** Sets or (with undefined) removes `defaultProvider` or `defaultModel` in one file; a project write needs a trusted project. */
	setDefaultSelection(
		scope: "global" | "project",
		field: "defaultProvider" | "defaultModel",
		value: string | undefined,
	): void;
	/** Replace or clear a provider/model pair in one settings-file write. */
	setDefaultSelectionPair(
		scope: "global" | "project",
		selection: { provider: string; model: string } | undefined,
	): void;
	/** The user's default model id per provider. */
	getProviderModels(): Record<string, string>;
	getSteeringMode(): "all" | "one-at-a-time";
	setSteeringMode(mode: "all" | "one-at-a-time"): void;
	getFollowUpMode(): "all" | "one-at-a-time";
	setFollowUpMode(mode: "all" | "one-at-a-time"): void;
	getDefaultThinkingLevel(): ThinkingLevel | undefined;
	setDefaultThinkingLevel(level: ThinkingLevel): void;
	getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined;
	getAllModelThinkingLevels(): Record<string, ThinkingLevel>;
	setModelThinkingLevel(provider: string, modelId: string, level: ThinkingLevel): void;
	removeModelThinkingLevel(provider: string, modelId: string): void;
	/** The default working context: a token count, or "full" for the model's whole capacity. */
	getContextBudget(): number | "full";
	getTransport(): TransportSetting;
	setTransport(transport: TransportSetting): void;
	getThinkingBudgets(): ThinkingBudgetsSettings | undefined;
	getEnabledModels(): string[] | undefined;
	getDisabledProviders(): string[];
	setDisabledProviders(providerIds: readonly string[]): void;
	/** Model ids hidden per provider (global only); a provider with no entry shows all. */
	getHiddenModels(): Record<string, string[]>;
	setHiddenModels(hidden: HiddenModels): void;
	/** The user's changes from the provider source defaults (global only). */
	getProviderSources(): ProviderSourceOverrides;
	/** Turn a source on or off; a value equal to its default removes the override. */
	setProviderSourceEnabled(id: ToggleableSourceId, enabled: boolean): void;

	/** The resolved `defaultTools` selection, or undefined when no settings layer sets it. */
	getDefaultTools(defaults?: readonly string[]): string[] | undefined;
	setEnabledModels(patterns: string[] | undefined): void;
	saveEnabledModels(patterns: readonly string[] | undefined): Promise<void>;
}
