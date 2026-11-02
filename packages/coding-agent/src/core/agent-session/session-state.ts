/**
 * Session state and read-mostly accessors of `AgentSession`: the fields every session member shares,
 * plus the state, tool, model and queue-mode members that read or forward to them. `AgentSession`
 * extends this through `AgentSessionControl` (`./session-control.ts`); the members are documented on
 * `AgentSessionApi` (`./api.ts`).
 */

import type { AgentMessage, AgentState, Agent, ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { Model } from "@octocodeai/octocode-ai/compat";
import type { CacheWarmingStatus } from "../cache-warmer.ts";
import type { ContextUsage, ExtensionRunner, SessionStartEvent, ToolDefinition, ToolInfo } from "../features/index.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { PromptTemplate } from "../prompt-templates.ts";
import type { ResourceLoader } from "../resource-loader/types.ts";
import type { SessionManager } from "../session-manager.ts";
import { computeContextUsage } from "../session-stats.ts";
import type { CacheWarmingMode, SettingsManager } from "../settings-manager.ts";
import { createRunState } from "./host.ts";
import { SessionListeners } from "./listeners.ts";
import type { SessionCollaborators } from "./wiring.ts";
import type { AgentSessionConfig, AgentSessionEvent, ModelCycleResult, ModelMutationOptions } from "./types.ts";

export abstract class AgentSessionState {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	// Event subscription state
	protected _unsubscribeAgent?: () => void;
	protected readonly _listeners = new SessionListeners();
	protected readonly _run = createRunState();

	// Extension system
	protected _extensionRunner!: ExtensionRunner;
	protected readonly _resourceLoader: ResourceLoader;
	protected readonly _sessionStartEvent: SessionStartEvent;
	protected readonly _modelRuntime: ModelRuntime;
	protected readonly _cacheWarmer: AgentSessionConfig["cacheWarmer"];

	/** Collaborators under `./agent-session/`, wired in the `AgentSession` constructor. */
	protected abstract readonly _c: SessionCollaborators;

	constructor(config: AgentSessionConfig) {
		if (config.agent.prepareInput)
			throw new Error("AgentSession owns Agent.prepareInput; use a user_input extension instead");
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._resourceLoader = config.resourceLoader;
		this._modelRuntime = config.modelRuntime;
		this._cacheWarmer = config.cacheWarmer;
		if (this._cacheWarmer) {
			this._cacheWarmer.onWarmed = (entry) => this._emit({ type: "entry_appended", entry });
		}
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
	}

	/** Emit an event to all listeners */
	protected _emit(event: AgentSessionEvent): void {
		this._listeners.emit(event);
	}

	// Read-only state

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}
	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}
	get state(): AgentState {
		return this.agent.state;
	}
	get cacheWarmingStatus(): CacheWarmingStatus | undefined {
		return this._cacheWarmer?.status;
	}
	setCacheWarmingMode(mode: CacheWarmingMode): void {
		this.settingsManager.setCacheWarmingMode(mode);
		this._cacheWarmer?.onModeChanged();
	}
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}
	get routedModel(): { model: Model<any>; thinkingLevel?: ThinkingLevel } | undefined {
		return this._c.models.routedModel();
	}
	get isStreaming(): boolean {
		return this._run.active;
	}
	get isIdle(): boolean {
		return !this._run.active && !this.isCompacting;
	}
	get systemPrompt(): string {
		return this._c.tools.systemPrompt;
	}
	get retryAttempt(): number {
		return this._c.retry.attempt;
	}
	get isCompacting(): boolean {
		return this._c.compaction.isRunning || this._c.tree.isSummarizing;
	}
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._c.models.scopedModels;
	}
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._c.models.scopedModels = scopedModels;
	}
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	// Tools, models and queue modes

	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}
	getCallableToolNames(): string[] {
		return this._c.tools.getCallableTools().map((t) => t.name);
	}
	getAllTools(): ToolInfo[] {
		return this._c.tools.getAllTools();
	}
	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._c.tools.getToolDefinition(name);
	}
	setActiveToolsByName(toolNames: string[]): void {
		this._c.tools.setActiveToolsByName(toolNames);
	}
	async setModel(model: Model<any>, options: ModelMutationOptions = {}): Promise<void> {
		await this._c.models.setModel(model, options);
	}
	async cycleModel(
		direction: "forward" | "backward" = "forward",
		options: ModelMutationOptions = {},
	): Promise<ModelCycleResult | undefined> {
		return this._c.models.cycleModel(direction, options);
	}
	setThinkingLevel(level: ThinkingLevel, options: ModelMutationOptions = {}): void {
		this._c.models.setThinkingLevel(level, options);
	}
	cycleThinkingLevel(options: ModelMutationOptions = {}): ThinkingLevel | undefined {
		return this._c.models.cycleThinkingLevel(options);
	}
	getAvailableThinkingLevels(): ThinkingLevel[] {
		return this._c.models.getAvailableThinkingLevels();
	}
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}
	getContextWindowLimit(): number | undefined {
		return this._c.models.getContextWindowLimit();
	}
	setContextWindow(tokens?: number): number {
		return this._c.models.setContextWindow(tokens);
	}
	getContextUsage(): ContextUsage | undefined {
		return computeContextUsage(this.sessionManager, this._c.models.limitsModel());
	}
}
