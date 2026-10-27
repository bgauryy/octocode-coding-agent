import { type AssistantMessage, validateToolArguments } from "@octocodeai/octocode-ai";
import type {
	AgentContext,
	AgentLoopConfig,
	AgentTool,
	AgentToolCall,
	AgentToolCallOutcome,
	AgentToolResult,
} from "../types.ts";
import type { ToolUpdateSink } from "./events.ts";
import { AgentToolExecutionError } from "../tool-error.ts";

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
	durationMs: number;
};

/** The `beforeToolCall`, `afterToolCall` and `unknownToolMessage` hooks of {@link AgentLoopConfig}. */
export type ToolCallHooks = Pick<AgentLoopConfig, "beforeToolCall" | "afterToolCall" | "unknownToolMessage">;

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

export async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
	tools: readonly AgentTool<any>[] = currentContext.tools ?? [],
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(config.unknownToolMessage?.(toolCall.name) ?? `Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		let validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
				if (beforeResult.terminate === true) {
					result.terminate = true;
				}
				return {
					kind: "immediate",
					result,
					isError: true,
				};
			}
			validatedArgs = validateToolArguments(tool, { ...preparedToolCall, arguments: validatedArgs });
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

/** Options for {@link runToolCall}. */
export interface RunToolCallOptions extends ToolCallHooks {
	/** Tools the call resolves against. */
	tools: readonly AgentTool<any>[];
	/** Passed to the hooks as the message that issued the call. */
	assistantMessage: AssistantMessage;
	/** Passed to the hooks as the current agent context. */
	context: AgentContext;
	signal?: AbortSignal;
	onUpdate?: ToolUpdateSink;
}

/**
 * Run one tool call through the same steps as a model-issued call: argument preparation, schema
 * validation, `beforeToolCall`, execution, and `afterToolCall`. Emits no events and adds no
 * messages. Tools that call other tools use this so the hooks (for example permission checks)
 * apply to those calls too.
 *
 * Never rejects for tool failures: unknown tools, validation errors, blocked calls, and thrown
 * errors come back as `isError: true`.
 */
export async function runToolCall(toolCall: AgentToolCall, options: RunToolCallOptions): Promise<AgentToolCallOutcome> {
	const { assistantMessage, context, signal } = options;
	const preparation = await prepareToolCall(context, assistantMessage, toolCall, options, signal, options.tools);
	if (preparation.kind === "immediate") {
		return { toolCall, result: preparation.result, isError: preparation.isError };
	}
	const executed = await executePreparedToolCall(preparation, signal, options.onUpdate ?? (() => {}));
	return finalizeExecutedToolCall(context, assistantMessage, preparation, executed, options, signal);
}

/** How long a tool may keep running after an abort before the loop stops waiting for it. */
const ABORT_GRACE_MS = 50;

const ABANDONED = Symbol("abandoned");

/**
 * Resolve with the operation's outcome, or with {@link ABANDONED} once `signal` has been aborted for
 * {@link ABORT_GRACE_MS}. A tool that honors the signal settles inside the grace period and keeps its own
 * result; one that ignores it is abandoned. The abandoned promise stays observed so a later rejection
 * is never unhandled.
 */
function raceAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof ABANDONED> {
	void operation.catch(() => {});
	if (!signal) return operation;
	return new Promise<T | typeof ABANDONED>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
			if (timer !== undefined) clearTimeout(timer);
		};
		const onAbort = () => {
			timer = setTimeout(() => {
				cleanup();
				resolve(ABANDONED);
			}, ABORT_GRACE_MS);
		};
		operation.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Execute a prepared call. An abort ends the call within a short grace period even when the tool ignores
 * the signal: the call then reports "Operation aborted" and the tool keeps running in the background,
 * with its late result, updates and errors discarded.
 */
export async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	onUpdate: ToolUpdateSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;
	const startedAt = performance.now();
	const elapsed = () => Math.round(performance.now() - startedAt);

	try {
		const execution = (async () =>
			prepared.tool.execute(prepared.toolCall.id, prepared.args, signal, (partialResult) => {
				if (!acceptingUpdates) return;
				updateEvents.push(Promise.resolve(onUpdate(partialResult)));
			}))();
		const result = await raceAbort(execution, signal);
		const durationMs = elapsed();
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		if (result === ABANDONED) {
			return { result: createErrorToolResult("Operation aborted"), isError: true, durationMs };
		}
		return { result, isError: result.isError === true, durationMs };
	} catch (error) {
		const durationMs = elapsed();
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result:
				error instanceof AgentToolExecutionError
					? { ...error.result, isError: true }
					: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
			durationMs,
		};
	} finally {
		acceptingUpdates = false;
	}
}

export async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
): Promise<AgentToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				// Structured content not replaced along with the content may no longer match it.
				const structuredContent =
					afterResult.structuredContent ?? (afterResult.content ? undefined : result.structuredContent);
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				if (structuredContent === undefined) delete result.structuredContent;
				else result.structuredContent = structuredContent;
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
		durationMs: executed.durationMs,
	};
}

export function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}
