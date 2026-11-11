import type { ToolChoice, Transport } from "@octocodeai/octocode-ai";
import type { AgentLoopConfig, AgentState, ToolExecutionMode } from "../types.ts";
import type { AgentOptions } from "./options.ts";
import type { PendingMessageQueue } from "./state.ts";

/** The agent settings and hooks each run's loop config reads; `Agent` passes itself. */
type AgentLoopHost = Pick<
	AgentOptions,
	| "transformContext"
	| "getApiKey"
	| "onPayload"
	| "onResponse"
	| "onProviderStreamEvent"
	| "beforeToolCall"
	| "afterToolCall"
	| "unknownToolMessage"
	| "finishTurn"
	| "prepareRequest"
	| "prepareInput"
	| "onInputSelected"
	| "prepareNextTurnWithContext"
	| "sessionId"
	| "thinkingBudgets"
	| "maxRetryDelayMs"
	| "onListenerError"
> & {
	/** Tool choice for the next request only; read and cleared as that request is prepared. */
	nextToolChoice?: ToolChoice;
	convertToLlm: NonNullable<AgentOptions["convertToLlm"]>;
	transport: Transport;
	toolExecution: ToolExecutionMode;
	/** Set by the host on the agent (not an option); see `AgentLoopConfig.earlyStart`. */
	earlyStart?: AgentLoopConfig["earlyStart"];
	/** Active abort signal for the current run, if any. */
	readonly signal: AbortSignal | undefined;
};

/** Build the low-level loop config for one run from the agent's current state, settings and queues. */
export function createAgentLoopConfig(
	agent: AgentLoopHost,
	state: Pick<AgentState, "model" | "thinkingLevel">,
	steeringQueue: PendingMessageQueue,
	followUpQueue: PendingMessageQueue,
	options: { skipInitialSteeringPoll?: boolean } = {},
): AgentLoopConfig {
	let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
	return {
		model: state.model,
		reasoning: state.thinkingLevel === "off" ? undefined : state.thinkingLevel,
		sessionId: agent.sessionId,
		onPayload: agent.onPayload,
		onResponse: agent.onResponse,
		onProviderStreamEvent: agent.onProviderStreamEvent,
		transport: agent.transport,
		thinkingBudgets: agent.thinkingBudgets,
		maxRetryDelayMs: agent.maxRetryDelayMs,
		toolExecution: agent.toolExecution,
		beforeToolCall: agent.beforeToolCall,
		afterToolCall: agent.afterToolCall,
		unknownToolMessage: agent.unknownToolMessage,
		onListenerError: agent.onListenerError,
		earlyStart: agent.earlyStart,
		finishTurn: agent.finishTurn,
		prepareRequest: async (request, signal) => {
			const update = await agent.prepareRequest?.(request, signal);
			const toolChoice = agent.nextToolChoice;
			agent.nextToolChoice = undefined;
			return toolChoice ? { ...update, toolChoice } : (update ?? undefined);
		},
		prepareInput: agent.prepareInput,
		onInputSelected: agent.onInputSelected,
		prepareNextTurn: agent.prepareNextTurnWithContext
			? async (context) => agent.prepareNextTurnWithContext?.(context, agent.signal)
			: undefined,
		convertToLlm: agent.convertToLlm,
		transformContext: agent.transformContext,
		getApiKey: agent.getApiKey,
		getSteeringMessages: async () => {
			if (skipInitialSteeringPoll) {
				skipInitialSteeringPoll = false;
				return [];
			}
			return steeringQueue.drain();
		},
		getFollowUpMessages: async () => followUpQueue.drain(),
	};
}
