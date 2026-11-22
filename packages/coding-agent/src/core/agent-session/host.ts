/**
 * What `AgentSession` hands its collaborators. Collaborators reach public session behavior through
 * the session itself (`SessionPublic`), so calls keep dispatching through the instance, and reach
 * private state only through the run state and callbacks the session passes in.
 */

import type { Agent, AgentMessage, ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage, ImageContent, Model, TextContent } from "@octocodeai/octocode-ai/compat";
import type { CompactionResult } from "../compaction/index.ts";
import type { ManualCompactionOptions } from "../compaction/manual-options.ts";
import type { ContextUsage, FeatureHost, ToolInfo } from "../features/index.ts";
import type { CustomMessage } from "../messages.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { PromptTemplate } from "../prompt-templates.ts";
import type { ResourceLoader } from "../resource-loader/types.ts";
import type { SessionManager, SessionNameSource } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { createRunOutcome, type RunOutcome } from "./run-outcome.ts";
import type { AgentSessionEvent, ModelMutationOptions, PromptOptions } from "./types.ts";

/** `peer`: another agent's interrupt mail; it stops the run like `interrupted` but, in the loop's `new` mode, never a compaction. */
export type AbortReason = "interrupted" | "peer" | "replacement" | "shutdown" | "internal";

/** Flags of the current agent run, shared by the collaborators that start, interrupt and settle it. */
export interface SessionRunState {
	/** Whether the session is processing an agent run or post-run continuation. */
	active: boolean;
	logicalTurnId: string | undefined;
	agentRunAbortRequested: boolean;
	featureRunAbortRequested: boolean;
	inputTerminated: boolean;
	/**
	 * Failed response that the next request repeats, set by auto-retry and overflow recovery. The
	 * retry is routed with it as `failed`, since the context no longer contains it.
	 */
	failedResponse: AssistantMessage | undefined;
	overflowRecoveryAttempted: boolean;
	/**
	 * Why the latest automatic compaction could not fit anything it keeps into the model's window; a request over the
	 * whole window is then not sent. Cleared when the next automatic compaction starts.
	 */
	windowUnfit: string | undefined;
	/**
	 * The branch's leaf when the user cancelled an automatic compaction (Esc) while the run went on: no automatic
	 * compaction runs again for the request it was for, until a reply follows that entry (`compactionCancelledForRequest`).
	 */
	compactionCancelledAt: string | undefined;
	/** Responses cut off at the output limit that the session recovered by compacting and retrying. */
	lengthRecoveries: number;
	/** Replies cut off at the output limit this run asked the model to continue; reset when a run starts. */
	lengthContinuations: number;
	/** Consecutive turns whose tool calls were cut off at the output limit. */
	truncatedToolTurns: number;
	lastAssistantMessage: AssistantMessage | undefined;
	/** How the current or latest run ended so far; replaced when a run starts, and when it settles. */
	outcome: RunOutcome;
	/** Whether any run has started, so `lastRunOutcome` does not report one that never happened. */
	hasRun: boolean;
	turnIndex: number;
	isBeforeSettle: boolean;
	/** Fires when the session is aborted while `agent_before_settle` handlers run: the agent's own signal is gone by then. */
	beforeSettleAbort: AbortController;
	isEmittingAgentSettled: boolean;
	readonly deferredSettledActions: Array<() => Promise<void>>;
	/** What a feature started as a run settled (a compaction it asked for): `settled()` waits for it, a headless run with it. */
	readonly settledWork: Set<Promise<void>>;
}

export function createRunState(): SessionRunState {
	return {
		active: false,
		logicalTurnId: undefined,
		agentRunAbortRequested: false,
		featureRunAbortRequested: false,
		inputTerminated: false,
		failedResponse: undefined,
		overflowRecoveryAttempted: false,
		windowUnfit: undefined,
		compactionCancelledAt: undefined,
		lengthRecoveries: 0,
		lengthContinuations: 0,
		truncatedToolTurns: 0,
		lastAssistantMessage: undefined,
		outcome: createRunOutcome(),
		hasRun: false,
		turnIndex: 0,
		isBeforeSettle: false,
		beforeSettleAbort: new AbortController(),
		isEmittingAgentSettled: false,
		deferredSettledActions: [],
		settledWork: new Set(),
	};
}

/** The public members of `AgentSession` that its collaborators call. */
export interface SessionPublic {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly modelRuntime: ModelRuntime;
	readonly featureHost: FeatureHost;
	readonly resourceLoader: ResourceLoader;
	readonly promptTemplates: ReadonlyArray<PromptTemplate>;
	readonly model: Model<any> | undefined;
	readonly thinkingLevel: ThinkingLevel;
	readonly routedModel: { model: Model<any>; thinkingLevel?: ThinkingLevel } | undefined;
	readonly messages: AgentMessage[];
	readonly isStreaming: boolean;
	readonly isIdle: boolean;
	readonly isCompacting: boolean;
	readonly systemPrompt: string;
	readonly pendingMessageCount: number;
	getActiveToolNames(): string[];
	getAllTools(): ToolInfo[];
	setActiveToolsByName(toolNames: string[]): void;
	getContextUsage(): ContextUsage | undefined;
	getAvailableThinkingLevels(): ThinkingLevel[];
	supportsThinking(): boolean;
	setModel(model: Model<any>, options?: ModelMutationOptions): Promise<void>;
	setThinkingLevel(level: ThinkingLevel, options?: ModelMutationOptions): void;
	setSessionName(name: string, source?: SessionNameSource): void;
	prompt(text: string, options?: PromptOptions): Promise<void>;
	sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn"; together?: boolean },
	): Promise<void>;
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void>;
	abort(reason?: AbortReason): Promise<void>;
	compact(options?: ManualCompactionOptions): Promise<CompactionResult>;
	abortRetry(): void;
	abortCompaction(): void;
	abortBranchSummary(): void;
}

/** Session state and callbacks every collaborator receives. */
export interface SessionInternals {
	readonly session: SessionPublic;
	readonly run: SessionRunState;
	readonly cwd: string;
	emit(event: AgentSessionEvent): void;
	/** Refresh agent state from the canonical session projection. */
	refreshContext(): void;
	resolveIdleWaitIfIdle(): void;
}
