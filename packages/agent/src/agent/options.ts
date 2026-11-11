import type { Message, SimpleStreamOptions, ThinkingBudgets, Transport } from "@octocodeai/octocode-ai";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentLoopTurnUpdate,
	AgentMessage,
	BeforeToolCallContext,
	BeforeToolCallResult,
	FinishTurn,
	InputBatch,
	PrepareInput,
	PrepareNextTurnContext,
	PrepareRequest,
	QueueMode,
	StreamFn,
	ToolExecutionMode,
} from "../types.ts";
import type { ListenerErrorReporter } from "../listener-errors.ts";
import type { AgentInitialState } from "./state.ts";

/** Options for constructing an {@link Agent}. */
export interface AgentOptions {
	initialState?: AgentInitialState;
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	streamFn: StreamFn;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	onPayload?: SimpleStreamOptions["onPayload"];
	onResponse?: SimpleStreamOptions["onResponse"];
	onProviderStreamEvent?: SimpleStreamOptions["onProviderStreamEvent"];
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	unknownToolMessage?: (toolName: string) => string | undefined;
	pendingToolNames?: () => ReadonlySet<string>;
	finishTurn?: FinishTurn;
	prepareRequest?: PrepareRequest;
	prepareInput?: PrepareInput;
	onInputSelected?: (batch: InputBatch) => void;
	prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	sessionId?: string;
	thinkingBudgets?: ThinkingBudgets;
	transport?: Transport;
	maxRetryDelayMs?: number;
	toolExecution?: ToolExecutionMode;
	/** Receives a listener that threw while the run went on; see `AgentLoopConfig.onListenerError`. */
	onListenerError?: ListenerErrorReporter;
}
