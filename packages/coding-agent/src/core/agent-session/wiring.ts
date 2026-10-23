/**
 * Wiring of `AgentSession`'s collaborators: each gets the shared session internals plus the
 * collaborators and session seams it calls. Creating them has no side effects; the session
 * installs the Agent hooks and builds the extension runtime afterwards, in its constructor.
 */

import type { AgentMessage, ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage, Model, RetryCallbacks } from "@octocodeai/octocode-ai/compat";
import type { BashResult } from "../bash-executor.ts";
import type { CacheWarmer } from "../cache-warmer.ts";
import type { ExtensionRunner } from "../extensions/index.ts";
import type { BeforeAgentStartTrigger } from "../extensions/runner.ts";
import type { CompactionHost } from "../session-compaction.ts";
import type { AgentEventsHost } from "./agent-events.ts";
import {
	type AgentHooksHost,
	installAgentInputPreparation,
	installAgentNextTurnRefresh,
	installAgentRequestProjection,
	installForcedPromptProjection,
	installHiddenDeclarationsProjection,
} from "./agent-hooks.ts";
import { SessionBash } from "./bash.ts";
import { SessionBoundaries } from "./boundaries.ts";
import type { CompactionCheckHost } from "./compaction-check.ts";
import { SessionCompaction } from "./compaction-control.ts";
import { SessionExtensionBindings } from "./extension-bindings.ts";
import type { ExtensionRuntimeHost } from "./extension-runtime.ts";
import type { SessionInternals } from "./host.ts";
import { SessionInputQueue } from "./input-queue.ts";
import { SessionModelControl } from "./model-control.ts";
import { expandMentionSkills } from "./prompt-expansion.ts";
import type { PromptingHost } from "./prompting.ts";
import type { RequestAuth } from "./request-auth.ts";
import { SessionRetry } from "./retry.ts";
import { SessionRunLoop } from "./run-loop.ts";
import { SessionToolCalls } from "./tool-calls.ts";
import { SessionToolLoadout } from "./tool-loadout.ts";
import { SessionTreeNavigation } from "./tree-navigation.ts";
import type { AgentSessionConfig, PendingUserInput } from "./types.ts";

/**
 * Private session methods collaborators call back. They dispatch through the session instance,
 * so a replaced or spied method is the one that runs.
 */
export interface SessionSeams {
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void;
	runDefaultCompaction: CompactionHost["summarize"];
	getSummarizationRequestAuth(
		model: Model<any>,
		signal?: AbortSignal,
	): Promise<RequestAuth & { thinkingLevel: ThinkingLevel }>;
	summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks;
	prepareRun(trigger: BeforeAgentStartTrigger, input?: PendingUserInput): Promise<AgentMessage[]>;
	checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck?: boolean,
		toolResults?: AgentMessage[],
	): Promise<boolean>;
	runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean, targetModel?: Model<any>): Promise<boolean>;
	emitExtensionEvent: AgentEventsHost["emitExtensionEvent"];
	waitForIdle(): Promise<void>;
	setExtensionRunner(runner: ExtensionRunner): void;
}

export interface SessionCollaborators {
	readonly models: SessionModelControl;
	readonly tools: SessionToolLoadout;
	readonly toolCalls: SessionToolCalls;
	readonly inputs: SessionInputQueue;
	readonly boundaries: SessionBoundaries;
	readonly retry: SessionRetry;
	readonly bash: SessionBash;
	readonly compaction: SessionCompaction;
	readonly tree: SessionTreeNavigation;
	readonly runLoop: SessionRunLoop;
	readonly bindings: SessionExtensionBindings;
	readonly runtime: ExtensionRuntimeHost;
	readonly prompting: PromptingHost;
	readonly hooks: AgentHooksHost;
	readonly agentEvents: AgentEventsHost;
	readonly compactionCheck: CompactionCheckHost;
}

export function createSessionCollaborators(
	base: SessionInternals,
	config: AgentSessionConfig,
	cacheWarmer: Pick<CacheWarmer, "cancel" | "onAgentSettled"> | undefined,
	seams: SessionSeams,
): SessionCollaborators {
	const { session } = base;
	const models = new SessionModelControl(base, config.scopedModels ?? []);
	const tools = new SessionToolLoadout(base, config);
	const inputs = new SessionInputQueue(base);
	const boundaries = new SessionBoundaries({
		...base,
		pendingCustomMessages: () => inputs.pendingCustomMessages,
		flushPendingCustomMessages: () => inputs.flushPendingCustomMessages(),
	});
	const retry = new SessionRetry({
		...base,
		modelForMessage: (message) => models.modelForMessage(message),
		omitRecoveryAttempt: (message, toolResults) => boundaries.omitRecoveryAttempt(message, toolResults),
	});
	const toolCalls = new SessionToolCalls({
		...base,
		limitsModel: () => models.limitsModel(),
		getCallableTools: () => tools.getCallableTools(),
	});
	const bash = new SessionBash({ ...base, recordBashResult: seams.recordBashResult });
	const compaction = new SessionCompaction({ ...base, cacheWarmer, summarize: seams.runDefaultCompaction });
	const tree = new SessionTreeNavigation({
		...base,
		getSummarizationRequestAuth: seams.getSummarizationRequestAuth,
		summarizationRetryCallbacks: seams.summarizationRetryCallbacks,
		restoreToolsFromTranscript: () => tools.restoreFromTranscript(),
	});
	const runLoop = new SessionRunLoop({
		...base,
		inputs,
		tools,
		retry,
		models,
		bash,
		boundaries,
		cacheWarmer,
		prepareRun: seams.prepareRun,
		checkCompaction: seams.checkCompaction,
		waitForIdle: seams.waitForIdle,
	});
	const defaultToolModifiers = config.defaultToolModifiers ?? [];
	const bindings = new SessionExtensionBindings({
		...base,
		tools,
		models,
		defaultToolModifiers,
		recordAbortReason: (reason) => runLoop.recordAbortReason(reason),
		executeNestedToolCall: (...args) => toolCalls.executeNested(...args),
	});
	const runtime: ExtensionRuntimeHost = {
		...base,
		tools,
		bindings,
		baseToolsOverride: config.baseToolsOverride,
		extensionRunnerRef: config.extensionRunnerRef,
		usesDefaultTools: config.usesDefaultTools ?? false,
		defaultToolModifiers,
		setExtensionRunner: seams.setExtensionRunner,
		syncQueueModesFromSettings: () => {
			session.agent.steeringMode = session.settingsManager.getSteeringMode();
			session.agent.followUpMode = session.settingsManager.getFollowUpMode();
		},
	};
	return {
		models,
		tools,
		toolCalls,
		inputs,
		boundaries,
		retry,
		bash,
		compaction,
		tree,
		runLoop,
		bindings,
		runtime,
		prompting: { ...base, inputs, compaction, runLoop },
		hooks: {
			...base,
			inputs,
			tools,
			expandMentionSkills: (text, expandedPaths) => expandMentionSkills(base, text, expandedPaths),
			runAutoCompaction: seams.runAutoCompaction,
		},
		agentEvents: { ...base, inputs, retry, boundaries, toolCalls, emitExtensionEvent: seams.emitExtensionEvent },
		compactionCheck: {
			...base,
			modelForMessage: (message) => models.modelForMessage(message),
			findPersistedMessageEntryId: (message) => boundaries.findPersistedMessageEntryId(message),
			omitRecoveryAttempt: (message, results) => boundaries.omitRecoveryAttempt(message, results),
			runAutoCompaction: seams.runAutoCompaction,
			emitSessionCompactFailed: (event) => compaction.emitSessionCompactFailed(event),
		},
	};
}

/** Install the session's hooks on its Agent, in the order each wraps the previous one. */
export function installSessionAgentHooks(c: SessionCollaborators): void {
	c.toolCalls.install();
	installAgentNextTurnRefresh(c.hooks);
	installAgentInputPreparation(c.hooks);
	installAgentRequestProjection(c.hooks);
	c.boundaries.installFinishTurn();
	installHiddenDeclarationsProjection(c.hooks);
	installForcedPromptProjection(c.hooks);
}
