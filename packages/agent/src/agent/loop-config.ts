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
	| "resolveUndeclaredTool"
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

const sameTools = (
	left: readonly AgentState["tools"][number][] | undefined,
	right: readonly AgentState["tools"][number][] | undefined,
): boolean =>
	left === right ||
	(!!left && !!right && left.length === right.length && left.every((tool, index) => tool === right[index]));

/** Build the low-level loop config for one run from the agent's current state, settings and queues. */
export function createAgentLoopConfig(
	agent: AgentLoopHost,
	state: Pick<AgentState, "model" | "thinkingLevel" | "tools">,
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
		resolveUndeclaredTool: agent.resolveUndeclaredTool,
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
		prepareNextTurn: async (context) => {
			const update = await agent.prepareNextTurnWithContext?.(context, agent.signal);
			const target = update?.context ?? context.context;
			// Refresh only inherited stale tools. A hook that deliberately returned a different tool set owns that replacement.
			if (update?.context && !sameTools(target.tools, context.context.tools)) return update;
			if (sameTools(target.tools, state.tools)) return update ?? undefined;
			return { ...update, context: { ...target, tools: state.tools.slice() } };
		},
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
