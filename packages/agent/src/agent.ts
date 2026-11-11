import {
	getCurrentSystemMessage,
	type ImageContent,
	type Message,
	type SimpleStreamOptions,
	type ThinkingBudgets,
	type ToolChoice,
	type Transport,
} from "@octocodeai/octocode-ai";
import { type AgentEventListener, deliverAgentEvent } from "./agent/event-delivery.ts";
import { createAgentLoopConfig } from "./agent/loop-config.ts";
import type { AgentOptions } from "./agent/options.ts";
import {
	createMutableAgentState,
	createAgentContext,
	defaultConvertToLlm,
	type MutableAgentState,
	normalizePromptInput,
	PendingMessageQueue,
	reduceAgentState,
} from "./agent/state.ts";
import { runAgentLoop, runAgentLoopContinue, runFailureMessage } from "./agent-loop.ts";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
	AgentEvent,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentState,
	FinishTurn,
	PrepareNextTurnContext,
	PrepareRequest,
	PrepareInput,
	InputBatch,
	QueueMode,
	StreamFn,
	ToolExecutionMode,
} from "./types.ts";

export type { AgentOptions } from "./agent/options.ts";
export type { AgentInitialState } from "./agent/state.ts";
export type { QueueMode } from "./types.ts";

type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
	/** The loop already emitted `agent_end`; a later failure must not end the run a second time. */
	ended?: boolean;
};

/**
 * Stateful wrapper around the low-level agent loop.
 *
 * `Agent` owns the current transcript, emits lifecycle events, executes tools,
 * and exposes queueing APIs for steering and follow-up messages.
 */
export class Agent {
	private _state: MutableAgentState;
	private readonly listeners = new Set<AgentEventListener>();
	private readonly steeringQueue: PendingMessageQueue;
	private readonly followUpQueue: PendingMessageQueue;

	public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	public transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	public streamFunction: StreamFn;
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	public onPayload?: SimpleStreamOptions["onPayload"];
	public onResponse?: SimpleStreamOptions["onResponse"];
	public onProviderStreamEvent?: SimpleStreamOptions["onProviderStreamEvent"];
	public beforeToolCall?: AgentOptions["beforeToolCall"];
	public afterToolCall?: AgentOptions["afterToolCall"];
	/** Error text for a call to an undeclared tool; see `AgentLoopConfig.unknownToolMessage`. */
	public unknownToolMessage?: (toolName: string) => string | undefined;
	public earlyStart?: AgentLoopConfig["earlyStart"];
	/** Declared tools that are not executable yet; see `AgentContext.pendingToolNames`. */
	public pendingToolNames?: () => ReadonlySet<string>;
	public finishTurn?: FinishTurn;
	public prepareRequest?: PrepareRequest;
	/** Tool choice for the next provider request only; taken (and cleared) by the request that uses it. */
	public nextToolChoice?: ToolChoice;
	public prepareInput?: PrepareInput;
	public onInputSelected?: (batch: InputBatch) => void;
	public prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	private activeRun?: ActiveRun;
	/** Session identifier forwarded to providers for cache-aware backends. */
	public sessionId?: string;
	/** Optional per-level thinking token budgets forwarded to the stream function. */
	public thinkingBudgets?: ThinkingBudgets;
	/** Preferred transport forwarded to the stream function. */
	public transport: Transport;
	/** Optional cap for provider-requested retry delays. */
	public maxRetryDelayMs?: number;
	/** Tool execution strategy for assistant messages that contain multiple tool calls. */
	public toolExecution: ToolExecutionMode;
	public onListenerError?: AgentOptions["onListenerError"];

	constructor(options: AgentOptions) {
		// Older compiled consumers may omit options or streamFn even though the current API requires them.
		const runtimeOptions: Partial<AgentOptions> = options ?? {};
		this._state = createMutableAgentState(runtimeOptions.initialState);
		this.convertToLlm = runtimeOptions.convertToLlm ?? defaultConvertToLlm;
		this.transformContext = runtimeOptions.transformContext;
		this.streamFunction = runtimeOptions.streamFn ?? getDefaultStreamFn();
		this.getApiKey = runtimeOptions.getApiKey;
		this.onPayload = runtimeOptions.onPayload;
		this.onResponse = runtimeOptions.onResponse;
		this.onProviderStreamEvent = runtimeOptions.onProviderStreamEvent;
		this.beforeToolCall = runtimeOptions.beforeToolCall;
		this.afterToolCall = runtimeOptions.afterToolCall;
		this.unknownToolMessage = runtimeOptions.unknownToolMessage;
		this.pendingToolNames = runtimeOptions.pendingToolNames;
		this.finishTurn = runtimeOptions.finishTurn;
		this.prepareRequest = runtimeOptions.prepareRequest;
		this.prepareInput = runtimeOptions.prepareInput;
		this.onInputSelected = runtimeOptions.onInputSelected;
		this.prepareNextTurnWithContext = runtimeOptions.prepareNextTurnWithContext;
		this.steeringQueue = new PendingMessageQueue(runtimeOptions.steeringMode ?? "one-at-a-time");
		this.followUpQueue = new PendingMessageQueue(runtimeOptions.followUpMode ?? "one-at-a-time");
		this.sessionId = runtimeOptions.sessionId;
		this.thinkingBudgets = runtimeOptions.thinkingBudgets;
		this.transport = runtimeOptions.transport ?? "auto";
		this.maxRetryDelayMs = runtimeOptions.maxRetryDelayMs;
		this.toolExecution = runtimeOptions.toolExecution ?? "parallel";
		this.onListenerError = runtimeOptions.onListenerError;
	}

	/**
	 * Subscribe to agent lifecycle events.
	 *
	 * Listener promises are awaited in subscription order and are included in
	 * the current run's settlement. Listeners also receive the active abort
	 * signal for the current run. After that signal aborts, the run no longer
	 * waits for a listener still busy with a `message_update` or
	 * `tool_execution_update`; every other event stays awaited.
	 *
	 * `agent_end` is the final emitted event for a run, but the agent does not
	 * become idle until all awaited listeners for that event have settled.
	 */
	subscribe(listener: AgentEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Current agent state.
	 *
	 * Assigning `state.tools` or `state.messages` copies the provided top-level array.
	 */
	get state(): AgentState {
		return this._state;
	}

	/** Controls how queued steering messages are drained. */
	set steeringMode(mode: QueueMode) {
		this.steeringQueue.mode = mode;
	}

	get steeringMode(): QueueMode {
		return this.steeringQueue.mode;
	}

	/** Controls how queued follow-up messages are drained. */
	set followUpMode(mode: QueueMode) {
		this.followUpQueue.mode = mode;
	}

	get followUpMode(): QueueMode {
		return this.followUpQueue.mode;
	}
	/** Queue a message to be injected after the current assistant turn finishes. */
	steer(message: AgentMessage): void {
		this.steeringQueue.enqueue(message);
	}

	/** Queue a message to run only after the agent would otherwise stop; `together` drains it with its neighbours that set it too. */
	followUp(message: AgentMessage, options?: { together?: boolean }): void {
		this.followUpQueue.enqueue(message, options);
	}

	/** Remove all queued steering messages. */
	clearSteeringQueue(): void {
		this.steeringQueue.clear();
	}

	/** Remove all queued follow-up messages. */
	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
	}

	/** Remove all queued steering and follow-up messages. */
	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}
	/** Selectively edit queued messages without clearing unrelated entries. */
	hasQueuedMessage = (message: AgentMessage) =>
		this.steeringQueue.contains(message) || this.followUpQueue.contains(message);
	removeQueuedMessage = (message: AgentMessage) =>
		this.steeringQueue.remove(message) || this.followUpQueue.remove(message);
	swapQueuedMessages = (first: AgentMessage, second: AgentMessage) =>
		this.steeringQueue.swap(first, second) || this.followUpQueue.swap(first, second);
	/** Move `message` into `queue`, before `before` when that is queued there, else last. */
	placeQueuedMessage = (message: AgentMessage, queue: "steer" | "followUp", before?: AgentMessage) => {
		this.removeQueuedMessage(message);
		(queue === "steer" ? this.steeringQueue : this.followUpQueue).insert(message, before);
	};
	/** Returns true when either queue still contains pending messages. */
	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	/** Preview the messages selected for the next turn without consuming them. */
	peekQueuedMessages(): AgentMessage[] {
		const steering = this.steeringQueue.peek();
		return steering.length > 0 ? steering : this.followUpQueue.peek();
	}

	/** Active abort signal for the current run, if any. */
	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	/** Abort the current run, if one is active. */
	abort(): void {
		this.activeRun?.abortController.abort();
	}

	/**
	 * Resolve when the current run and all awaited event listeners have finished.
	 *
	 * This resolves after `agent_end` listeners settle.
	 */
	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	/** Clear conversation state and queues while retaining the replayed prompt/tool baseline. */
	reset(): void {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before resetting.");
		}

		const baseline = getCurrentSystemMessage(this._state.messages);
		this._state.messages = baseline ? [baseline] : [];
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this._state.errorMessage = undefined;
		this.clearFollowUpQueue();
		this.clearSteeringQueue();
	}

	/** Start a new prompt from text, a single message, or a batch of messages. */
	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		if (this.activeRun) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		const messages = normalizePromptInput(input, images);
		await this.runPromptMessages(messages);
	}

	/** Continue from the current transcript. The last message must be a user or tool-result message. */
	async continue(): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		const lastMessage = this._state.messages[this._state.messages.length - 1];
		if (!lastMessage || this._state.messages.every((message) => message.role === "system")) {
			throw new Error("No messages to continue from");
		}

		if (lastMessage.role === "assistant") {
			const queuedSteering = this.steeringQueue.drain();
			if (queuedSteering.length > 0) {
				await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
				return;
			}

			const queuedFollowUps = this.followUpQueue.drain();
			if (queuedFollowUps.length > 0) {
				await this.runPromptMessages(queuedFollowUps);
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		await this.runContinuation();
	}

	private async runPromptMessages(
		messages: AgentMessage[],
		options: { skipInitialSteeringPoll?: boolean } = {},
	): Promise<void> {
		await this.runWithLifecycle(async (signal, emit) => {
			await runAgentLoop(
				messages,
				createAgentContext(this._state, this.pendingToolNames),
				this.createLoopConfig(options),
				emit,
				signal,
				this.streamFunction,
			);
		});
	}

	private async runContinuation(): Promise<void> {
		await this.runWithLifecycle(async (signal, emit) => {
			await runAgentLoopContinue(
				createAgentContext(this._state, this.pendingToolNames),
				this.createLoopConfig(),
				emit,
				signal,
				this.streamFunction,
			);
		});
	}

	private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
		return createAgentLoopConfig(this, this._state, this.steeringQueue, this.followUpQueue, options);
	}

	private async runWithLifecycle(
		executor: (signal: AbortSignal, emit: (event: AgentEvent) => Promise<void>) => Promise<void>,
	): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing.");
		}

		const abortController = new AbortController();
		let resolvePromise = () => {};
		const promise = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});
		const run: ActiveRun = { promise, resolve: resolvePromise, abortController };
		this.activeRun = run;
		const emit = (event: AgentEvent) => this.processEvents(event, run);

		this._state.isStreaming = true;
		this._state.streamingMessage = undefined;
		this._state.errorMessage = undefined;

		try {
			await executor(abortController.signal, emit);
		} catch (error) {
			if (run.ended) this._state.errorMessage = error instanceof Error ? error.message : String(error);
			else await this.handleRunFailure(error, abortController.signal.aborted, emit);
			// Stop the run's other work (parallel tools still running) before going idle; the failure is reported first,
			// as a failed run, not an aborted one.
			abortController.abort();
		} finally {
			this.finishRun();
		}
	}

	private async handleRunFailure(
		error: unknown,
		aborted: boolean,
		emit: (event: AgentEvent) => Promise<void>,
	): Promise<void> {
		const failureMessage = runFailureMessage(this._state.model, error, aborted);
		await emit({ type: "message_start", message: failureMessage });
		await emit({ type: "message_end", message: failureMessage });
		await emit({ type: "turn_end", message: failureMessage, toolResults: [] });
		await emit({ type: "agent_end", messages: [failureMessage] });
	}

	private finishRun(): void {
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this.activeRun?.resolve();
		this.activeRun = undefined;
	}

	/**
	 * Reduce internal state for one run's event, then deliver it to listeners.
	 *
	 * An event of a run that is no longer active (a later run may be) is refused before it touches state. `agent_end`
	 * only means no further loop events will be emitted; the run is idle after its `agent_end` listeners finish and
	 * `finishRun()` clears runtime-owned state.
	 */
	private async processEvents(event: AgentEvent, run: ActiveRun): Promise<void> {
		if (this.activeRun !== run) throw new Error("Agent listener invoked outside active run");
		reduceAgentState(this._state, event);
		if (event.type === "agent_end") run.ended = true;
		await deliverAgentEvent(this.listeners, event, run.abortController.signal);
	}
}
