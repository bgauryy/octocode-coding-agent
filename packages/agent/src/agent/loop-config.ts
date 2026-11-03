import type { Transport } from "@octocodeai/octocode-ai";
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
	| "prepareNextTurn"
	| "prepareNextTurnWithContext"
	| "sessionId"
	| "thinkingBudgets"
	| "maxRetryDelayMs"
> & {
	convertToLlm: NonNullable<AgentOptions["convertToLlm"]>;
	transport: Transport;
	toolExecution: ToolExecutionMode;
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
		finishTurn: agent.finishTurn,
		prepareRequest: agent.prepareRequest,
		prepareInput: agent.prepareInput,
		onInputSelected: agent.onInputSelected,
		prepareNextTurn:
			agent.prepareNextTurnWithContext || agent.prepareNextTurn
				? async (context) => {
						if (agent.prepareNextTurnWithContext) {
							return agent.prepareNextTurnWithContext(context, agent.signal);
						}
						return agent.prepareNextTurn?.(agent.signal);
					}
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
