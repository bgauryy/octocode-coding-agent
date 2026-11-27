/** Public `AgentSession` members that read session state or change its model, tools and queue modes. */

import type { Agent, AgentMessage, AgentState, ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { Model } from "@octocodeai/octocode-ai/compat";
import type { CacheWarmingStatus } from "../cache-warmer.ts";
import type { ToolDefinition, ToolInfo, ToolRenderers } from "../features/index.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { PromptTemplate } from "../prompt-templates.ts";
import type { ResourceLoader } from "../resource-loader/types.ts";
import type { SessionManager } from "../session-manager.ts";
import type { CacheWarmingMode, SettingsManager } from "../settings-manager.ts";
import type { ModelCycleResult, ModelMutationOptions } from "./types.ts";

/** Read-only state access of `AgentSession`. */
export interface AgentSessionStateApi {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly modelRuntime: ModelRuntime;
	readonly resourceLoader: ResourceLoader;

	/** Refresh the public finalized transcript from the canonical session projection. */
	refreshContext(): void;

	readonly state: AgentState;

	/** Current cache-warming state and the policy inputs that produced it. */
	readonly cacheWarmingStatus: CacheWarmingStatus | undefined;

	/** Persist the cache-warming mode and immediately reconcile active warming. */
	setCacheWarmingMode(mode: CacheWarmingMode): void;

	/** Current model (may be undefined if not yet selected) */
	readonly model: Model<any> | undefined;

	readonly thinkingLevel: ThinkingLevel;

	/** Under a virtual selection, the physical model and thinking level of the latest successful response. */
	readonly routedModel: { model: Model<any>; thinkingLevel?: ThinkingLevel } | undefined;

	/** Whether the session is currently processing an agent run or post-run continuation. */
	readonly isStreaming: boolean;

	/** Whether the session has no active agent run, compaction, branch summary, retry, or queued continuation. */
	readonly isIdle: boolean;

	/** Current effective system prompt, including changes not yet sent to the model. */
	readonly systemPrompt: string;

	/** Current retry attempt (0 if not retrying) */
	readonly retryAttempt: number;

	/** Whether compaction or branch summarization is currently running */
	readonly isCompacting: boolean;

	/** All messages including custom types like BashExecutionMessage */
	readonly messages: AgentMessage[];

	readonly steeringMode: "all" | "one-at-a-time";

	readonly followUpMode: "all" | "one-at-a-time";

	/** Current session file path, or undefined if sessions are disabled */
	readonly sessionFile: string | undefined;

	readonly sessionId: string;

	/** Current session display name, if set */
	readonly sessionName: string | undefined;

	/** Scoped models for cycling (from --models flag) */
	readonly scopedModels: ReadonlyArray<{
		model: Model<any>;
		thinkingLevel?: ThinkingLevel;
	}>;

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void;

	/** File-based prompt templates */
	readonly promptTemplates: ReadonlyArray<PromptTemplate>;
}

export interface AgentSessionToolsApi {
	/**
	 * Get the names of currently active tools, which are the tools declared to the model.
	 * Only active `direct` tools are also callable from other tools (`getCallableToolNames()`).
	 */
	getActiveToolNames(): string[];

	/** Get the names of the tools that tools can call through `ctx.executeTool()`. */
	getCallableToolNames(): string[];

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[];

	getToolDefinition(name: string): ToolDefinition | undefined;

	/** How calls to `name` are drawn: feature resolvers in load order, then the registered tool. */
	getToolRenderers(name: string): ToolRenderers | undefined;

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown and hidden tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void;
}

/** Model, thinking level and queue mode management of `AgentSession`. */
export interface AgentSessionModelApi {
	/**
	 * Set model directly.
	 * Validates that auth is configured and saves to the session transcript.
	 * Persists to global defaults only when options.persist is true.
	 * @throws Error if no auth is configured for the model
	 */
	setModel(model: Model<any>, options?: ModelMutationOptions): Promise<void>;
	/** Effective capacity before the working budget; a current provider observation can refine an unoverridden catalog fallback. */
	getContextWindowLimit(): number | undefined;
	/** Set/reset this session's context budget within the model's capacity; requires an idle session. */
	setContextWindow(tokens?: number): number;

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	cycleModel(direction?: "forward" | "backward", options?: ModelMutationOptions): Promise<ModelCycleResult | undefined>;

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves the clamped level to the session transcript only if the level actually changes.
	 * Persists the requested level to global defaults only when options.persist is true.
	 */
	setThinkingLevel(level: ThinkingLevel, options?: ModelMutationOptions): void;

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(options?: ModelMutationOptions): ThinkingLevel | undefined;

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[];

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean;

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void;

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void;
}
