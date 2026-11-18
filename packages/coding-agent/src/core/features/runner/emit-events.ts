/** Dispatch of session, message and tool events to feature handlers. */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { CacheWarmingAction } from "../../cache-warmer.ts";
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
import { EVENT_KINDS } from "../bus/events.ts";
import { isUserBashEventResult } from "./event-handlers.ts";
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

	for (const { feature: ext, handlers } of host.bus.snapshot(baseEvent.type)) {
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
					source: ext.path,
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
					source: ext.path,
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
	const kind = EVENT_KINDS[event.type];
	return kind === "cancel" || kind === "observe-clone";
}

export async function dispatchEvent<TEvent extends RunnerEmitEvent>(
	host: RunnerHost,
	event: TEvent,
): Promise<RunnerEmitResult<TEvent>> {
	const ctx = host.createContext();
	let result: SessionBeforeEventResult | undefined;

	for (const { feature: ext, handlers } of host.bus.snapshot(event.type)) {
		for (const handler of handlers) {
			try {
				const observing = EVENT_KINDS[event.type] === "observe-clone" && ext.owner !== "native";
				const observedEvent =
					event.type === "session_before_compact" && observing
						? {
								...event,
								preparation: structuredClone(event.preparation),
								branchEntries: structuredClone(event.branchEntries),
							}
						: event;
				const handlerResult = await handler(observedEvent, ctx);
				if (observing) continue;

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
					source: ext.path,
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

	for (const { feature: ext, handlers } of host.bus.snapshot(event.type)) {
		for (const handler of handlers) {
			try {
				const result = (await handler(event, ctx)) as CacheWarmingDecisionEventResult | undefined;
				if (result?.action !== undefined) action = result.action;
			} catch (err) {
				host.emitError({
					source: ext.path,
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

	for (const { feature: ext, handlers } of host.bus.snapshot("message_end")) {
		for (const handler of handlers) {
			try {
				const currentEvent: MessageEndEvent = { ...event, message: currentMessage };
				const handlerResult = (await handler(currentEvent, ctx)) as MessageEndEventResult | undefined;
				if (!handlerResult?.message) continue;

				if (handlerResult.message.role !== currentMessage.role) {
					host.emitError({
						source: ext.path,
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
					source: ext.path,
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

	for (const { feature: ext, handlers } of host.bus.snapshot("tool_result")) {
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
					source: ext.path,
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
	signal?: AbortSignal,
): Promise<ToolCallEventResult | undefined> {
	const ctx = host.createContext();
	// Nested tools may have a shorter deadline than the turn. Permission and hook waits must see it too.
	if (signal)
		Object.defineProperty(ctx, "signal", {
			get: () => {
				host.assertActive();
				return signal;
			},
		});
	let result: ToolCallEventResult | undefined;
	// The last result wins as before, but every execute-time check stays: a later handler must not drop a gate's recheck.
	const checks: NonNullable<ToolCallEventResult["revalidate"]>[] = [];

	for (const { handlers } of host.bus.snapshot("tool_call")) {
		for (const handler of handlers) {
			const handlerResult = (await handler(event, ctx)) as ToolCallEventResult | undefined;

			if (handlerResult) {
				result = handlerResult;
				if (result.block || result.defer) {
					return result;
				}
				if (handlerResult.revalidate) checks.push(handlerResult.revalidate);
			}
		}
	}

	if (!result || checks.length === 0) return result;
	if (checks.length === 1) return { ...result, revalidate: checks[0] };
	return {
		...result,
		revalidate: async (checkSignal) => {
			for (const check of checks) {
				const verdict = await check(checkSignal);
				if (verdict?.block) return verdict;
			}
			return undefined;
		},
	};
}

export async function dispatchUserBash(
	host: RunnerHost,
	event: UserBashEvent,
): Promise<UserBashEventResult | undefined> {
	const ctx = host.createContext();

	for (const { feature: ext, handlers } of host.bus.snapshot("user_bash")) {
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
					source: ext.path,
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
