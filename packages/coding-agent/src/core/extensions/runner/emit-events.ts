/** Dispatch of session, message and tool events to extension handlers. */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { CacheWarmingAction } from "../../cache-warmer.ts";
import { NATIVE_FEATURE_PATH } from "../../native-tools.ts";
import type {
	BoundaryContextPreview,
	BoundaryResult,
	CacheWarmingDecisionEvent,
	CacheWarmingDecisionEventResult,
	MessageEndEvent,
	MessageEndEventResult,
	SessionBoundaryDraft,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	UserBashEvent,
	UserBashEventResult,
} from "../types.ts";
import { isUserBashEventResult, snapshotEventHandlers } from "./event-handlers.ts";
import type {
	BoundaryBaseEvent,
	BoundaryDispatchResult,
	RunnerEmitEvent,
	RunnerEmitResult,
	RunnerHost,
	SessionBeforeEvent,
	SessionBeforeEventResult,
} from "./types.ts";

export async function dispatchBoundary(
	host: RunnerHost,
	baseEvent: BoundaryBaseEvent,
	buildContext: (entries: SessionBoundaryDraft[]) => BoundaryContextPreview | Promise<BoundaryContextPreview>,
): Promise<BoundaryDispatchResult> {
	const ctx = host.createContext();
	let entries: SessionBoundaryDraft[] = [];
	let shouldContinue = false;
	let context = await buildContext(entries);
	let valid = true;

	for (const { ext, handlers } of snapshotEventHandlers(host.extensions, baseEvent.type)) {
		for (const handler of handlers) {
			const event = {
				...baseEvent,
				entries,
				continue: shouldContinue,
				context,
			};
			try {
				const handlerResult = (await handler(event, ctx)) as BoundaryResult | undefined;
				if (handlerResult?.entries !== undefined) entries = handlerResult.entries;
				if (handlerResult?.continue !== undefined) shouldContinue = handlerResult.continue;
			} catch (err) {
				host.emitError({
					extensionPath: ext.path,
					event: baseEvent.type,
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}

			try {
				context = await buildContext(entries);
				valid = true;
			} catch (err) {
				valid = false;
				host.emitError({
					extensionPath: ext.path,
					event: baseEvent.type,
					error: `Invalid boundary entries: ${err instanceof Error ? err.message : String(err)}`,
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
	}

	return valid
		? { entries, continue: shouldContinue, context, valid: true }
		: { entries: [], continue: false, context, valid: false };
}

function isSessionBeforeEvent(event: RunnerEmitEvent): event is SessionBeforeEvent {
	return (
		event.type === "session_before_switch" ||
		event.type === "session_before_fork" ||
		event.type === "session_before_compact" ||
		event.type === "session_before_tree"
	);
}

export async function dispatchEvent<TEvent extends RunnerEmitEvent>(
	host: RunnerHost,
	event: TEvent,
): Promise<RunnerEmitResult<TEvent>> {
	const ctx = host.createContext();
	let result: SessionBeforeEventResult | undefined;

	for (const { ext, handlers } of snapshotEventHandlers(host.extensions, event.type)) {
		for (const handler of handlers) {
			try {
				const nativeCompaction = event.type === "session_before_compact" && ext.sourceInfo.path === NATIVE_FEATURE_PATH;
				const observedEvent =
					event.type === "session_before_compact" && !nativeCompaction
						? {
								...event,
								preparation: structuredClone(event.preparation),
								branchEntries: structuredClone(event.branchEntries),
							}
						: event;
				const handlerResult = await handler(observedEvent, ctx);
				if (event.type === "session_before_compact" && !nativeCompaction) continue;

				if (isSessionBeforeEvent(event) && handlerResult) {
					result = handlerResult;
					if (result.cancel) {
						return result as RunnerEmitResult<TEvent>;
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				host.emitError({
					extensionPath: ext.path,
					event: event.type,
					error: message,
					stack,
				});
			}
		}
	}

	return result as RunnerEmitResult<TEvent>;
}

/** Returns the event's own action unless a handler overrides it; the last override wins. */
export async function dispatchCacheWarmingDecision(
	host: RunnerHost,
	event: CacheWarmingDecisionEvent,
): Promise<CacheWarmingAction> {
	const ctx = host.createContext();
	let action = event.action;

	for (const { ext, handlers } of snapshotEventHandlers(host.extensions, event.type)) {
		for (const handler of handlers) {
			try {
				const result = (await handler(event, ctx)) as CacheWarmingDecisionEventResult | undefined;
				if (result?.action !== undefined) action = result.action;
			} catch (err) {
				host.emitError({
					extensionPath: ext.path,
					event: event.type,
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
	}

	return action;
}

export async function dispatchMessageEnd(host: RunnerHost, event: MessageEndEvent): Promise<AgentMessage | undefined> {
	const ctx = host.createContext();
	let currentMessage = event.message;
	let modified = false;

	for (const { ext, handlers } of snapshotEventHandlers(host.extensions, "message_end")) {
		for (const handler of handlers) {
			try {
				const currentEvent: MessageEndEvent = { ...event, message: currentMessage };
				const handlerResult = (await handler(currentEvent, ctx)) as MessageEndEventResult | undefined;
				if (!handlerResult?.message) continue;

				if (handlerResult.message.role !== currentMessage.role) {
					host.emitError({
						extensionPath: ext.path,
						event: "message_end",
						error: "message_end handlers must return a message with the same role",
					});
					continue;
				}

				currentMessage = handlerResult.message;
				modified = true;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				host.emitError({
					extensionPath: ext.path,
					event: "message_end",
					error: message,
					stack,
				});
			}
		}
	}

	return modified ? currentMessage : undefined;
}

export async function dispatchToolResult(
	host: RunnerHost,
	event: ToolResultEvent,
): Promise<ToolResultEventResult | undefined> {
	const ctx = host.createContext();
	const currentEvent: ToolResultEvent = { ...event };
	let modified = false;

	for (const { ext, handlers } of snapshotEventHandlers(host.extensions, "tool_result")) {
		for (const handler of handlers) {
			try {
				const handlerResult = (await handler(currentEvent, ctx)) as ToolResultEventResult | undefined;
				if (!handlerResult) continue;

				if (handlerResult.content !== undefined) {
					currentEvent.content = handlerResult.content;
					// Structured content that is not replaced along with the content may no longer match it.
					if (handlerResult.structuredContent === undefined) delete currentEvent.structuredContent;
					modified = true;
				}
				if (handlerResult.details !== undefined) {
					currentEvent.details = handlerResult.details;
					modified = true;
				}
				if (handlerResult.structuredContent !== undefined) {
					currentEvent.structuredContent = handlerResult.structuredContent;
					modified = true;
				}
				if (handlerResult.isError !== undefined) {
					currentEvent.isError = handlerResult.isError;
					modified = true;
				}
				if (handlerResult.usage !== undefined) {
					currentEvent.usage = handlerResult.usage;
					modified = true;
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				host.emitError({
					extensionPath: ext.path,
					event: "tool_result",
					error: message,
					stack,
				});
			}
		}
	}

	if (!modified) {
		return undefined;
	}

	return {
		content: currentEvent.content,
		details: currentEvent.details,
		structuredContent: currentEvent.structuredContent,
		isError: currentEvent.isError,
		usage: currentEvent.usage,
	};
}

export async function dispatchToolCall(
	host: RunnerHost,
	event: ToolCallEvent,
): Promise<ToolCallEventResult | undefined> {
	const ctx = host.createContext();
	let result: ToolCallEventResult | undefined;

	for (const { handlers } of snapshotEventHandlers(host.extensions, "tool_call")) {
		for (const handler of handlers) {
			const handlerResult = await handler(event, ctx);

			if (handlerResult) {
				result = handlerResult;
				if (result.block) {
					return result;
				}
			}
		}
	}

	return result;
}

export async function dispatchUserBash(
	host: RunnerHost,
	event: UserBashEvent,
): Promise<UserBashEventResult | undefined> {
	const ctx = host.createContext();

	for (const { ext, handlers } of snapshotEventHandlers(host.extensions, "user_bash")) {
		for (const handler of handlers) {
			try {
				const handlerResult = await handler(event, ctx);
				if (handlerResult === undefined) continue;
				if (!isUserBashEventResult(handlerResult)) {
					throw new Error(
						"Invalid user_bash handler result: return undefined for local execution or exactly one valid { operations } or { result } object",
					);
				}
				return handlerResult;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				host.emitError({
					extensionPath: ext.path,
					event: "user_bash",
					error: message,
					stack,
				});
				throw err;
			}
		}
	}

	return undefined;
}
