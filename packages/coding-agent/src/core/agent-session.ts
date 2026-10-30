import { readPlan, planConstraintActive, clearPlanConstraint, type PlanOptions } from "../octocode/plan/state.ts";
import { NATIVE_FEATURE_PATH } from "./native-tools.ts";
import { contextReport } from "./agent-session/context-report.ts";
import { sideQuestionsFor, clearSideQuestions } from "./agent-session/side-questions.ts";
import { readRepositoryDiff, readUntrackedDiff } from "../octocode/files/repository-diff.ts";
import type { ManualCompactionOptions } from "./compaction/manual-options.ts";
/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top. The behavior lives in collaborators
 * under `./agent-session/`, each with an explicit host the session passes in; this class owns
 * their wiring, its listeners and idle state, and the public API. The public members are
 * documented on `AgentSessionApi` (`./agent-session/api.ts`).
 */

import type { Agent, AgentEvent, AgentMessage, AgentState, ThinkingLevel } from "@octocodeai/octocode-agent-core";
import {
	type AssistantMessage,
	cleanupSessionResources,
	type ImageContent,
	type Model,
	type RetryCallbacks,
	type TextContent,
} from "@octocodeai/octocode-ai/compat";
import { emitExtensionEvent, handleAgentEvent } from "./agent-session/agent-events.ts";
import type { AgentSessionApi } from "./agent-session/api.ts";
import { checkCompaction } from "./agent-session/compaction-check.ts";
import { runDefaultCompaction } from "./agent-session/compaction-control.ts";
import { buildExtensionRuntime, reloadExtensionRuntime } from "./agent-session/extension-runtime.ts";
import { createRunState, type SessionInternals } from "./agent-session/host.ts";
import { SessionListeners } from "./agent-session/listeners.ts";
import { abortSessionDispatches, trackSessionDispatch } from "./agent-session/dispatch.ts";
import { prompt, queueUserInput, sendCustomMessage, splitUserContent } from "./agent-session/prompting.ts";
import { exportToHtml, getUserMessagesForForking } from "./agent-session/reports.ts";
import { getSummarizationRequestAuth } from "./agent-session/request-auth.ts";
import { summarizationRetryCallbacks } from "./agent-session/retry.ts";
import type { NavigateTreeOptions, NavigateTreeResult } from "./agent-session/tree-navigation.ts";
import {
	createSessionCollaborators,
	installSessionAgentHooks,
	type SessionCollaborators,
} from "./agent-session/wiring.ts";
import type {
	AgentSessionConfig,
	AgentSessionEvent,
	AgentSessionEventListener,
	ExtensionBindings,
	ModelCycleResult,
	ModelMutationOptions,
	PendingUserInput,
	PromptOptions,
	QueuedInput,
	QueuedInputDisposition,
	ReleasedQueuedInput,
} from "./agent-session/types.ts";
import type { BashResult } from "./bash-executor.ts";
import { generateBugReportSummary } from "./bug-report.ts";
import type { CacheWarmingStatus } from "./cache-warmer.ts";
import type { CompactionPreparation, CompactionResult } from "./compaction/index.ts";
import type {
	ContextUsage,
	ExtensionRunner,
	InputSource,
	ReplacedSessionContext,
	SessionStartEvent,
	ToolDefinition,
	ToolInfo,
} from "./extensions/index.ts";
import type { BeforeAgentStartTrigger } from "./extensions/runner.ts";
import type { CustomMessage } from "./messages.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import type { ResourceLoader } from "./resource-loader/types.ts";
import type { CompactionReason } from "./session-compaction.ts";
import { exportSessionToJsonl } from "./session-export.ts";
import type { SessionManager } from "./session-manager.ts";
import { computeContextUsage, computeSessionStats, lastAssistantText, type SessionStats } from "./session-stats.ts";
import type { CacheWarmingMode, SettingsManager } from "./settings-manager.ts";
import type { BashOperations } from "./tools/bash.ts";
import { getApplicationPort } from "./application/index.ts";

export { type ParsedSkillBlock, parseSkillBlock } from "./agent-session/prompt-expansion.ts";
export type {
	AgentSessionConfig,
	AgentSessionEvent,
	AgentSessionEventListener,
	ModelCycleResult,
	PromptDisposition,
	PromptOptions,
	QueuedInput,
	QueuedInputDisposition,
	ReleasedQueuedInput,
} from "./agent-session/types.ts";
export type { SessionStats } from "./session-stats.ts";

export class AgentSession implements AgentSessionApi {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private readonly _listeners = new SessionListeners();
	private readonly _run = createRunState();

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private readonly _resourceLoader: ResourceLoader;
	private readonly _sessionStartEvent: SessionStartEvent;
	private readonly _modelRuntime: ModelRuntime;
	private readonly _cacheWarmer: AgentSessionConfig["cacheWarmer"];

	/** Collaborators under `./agent-session/`, wired in the constructor. */
	private readonly _c: SessionCollaborators;

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

		const base: SessionInternals = {
			session: this,
			run: this._run,
			cwd: config.cwd,
			emit: (event) => this._emit(event),
			refreshContext: () => this._c.boundaries.refreshFinalizedContext(),
			resolveIdleWaitIfIdle: () => {
				if (this.isIdle) this._listeners.resolveIdleWait();
			},
		};
		const c = (this._c = createSessionCollaborators(base, config, this._cacheWarmer, {
			recordBashResult: (...args) => this.recordBashResult(...args),
			runDefaultCompaction: (...args) => this._runDefaultCompaction(...args),
			getSummarizationRequestAuth: (...args) => this._getSummarizationRequestAuth(...args),
			summarizationRetryCallbacks: (source) => this._summarizationRetryCallbacks(source),
			prepareRun: (...args) => this._prepareRun(...args),
			checkCompaction: (...args) => this._checkCompaction(...args),
			runAutoCompaction: (...args) => this._runAutoCompaction(...args),
			emitExtensionEvent: (event) => this._emitExtensionEvent(event),
			waitForIdle: () => this.waitForIdle(),
			setExtensionRunner: (runner) => {
				this._extensionRunner = runner;
			},
		}));

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		installSessionAgentHooks(c);
		c.models.applyContextBudget();

		buildExtensionRuntime(c.runtime, {
			activeToolNames: config.initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		if (c.runtime.usesDefaultTools) c.tools.restoreFromTranscript(c.runtime.defaultToolModifiers);
		else if (config.allowedToolNames) {
			// An explicit `--tools` allowlist still restores the loaded tools it and the tool policy permit; the
			// allowlist's own tools stay active. `--no-tools` sets no allowlist, so it restores nothing.
			const named = this.getActiveToolNames();
			c.tools.restoreFromTranscript();
			c.tools.setActiveTools([...new Set([...named, ...this.getActiveToolNames()])]);
		}
		getApplicationPort(this);
	}

	// Private seams (tests replace or call these on the instance)

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		this._listeners.emit(event);
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		await handleAgentEvent(this._c.agentEvents, event);
	};

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		await emitExtensionEvent(this._c.agentEvents, event);
	}

	/** Prepare a run and return its starting messages (see `SessionRunLoop.prepareRun`). */
	private async _prepareRun(trigger: BeforeAgentStartTrigger, input?: PendingUserInput): Promise<AgentMessage[]> {
		return this._c.runLoop.prepareRun(trigger, input);
	}

	private async _getSummarizationRequestAuth(selectedModel: Model<any>, signal?: AbortSignal) {
		return getSummarizationRequestAuth(this, selectedModel, signal);
	}

	/** Retry policy + callbacks shared by compaction and branch-summary summarization calls. */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		return summarizationRetryCallbacks((event) => this._emit(event), source);
	}

	/** Generate Octocode's built-in compaction summary for manual and automatic compaction. */
	private async _runDefaultCompaction(
		preparation: CompactionPreparation,
		model: Model<any>,
		signal: AbortSignal,
		reason: CompactionReason,
		customInstructions?: string,
	): Promise<CompactionResult> {
		return runDefaultCompaction(
			{
				session: this,
				emit: (event) => this._emit(event),
				getSummarizationRequestAuth: (requestModel, requestSignal) =>
					this._getSummarizationRequestAuth(requestModel, requestSignal),
				summarizationRetryCallbacks: (source) => this._summarizationRetryCallbacks(source),
			},
			preparation,
			model,
			signal,
			reason,
			customInstructions,
		);
	}

	/** Dispatch automatic compaction after `agent_end` or before prompt submission (see `checkCompaction`). */
	private async _checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		incoming: readonly AgentMessage[] = [],
	): Promise<boolean> {
		return checkCompaction(this._c.compactionCheck, assistantMessage, skipAbortedCheck, incoming);
	}

	/** Execute threshold or overflow compaction (see `SessionCompaction.runAuto`). */
	private async _runAutoCompaction(
		reason: "overflow" | "threshold",
		willRetry: boolean,
		targetModel?: Model<any>,
		targetThinking?: ThinkingLevel,
	): Promise<boolean> {
		return this._c.compaction.runAuto(reason, willRetry, targetModel, targetThinking);
	}

	// Lifecycle and read-only state (documented on `AgentSessionApi`)

	getTurnId(): string | undefined {
		return this._run.logicalTurnId;
	}
	subscribe(listener: AgentSessionEventListener): () => void {
		return this._listeners.subscribe(listener);
	}
	dispose(): void {
		clearSideQuestions(this);
		clearPlanConstraint(this.sessionId);
		getApplicationPort(this).dispose();
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured api or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		// Disconnect from agent events.
		this._unsubscribeAgent?.();
		this._unsubscribeAgent = undefined;
		this._listeners.clear();
		this._c.tools.pendingMcp.dispose();
		if (this._cacheWarmer) {
			this._cacheWarmer.onWarmed = undefined;
			this._cacheWarmer.cancel();
		}
		cleanupSessionResources(this.sessionId);
	}
	refreshContext(): void {
		this._c.boundaries.refreshFinalizedContext();
	}
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

	// Prompting and input queues

	async prompt(text: string, options?: PromptOptions): Promise<void> {
		await trackSessionDispatch(
			this,
			() => prompt(this._c.prompting, text, options),
			(active, dispatchId) => this._listeners.emit({ type: "session_dispatch", active, dispatchId }),
		);
	}
	async steer(
		text: string,
		images?: ImageContent[],
		options?: { source?: InputSource },
	): Promise<QueuedInputDisposition> {
		return queueUserInput(this._c.prompting, text, images, "steer", options?.source ?? "interactive");
	}
	async followUp(
		text: string,
		images?: ImageContent[],
		options?: { source?: InputSource },
	): Promise<QueuedInputDisposition> {
		return queueUserInput(this._c.prompting, text, images, "followUp", options?.source ?? "interactive");
	}
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const send = () => sendCustomMessage(this._c.prompting, message, options);
		if (options?.triggerTurn)
			await trackSessionDispatch(this, send, (active, dispatchId) =>
				this._listeners.emit({ type: "session_dispatch", active, dispatchId }),
			);
		else await send();
	}
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void> {
		// Normalize content to text string + optional images
		const { text, images } = splitUserContent(content);
		await this.prompt(text, {
			expandPromptTemplates: options?.expandPromptTemplates ?? false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}
	clearQueue(): { steering: string[]; followUp: string[] } {
		return this._c.inputs.clear();
	}
	get pendingMessageCount(): number {
		return this._c.inputs.pendingMessageCount;
	}
	getSteeringMessages(): readonly string[] {
		return this._c.inputs.steeringMessages;
	}
	getFollowUpMessages(): readonly string[] {
		return this._c.inputs.followUpMessages;
	}
	getQueuedInputs(): readonly QueuedInput[] {
		return this._c.inputs.queuedInputs;
	}
	replaceQueuedInput(id: string, text: string): "replaced" | "removed" | "missing" {
		return this._c.inputs.replace(id, text);
	}
	removeQueuedInput(id: string): QueuedInput | undefined {
		return this._c.inputs.remove(id);
	}
	moveQueuedInput(id: string, direction: "up" | "down"): boolean {
		return this._c.inputs.move(id, direction);
	}
	setQueuedInputMode(id: string, mode: "steer" | "followUp"): boolean {
		return this._c.inputs.setMode(id, mode);
	}
	holdQueuedInput(id: string): QueuedInput | undefined {
		return this._c.inputs.hold(id);
	}
	releaseQueuedInput(id: string, text?: string): ReleasedQueuedInput {
		return this._c.inputs.release(id, text);
	}
	async abort(reason: "interrupted" | "replacement" | "shutdown" | "internal" = "interrupted"): Promise<void> {
		abortSessionDispatches(this);
		await this._c.runLoop.abort(reason);
	}
	async stopActiveWork(): Promise<void> {
		await Promise.all([this.abort(), this._c.bash.abortAndWait()]);
	}
	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._listeners.idleWait();
	}

	// Compaction, auto-retry and bash execution

	async compact(options?: ManualCompactionOptions): Promise<CompactionResult> {
		return this._c.compaction.compact(options);
	}
	abortCompaction(): void {
		this._c.compaction.abort();
	}
	abortBranchSummary(): void {
		this._c.tree.abort();
	}
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}
	abortRetry(): void {
		this._c.retry.abort();
	}
	get isRetrying(): boolean {
		return this._c.retry.isRetrying;
	}
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		if (planConstraintActive(this.sessionManager))
			throw new Error("Shell execution is blocked during planning. Leave with /plan --off.");
		return this._c.bash.execute(command, onChunk, options);
	}
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		this._c.bash.record(command, result, options);
	}
	abortBash(): void {
		this._c.bash.abort();
	}
	get isBashRunning(): boolean {
		return this._c.bash.isRunning;
	}
	get hasPendingBashMessages(): boolean {
		return this._c.bash.hasPendingMessages;
	}

	// Session management, export and the extension system

	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = {
			type: "session_info_changed",
			name: this.sessionManager.getSessionName(),
		} as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}
	async navigateTree(targetId: string, options: NavigateTreeOptions = {}): Promise<NavigateTreeResult> {
		clearSideQuestions(this);
		return this._c.tree.navigate(targetId, options);
	}
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		return getUserMessagesForForking(this.sessionManager);
	}
	getSessionStats(): SessionStats {
		return computeSessionStats(this.sessionManager, {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			contextUsage: this.getContextUsage(),
			lengthRecoveries: this._run.lengthRecoveries,
		});
	}
	async controlPlan(options: PlanOptions) {
		getApplicationPort(this);
		const command = this.extensionRunner
			.getRegisteredCommands()
			.find((command) => command.name === "plan" && command.sourceInfo.path === NATIVE_FEATURE_PATH);
		if (!command) throw new Error("Planning controls require native features.");
		if (!["show", "enter", "leave", "approve"].includes(options.action)) throw new Error("Invalid planning action.");
		if (options.action === "approve" && (!Number.isSafeInteger(options.revision) || Number(options.revision) < 1))
			throw new Error("A positive plan revision is required.");
		const args =
			options.action === "show"
				? "--show"
				: options.action === "leave"
					? "--off"
					: options.action === "approve"
						? `--approve ${options.revision}`
						: "";
		await command.handler(args, this.extensionRunner.createCommandContext());
		return readPlan(this.sessionManager.getBranch());
	}
	getContextReport() {
		return contextReport(this);
	}
	getContextWindowLimit(): number | undefined {
		return this._c.models.getContextWindowLimit();
	}
	setContextWindow(tokens?: number): number {
		return this._c.models.setContextWindow(tokens);
	}
	askSideQuestion(question: string): Promise<string> {
		return sideQuestionsFor(this).ask(question);
	}
	getRepositoryDiff(selection?: string, signal?: AbortSignal) {
		return readRepositoryDiff(this.sessionManager.getCwd(), selection, signal);
	}
	getUntrackedDiff(root: string, file: string) {
		return readUntrackedDiff(root, file);
	}
	getContextUsage(): ContextUsage | undefined {
		return computeContextUsage(this.sessionManager, this._c.models.limitsModel());
	}
	async exportToHtml(outputPath?: string, options: { themeName?: string } = {}): Promise<string> {
		return exportToHtml(this, (name) => this.getToolDefinition(name), outputPath, options);
	}
	exportToJsonl(outputPath?: string): string {
		return exportSessionToJsonl(this.sessionManager, outputPath);
	}
	async summarizeForBugReport(options: { hint?: string; signal: AbortSignal }): Promise<string> {
		const model = this.model;
		if (!model) {
			throw new Error("No model selected");
		}
		return generateBugReportSummary({
			...(await this._getSummarizationRequestAuth(model, options.signal)),
			messages: this.messages,
			hint: options.hint,
			signal: options.signal,
			streamFn: this.agent.streamFunction,
			retry: this.settingsManager.getRetrySettings(),
			sessionId: this.sessionId,
		});
	}
	getLastAssistantText(): string | undefined {
		return lastAssistantText(this.messages);
	}
	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		this._c.bindings.update(bindings);
		this._c.bindings.apply(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		this._extensionRunner.reportUnhandledMcpServers();
		await this._c.bindings.extendResourcesFromExtensions(
			this._sessionStartEvent.reason === "reload" ? "reload" : "startup",
		);
	}
	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		clearSideQuestions(this);
		await reloadExtensionRuntime(this._c.runtime, options);
	}
	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}
	/** Answer the dialog a run is blocked on (`awaiting.id`) for a client other than this mode's UI. */
	answerDialog(id: string, answer: { choice?: string; text?: string }): { ok: true } | { ok: false; reason: string } {
		return this._extensionRunner.answerDialog(id, answer);
	}
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
