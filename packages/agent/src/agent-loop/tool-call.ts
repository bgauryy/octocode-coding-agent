import { type AssistantMessage, validateToolArguments } from "@octocodeai/octocode-ai";
import type {
	AgentContext,
	BeforeToolCallResult,
	AgentLoopConfig,
	AgentTool,
	AgentToolCall,
	AgentToolCallOutcome,
	AgentToolResult,
} from "../types.ts";
import type { ToolUpdateSink } from "./events.ts";
import { type ListenerErrorReporter, reportListenerErrorToStderr } from "../listener-errors.ts";
import { AgentToolExecutionError } from "../tool-error.ts";
import { sinceMs, toolCallPhases } from "./tool-timing.ts";

export type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
	revalidate?: BeforeToolCallResult["revalidate"];
	/** Milliseconds the preparation took (validation and `beforeToolCall`, including a permission wait). */
	prepareMs?: number;
};

export type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
	prepareMs?: number;
};

/** An early attempt whose `beforeToolCall` answered `defer`: nothing ran and nothing is reported. */
export type DeferredToolCall = { kind: "deferred" };

export type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
	durationMs: number;
};

/** The `beforeToolCall`, `afterToolCall`, `unknownToolMessage` and `resolveUndeclaredTool` hooks of {@link AgentLoopConfig}. */
export type ToolCallHooks = Pick<
	AgentLoopConfig,
	"beforeToolCall" | "afterToolCall" | "unknownToolMessage" | "resolveUndeclaredTool" | "onListenerError"
>;

export async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
	tools: readonly AgentTool<any>[] = currentContext.tools ?? [],
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const prepared = await prepareCall(currentContext, assistantMessage, toolCall, config, signal, tools, false);
	if (prepared.kind === "deferred") throw new Error("Only an early call can be deferred");
	return prepared;
}

/** As {@link prepareToolCall} for a call started while its message streams: `beforeToolCall` may `defer` it. */
export function prepareEarlyToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome | DeferredToolCall> {
	return prepareCall(currentContext, assistantMessage, toolCall, config, signal, currentContext.tools ?? [], true);
}

async function prepareCall(
	...args: Parameters<typeof prepareCallUntimed>
): Promise<PreparedToolCall | ImmediateToolCallOutcome | DeferredToolCall> {
	const started = performance.now();
	const prepared = await prepareCallUntimed(...args);
	return prepared.kind === "deferred" ? prepared : { ...prepared, prepareMs: sinceMs(started) };
}

async function prepareCallUntimed(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: ToolCallHooks,
	signal: AbortSignal | undefined,
	tools: readonly AgentTool<any>[],
	early: boolean,
): Promise<PreparedToolCall | ImmediateToolCallOutcome | DeferredToolCall> {
	if (signal?.aborted) {
		return { kind: "immediate", result: createErrorToolResult("Operation aborted"), isError: true };
	}
	const tool = tools.find((t) => t.name === toolCall.name) ?? config.resolveUndeclaredTool?.(toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(config.unknownToolMessage?.(toolCall.name) ?? `Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		let validatedArgs = validateToolArguments(tool, toolCall, tool.prepareArguments?.bind(tool));
		let revalidate: PreparedToolCall["revalidate"];
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
					...(early ? { early: true as const } : {}),
				},
				signal,
			);
			if (early && beforeResult?.defer) return { kind: "deferred" };
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
			validatedArgs = validateToolArguments(tool, { ...toolCall, arguments: validatedArgs });
			revalidate = beforeResult?.revalidate;
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
			...(revalidate ? { revalidate } : {}),
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

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
	const executed = await executePreparedToolCall(
		preparation,
		signal,
		options.onUpdate ?? (() => {}),
		options.onListenerError,
	);
	return finalizeExecutedToolCall(context, assistantMessage, preparation, executed, options, signal);
}

/** How long a tool may keep running after an abort before the loop stops waiting for it, unless it declares `abortGraceMs`. */
const ABORT_GRACE_MS = 50;

const ABANDONED = Symbol("abandoned");

/** An abandoned tool may still finish its work: retrying it blindly could repeat a side effect. */
export const ABANDONED_MESSAGE =
	"Operation aborted. The tool did not stop when asked and may still be running, so its effects (a write, a command) may still happen; check the current state before retrying it.";

/**
 * Resolve with the operation's outcome, or with {@link ABANDONED} once `signal` has been aborted for `graceMs`.
 * A tool that honors the signal settles inside the grace period and keeps its own result; one that ignores it is
 * abandoned. The abandoned promise stays observed so a later rejection is never unhandled.
 */
function raceAbort<T>(
	operation: Promise<T>,
	signal: AbortSignal | undefined,
	graceMs: number,
): Promise<T | typeof ABANDONED> {
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
			}, graceMs);
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
 * Execute a prepared call. An abort ends the call within a grace period (short, unless the tool declares its own)
 * even when the tool ignores the signal: the call then reports {@link ABANDONED_MESSAGE} and the tool keeps running in the background,
 * with its late result, updates and errors discarded.
 */
export async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	onUpdate: ToolUpdateSink,
	report: ListenerErrorReporter = reportListenerErrorToStderr,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents = new Set<Promise<void>>();
	let acceptingUpdates = true;
	const startedAt = performance.now();
	const elapsed = () => Math.round(performance.now() - startedAt);
	// A listener that fails must cost neither the tool's result nor the process: the promise is held unobserved until
	// the tool ends, so an unhandled rejection would fire while it runs, and a live view is not worth a tool's work.
	const reportUpdateFailure = (error: unknown) => {
		report(`Tool update listener error (${prepared.toolCall.name}): ${String(error)}`, error);
	};

	try {
		// Not awaited without a check: a tool that starts at once must still run before the next call's thunk begins.
		const stale = prepared.revalidate
			? await raceAbort(Promise.resolve(prepared.revalidate(signal)), signal, ABORT_GRACE_MS)
			: undefined;
		if (stale === ABANDONED || stale?.block || signal?.aborted) {
			return {
				result: createErrorToolResult(
					stale !== ABANDONED && stale?.block ? stale.reason || "Tool execution was blocked" : "Operation aborted",
				),
				isError: true,
				durationMs: elapsed(),
			};
		}
		const execution = (async () =>
			prepared.tool.execute(prepared.toolCall.id, prepared.args, signal, (partialResult) => {
				if (!acceptingUpdates) return;
				try {
					const delivery = onUpdate(partialResult);
					if (delivery) {
						const event = Promise.resolve(delivery).catch(reportUpdateFailure);
						updateEvents.add(event);
						void event.then(() => updateEvents.delete(event));
					}
				} catch (error) {
					reportUpdateFailure(error);
				}
			}))();
		const result = await raceAbort(execution, signal, prepared.tool.abortGraceMs ?? ABORT_GRACE_MS);
		const durationMs = elapsed();
		acceptingUpdates = false;
		if (result === ABANDONED) {
			return { result: createErrorToolResult(ABANDONED_MESSAGE), isError: true, durationMs };
		}
		await raceAbort(Promise.all(updateEvents), signal, ABORT_GRACE_MS);
		return { result, isError: result.isError === true, durationMs };
	} catch (error) {
		const durationMs = elapsed();
		acceptingUpdates = false;
		await raceAbort(Promise.allSettled(updateEvents), signal, ABORT_GRACE_MS);
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
	const started = performance.now();

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
			result = createErrorToolResult(
				`Tool result post-processing failed: ${error instanceof Error ? error.message : String(error)}. ` +
					"Effects may already be applied; inspect state before retrying.",
			);
			isError = true;
		}
	}

	const phases = toolCallPhases({ prepareMs: prepared.prepareMs, finalizeMs: sinceMs(started) });
	return {
		toolCall: prepared.toolCall,
		result,
		isError,
		durationMs: executed.durationMs,
		...(phases ? { phases } : {}),
	};
}

export function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}
