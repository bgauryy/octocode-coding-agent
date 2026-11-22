/**
 * Wiring of `AgentSession`'s collaborators: each gets the shared session internals plus the
 * collaborators and session seams it calls. Creating them has no side effects; the session
 * installs the Agent hooks and builds the feature runtime afterwards, in its constructor.
 */

import type { AgentMessage, ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage, Model, RetryCallbacks } from "@octocodeai/octocode-ai/compat";
import type { BashResult } from "../bash-executor.ts";
import type { CacheWarmer } from "../cache-warmer.ts";
import type { FeatureHost } from "../features/index.ts";
import type { BeforeAgentStartTrigger } from "../features/runner.ts";
import type { CompactionHost } from "../session-compaction.ts";
import type { AgentEventsHost } from "./agent-events.ts";
import {
	type AgentHooksHost,
	installAgentInputPreparation,
	installAgentContextPreparation,
	installForcedPromptProjection,
	installHiddenDeclarationsProjection,
} from "./agent-hooks.ts";
import { SessionBash } from "./bash.ts";
import { SessionBoundaries } from "./boundaries.ts";
import type { CompactionCheckHost } from "./compaction-check.ts";
import { SessionCompaction } from "./compaction-control.ts";
import { ModeBindings } from "./mode-bindings.ts";
import type { FeatureRuntimeHost } from "./feature-host.ts";
import type { SessionInternals } from "./host.ts";
import { SessionInputQueue } from "./input-queue.ts";
import { SessionModelControl } from "./model-control.ts";
import { expandMentionSkills } from "./prompt-expansion.ts";
import { type PromptingHost, releaseHeldInput } from "./prompting.ts";
import type { RequestAuth } from "./request-auth.ts";
import { ModelWaitWatch } from "./model-wait.ts";
import { SessionRetry } from "./retry.ts";
import { SessionRunLoop } from "./run-loop.ts";
import { activateOnDemand, SessionToolCalls } from "./tool-calls.ts";
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
		incoming?: readonly AgentMessage[],
	): Promise<boolean>;
	runAutoCompaction(
		reason: "overflow" | "threshold",
		willRetry: boolean,
		targetModel?: Model<any>,
		targetThinking?: ThinkingLevel,
		incomingTokens?: number,
	): Promise<boolean>;
	emitFeatureEvent: AgentEventsHost["emitFeatureEvent"];
	waitForIdle(): Promise<void>;
	setFeatureHost(runner: FeatureHost): void;
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
	readonly bindings: ModeBindings;
	readonly runtime: FeatureRuntimeHost;
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
	const models = new SessionModelControl(base, config.scopedModels ?? [], config.requestedThinkingLevel);
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
		omitRecoveryAttempt: (message) => boundaries.omitRecoveryAttempt(message),
		// Mid-stream, an append would land between a tool call and its result: deliver at the turn's end instead.
		deliverContextNote: (note) =>
			session.isStreaming ? inputs.addPendingCustomMessage(note) : inputs.appendCustomMessage(note),
	});
	const toolCalls = new SessionToolCalls({
		...base,
		limitsModel: () => models.limitsModel(),
		getCallableTools: () => tools.getCallableTools(),
		resolveUndeclaredTool: (name) =>
			activateOnDemand(
				{
					getToolDefinition: (tool) => tools.getToolDefinition(tool),
					getActiveToolNames: () => base.session.getActiveToolNames(),
					setActiveTools: (names) => tools.setActiveTools(names),
					declared: () => base.session.agent.state.tools,
				},
				name,
			),
		pendingToolNames: tools.pendingMcpToolNames,
		heldToolNames: () => tools.held.off,
		heldToolRefusal: (name) => tools.held.refusal(name, base.session.getActiveToolNames()),
	});
	const bash = new SessionBash({ ...base, recordBashResult: seams.recordBashResult });
	// The prompting host is built below, from this compaction: input held for a manual compaction is released through it.
	const held: { prompting?: PromptingHost } = {};
	const compaction = new SessionCompaction({
		...base,
		cacheWarmer,
		forcedSystemPrompt: () => tools.requestForcedSystemPrompt,
		summarize: seams.runDefaultCompaction,
		// Not awaited: the compaction's caller gets its answer now; a failing run is reported as any hook's run would be.
		releaseHeldInput: () => {
			if (!held.prompting) return;
			releaseHeldInput(held.prompting).catch((error: unknown) => {
				base.session.featureHost.emitError({
					source: "<compaction>",
					event: "compaction_end",
					error: error instanceof Error ? error.message : String(error),
				});
			});
		},
	});
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
	const bindings = new ModeBindings({
		...base,
		tools,
		models,
		inputs,
		defaultToolModifiers,
		recordAbortReason: (reason) => runLoop.recordAbortReason(reason),
		executeNestedToolCall: (...args) => toolCalls.executeNested(...args),
	});
	const runtime: FeatureRuntimeHost = {
		...base,
		tools,
		bindings,
		baseToolsOverride: config.baseToolsOverride,
		featureHostRef: config.featureHostRef,
		usesDefaultTools: config.usesDefaultTools ?? false,
		defaultToolModifiers,
		setFeatureHost: seams.setFeatureHost,
		syncQueueModesFromSettings: () => {
			session.agent.steeringMode = session.settingsManager.getSteeringMode();
			session.agent.followUpMode = session.settingsManager.getFollowUpMode();
		},
	};
	const prompting: PromptingHost = { ...base, inputs, compaction, runLoop, limitsModel: () => models.limitsModel() };
	held.prompting = prompting;
	const modelWait = new ModelWaitWatch(
		(idleMs, cooldown) => base.emit({ type: "model_wait", idleMs, ...(cooldown ? { cooldown } : {}) }),
		(idleMs) => emitModelStall(base.session.featureHost, idleMs),
	);
	// A turn's request that waits out its provider's rate-limit cool-down says so, instead of reading as a silent model.
	if (config.cooldownWaitRef) config.cooldownWaitRef.current = (wait) => modelWait.cooldown(wait);
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
		prompting,
		hooks: {
			...base,
			inputs,
			tools,
			expandMentionSkills: (text, expandedPaths) => expandMentionSkills(base, text, expandedPaths),
			runAutoCompaction: seams.runAutoCompaction,
			prewarmCompaction: (tokens, model, thinking) => compaction.prewarm(tokens, model, thinking),
		},
		agentEvents: {
			...base,
			inputs,
			retry,
			modelWait,
			boundaries,
			toolCalls,
			emitFeatureEvent: seams.emitFeatureEvent,
			observeContextCapacity: (message) => models.observeContextCapacity(message),
		},
		compactionCheck: {
			...base,
			modelForMessage: (message) => models.modelForMessage(message),
			findPersistedMessageEntryId: (message) => boundaries.findPersistedMessageEntryId(message),
			omitRecoveryAttempt: (message) => boundaries.omitRecoveryAttempt(message),
			runAutoCompaction: seams.runAutoCompaction,
			emitSessionCompactFailed: (event) => compaction.emitSessionCompactFailed(event),
		},
	};
}

/** Tells features a request went quiet (`model_stall`), when any listens; nothing waits for them. */
function emitModelStall(runner: FeatureHost, idleMs: number): void {
	if (!runner.hasHandlers("model_stall")) return;
	// Handler failures are already reported through emitError; the timer that saw the silence awaits nothing.
	void runner.emit({ type: "model_stall", idleMs }).catch(() => undefined);
}

/** Install the session's hooks on its Agent, in the order each wraps the previous one. */
export function installSessionAgentHooks(c: SessionCollaborators): void {
	c.toolCalls.install();
	installAgentContextPreparation(c.hooks);
	installAgentInputPreparation(c.hooks);
	c.boundaries.installFinishTurn();
	installHiddenDeclarationsProjection(c.hooks);
	installForcedPromptProjection(c.hooks);
	installRequestSentWatch(c);
}

/**
 * The agent loop transforms each request's context last, after `prepareRequest` (where a compaction can run) and right
 * before it calls the stream function: when the outermost transform returns, the request goes out and its silence counts.
 */
function installRequestSentWatch(c: SessionCollaborators): void {
	const agent = c.hooks.session.agent;
	const previousTransformContext = agent.transformContext;
	agent.transformContext = async (messages, signal) => {
		const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
		c.agentEvents.modelWait.requestSent();
		return transformed;
	};
}
