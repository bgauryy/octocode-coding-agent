/**
 * What `AgentSession` hands its collaborators. Collaborators reach public session behavior through
 * the session itself (`SessionPublic`), so calls keep dispatching through the instance, and reach
 * private state only through the run state and callbacks the session passes in.
 */

import type { Agent, AgentMessage, ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage, ImageContent, Model, TextContent } from "@octocodeai/octocode-ai/compat";
import type { CompactionResult } from "../compaction/index.ts";
import type { ContextUsage, ExtensionRunner, ToolInfo } from "../features/index.ts";
import type { CustomMessage } from "../messages.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { PromptTemplate } from "../prompt-templates.ts";
import type { ResourceLoader } from "../resource-loader/types.ts";
import type { SessionManager, SessionNameSource } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { AgentSessionEvent, ModelMutationOptions, PromptOptions } from "./types.ts";

export type AbortReason = "interrupted" | "replacement" | "shutdown" | "internal";

/** Flags of the current agent run, shared by the collaborators that start, interrupt and settle it. */
export interface SessionRunState {
	/** Whether the session is processing an agent run or post-run continuation. */
	active: boolean;
	logicalTurnId: string | undefined;
	agentRunAbortRequested: boolean;
	extensionRunAbortRequested: boolean;
	inputTerminated: boolean;
	/**
	 * Failed response that the next request repeats, set by auto-retry and overflow recovery. The
	 * retry is routed with it as `failed`, since the context no longer contains it.
	 */
	failedResponse: AssistantMessage | undefined;
	overflowRecoveryAttempted: boolean;
	/** Responses cut off at the output limit that the session recovered by compacting and retrying. */
	lengthRecoveries: number;
	lastAssistantMessage: AssistantMessage | undefined;
	turnIndex: number;
	isBeforeSettle: boolean;
	abortDuringBeforeSettle: boolean;
	isEmittingAgentSettled: boolean;
	readonly deferredSettledActions: Array<() => Promise<void>>;
}

export function createRunState(): SessionRunState {
	return {
		active: false,
		logicalTurnId: undefined,
		agentRunAbortRequested: false,
		extensionRunAbortRequested: false,
		inputTerminated: false,
		failedResponse: undefined,
		overflowRecoveryAttempted: false,
		lengthRecoveries: 0,
		lastAssistantMessage: undefined,
		turnIndex: 0,
		isBeforeSettle: false,
		abortDuringBeforeSettle: false,
		isEmittingAgentSettled: false,
		deferredSettledActions: [],
	};
}

/** The public members of `AgentSession` that its collaborators call. */
export interface SessionPublic {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly modelRuntime: ModelRuntime;
	readonly extensionRunner: ExtensionRunner;
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
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void>;
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void>;
	abort(reason?: AbortReason): Promise<void>;
	compact(options?: { customInstructions?: string }): Promise<CompactionResult>;
	abortRetry(): void;
	abortCompaction(): void;
	abortBranchSummary(): void;
}

/** Session state and callbacks every collaborator receives. */
export interface SessionInternals {
	readonly session: SessionPublic;
	readonly run: SessionRunState;
	readonly cwd: string;
	/** Emit an event to the session's listeners. */
	emit(event: AgentSessionEvent): void;
	/** Refresh agent state from the canonical session projection. */
	refreshContext(): void;
	resolveIdleWaitIfIdle(): void;
}
