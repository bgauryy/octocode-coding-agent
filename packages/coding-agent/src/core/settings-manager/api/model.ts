import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { ThinkingBudgetsSettings, TransportSetting } from "../../settings-schema.ts";

/** Default model and provider, thinking levels, message delivery modes, transport and the model and tool selections. */
export interface ModelSettingsApi {
	getDefaultProvider(): string | undefined;
	getDefaultModel(): string | undefined;
	setDefaultProvider(provider: string): void;
	setDefaultModel(modelId: string): void;
	setDefaultModelAndProvider(provider: string, modelId: string): void;
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

	/** The resolved `defaultTools` selection, or undefined when no settings layer sets it. */
	getDefaultTools(defaults?: readonly string[]): string[] | undefined;
	setEnabledModels(patterns: string[] | undefined): void;
}
