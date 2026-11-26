import type { SessionCompaction } from "./agent-session/compaction-control.ts";
import { readPlan, planConstraintActive, clearPlanConstraint, type PlanOptions } from "./plan-state.ts";
import { contextReport } from "./agent-session/context-report.ts";
import { sideQuestionsFor, clearSideQuestions } from "./agent-session/side-questions.ts";
import { readRepositoryDiff, readUntrackedDiff } from "../utils/repository-diff.ts";
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
 * documented on `AgentSessionApi` (`./agent-session/api.ts`). The members that only read or forward
 * to a collaborator sit in the base classes `AgentSessionState` (state, tools, models) and
 * `AgentSessionControl` (prompting, queues, compaction, retry, bash); this class holds the
 * constructor, lifecycle, session management, export and the feature system.
 */

import type { AgentEvent, AgentMessage } from "@octocodeai/octocode-agent-core";
import {
	type AssistantMessage,
	cleanupSessionResources,
	type Model,
	type RetryCallbacks,
} from "@octocodeai/octocode-ai/compat";
import { emitFeatureEvent, handleAgentEvent } from "./agent-session/agent-events.ts";
import type { AgentSessionApi } from "./agent-session/api.ts";
import { checkCompaction } from "./agent-session/compaction-check.ts";
import { runDefaultCompaction } from "./agent-session/default-compaction.ts";
import { buildFeatureRuntime, reloadFeatureRuntime } from "./agent-session/feature-host.ts";
import type { SessionInternals } from "./agent-session/host.ts";
import { AgentSessionControl } from "./agent-session/session-control.ts";
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
	ModeBindingOptions,
	PendingUserInput,
} from "./agent-session/types.ts";
import type { BashResult } from "./bash-executor.ts";
import { runUserBash, type UserBashOptions } from "./agent-session/user-bash.ts";
import { generateBugReportSummary } from "./bug-report.ts";
import type { CompactionPreparation, CompactionResult, SummaryRequestPolicy } from "./compaction/index.ts";
import type { SummaryFocus } from "./compaction/summary-focus.ts";
import type { FeatureHost, ReplacedSessionContext } from "./features/index.ts";
import type { BeforeAgentStartTrigger } from "./features/runner.ts";
import type { CompactionReason } from "./session-compaction.ts";
import type { SessionNameSource } from "./session-manager.ts";
import { exportSessionToJsonl } from "./session-export.ts";
import { computeSessionStats, lastAssistantText, type SessionStats } from "./session-stats.ts";
import type { BashOperations } from "./tools/bash.ts";
import { noticeDisabledProvider, watchProviderSettings } from "./provider-sources/index.ts";
import { disposeApplicationPort, getApplicationPort } from "./application/index.ts";

export { type ParsedSkillBlock, parseSkillBlock } from "./agent-session/prompt-expansion.ts";
export type {
	AgentSessionConfig,
	AgentSessionEvent,
	AgentSessionEventListener,
	PromptDisposition,
	QueuedInput,
	QueuedInputDisposition,
	ReleasedQueuedInput,
} from "./agent-session/types.ts";
export type { RunOutcome } from "./agent-session/run-outcome.ts";
export type { SessionStats } from "./session-stats.ts";

export class AgentSession extends AgentSessionControl implements AgentSessionApi {
	/** Collaborators under `./agent-session/`, wired in the constructor. */
	protected readonly _c: SessionCollaborators;
	private readonly _stopProviderWatch = watchProviderSettings(this.settingsManager, this._modelRuntime, this);

	constructor(config: AgentSessionConfig) {
		super(config);

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
		const c = createSessionCollaborators(base, config, this._cacheWarmer, {
			recordBashResult: (...args) => this.recordBashResult(...args),
			runDefaultCompaction: (...args) => this._runDefaultCompaction(...args),
			getSummarizationRequestAuth: (...args) => this._getSummarizationRequestAuth(...args),
			summarizationRetryCallbacks: (source) => this._summarizationRetryCallbacks(source),
			prepareRun: (...args) => this._prepareRun(...args),
			checkCompaction: (...args) => this._checkCompaction(...args),
			runAutoCompaction: (...args) => this._runAutoCompaction(...args),
			emitFeatureEvent: (event) => this._emitFeatureEvent(event),
			waitForIdle: () => this.waitForIdle(),
			setFeatureHost: (runner) => {
				this._featureHost = runner;
			},
		});
		this._c = c;

		// Always subscribe to agent events for internal handling
		// (session persistence, features, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		installSessionAgentHooks(c);
		c.models.applyContextBudget();

		buildFeatureRuntime(c.runtime, {
			activeToolNames: config.initialActiveToolNames,
			includeAllFeatureTools: true,
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
		noticeDisabledProvider(this);
	}

	// Private seams (tests replace or call these on the instance)

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent, signal?: AbortSignal): Promise<void> => {
		await handleAgentEvent(this._c.agentEvents, event, signal);
	};

	private async _emitFeatureEvent(event: AgentEvent): Promise<void> {
		await emitFeatureEvent(this._c.agentEvents, event);
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
		customInstructions?: string | SummaryFocus,
		summaryRequest?: SummaryRequestPolicy,
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
			summaryRequest,
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
	private _runAutoCompaction(...args: Parameters<SessionCompaction["runAuto"]>): Promise<boolean> {
		return this._c.compaction.runAuto(...args);
	}

	// Lifecycle (documented on `AgentSessionApi`)

	getTurnId(): string | undefined {
		return this._run.logicalTurnId;
	}
	subscribe(listener: AgentSessionEventListener): () => void {
		return this._listeners.subscribe(listener);
	}
	dispose(): void {
		this._stopProviderWatch();
		this._c.agentEvents.modelWait.stop();
		clearSideQuestions(this);
		clearPlanConstraint(this.sessionId);
		disposeApplicationPort(this);
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		this._featureHost.invalidate(
			"This feature ctx is stale after session replacement or reload. Do not use a captured api or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
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

	// Shell, session management, export and the feature system

	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		if (planConstraintActive(this.sessionManager))
			throw new Error("Shell execution is blocked during planning. Leave with /plan --off.");
		return this._c.bash.execute(command, onChunk, options);
	}
	runUserBash(command: string, options?: UserBashOptions): Promise<BashResult> {
		return runUserBash(this, command, options);
	}
	/** Session listeners see every event; features also hear `session_context_changed` (the footer's gauge depends on it). */
	protected override _emit(event: AgentSessionEvent): void {
		super._emit(event);
		if (event.type === "session_context_changed") void this._featureHost.emit({ type: "session_context_changed" });
	}
	setSessionName(name: string, source?: SessionNameSource): void {
		this.sessionManager.appendSessionInfo(name, source);
		const nameSource = this.sessionManager.getSessionNameSource();
		const event = {
			type: "session_info_changed",
			name: this.sessionManager.getSessionName(),
			...(nameSource ? { source: nameSource } : {}),
		} as const;
		this._emit(event);
		void this._featureHost.emit(event);
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
		const command = this.featureHost
			.getRegisteredCommands()
			.find((command) => command.name === "plan" && command.sourceInfo.owner === "native");
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
		await command.handler(args, this.featureHost.createCommandContext());
		return readPlan(this.sessionManager.getBranch());
	}
	getContextReport() {
		return contextReport(this);
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
	async bindFeatures(bindings: ModeBindingOptions): Promise<void> {
		this._c.bindings.update(bindings);
		this._c.bindings.apply(this._featureHost);
		await this._featureHost.emit(this._sessionStartEvent);
		this._featureHost.reportUnhandledMcpServers();
		await this._c.bindings.extendResourcesFromFeatures(
			this._sessionStartEvent.reason === "reload" ? "reload" : "startup",
		);
	}
	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		clearSideQuestions(this);
		await reloadFeatureRuntime(this._c.runtime, options);
	}
	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._featureHost.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}
	hasFeatureHandlers(eventType: string): boolean {
		return this._featureHost.hasHandlers(eventType);
	}
	/** Answer the dialog a run is blocked on (`awaiting.id`) for a client other than this mode's UI. */
	answerDialog(
		id: string,
		answer: { choice?: string; text?: string; replies?: unknown },
	): { ok: true } | { ok: false; reason: string } {
		return this._featureHost.answerDialog(id, answer);
	}
	/** A client started answering the dialog `id`: stop the countdown over it. */
	holdDialog(id: string): { ok: true } | { ok: false; reason: string } {
		return this._featureHost.holdDialog(id);
	}
	get featureHost(): FeatureHost {
		return this._featureHost;
	}
}
