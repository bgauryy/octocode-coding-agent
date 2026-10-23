/** Dispatch of the events whose handlers transform a request, a prompt or user input. */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { ImageContent, ProviderHeaders } from "@octocodeai/octocode-ai";
import {
	type BuildSystemPromptOptions,
	buildSystemPrompt,
	normalizeBuildSystemPromptOptions,
} from "../../system-prompt.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	ContextEvent,
	ContextEventResult,
	ContextWithSystemEvent,
	ExtensionContext,
	InputEvent,
	InputEventResult,
	InputSource,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	UserInputEvent,
	UserInputEventResult,
} from "../types.ts";
import { restoreSystemMessages, sameMessages, snapshotEventHandlers } from "./event-handlers.ts";
import type { BeforeAgentStartCombinedResult, BeforeAgentStartTrigger, RunnerHost } from "./types.ts";

/**
 * Run the request-time transforms in two phases. `context` handlers see the conversation
 * only and Pi restores the prompt and tool state after each; `context_with_system`
 * handlers then see the full transcript and their output is used as returned.
 */
export async function dispatchContext(host: RunnerHost, messages: AgentMessage[]): Promise<AgentMessage[]> {
	const ctx = host.createContext();
	let currentMessages = structuredClone(messages);

	for (const { ext, handlers } of snapshotEventHandlers(host.extensions, "context")) {
		for (const handler of handlers) {
			try {
				const visibleMessages = currentMessages.filter((message) => message.role !== "system");
				const visibleSnapshot = visibleMessages.slice();
				const event: ContextEvent = { type: "context", messages: visibleMessages };
				const handlerResult = (await handler(event, ctx)) as ContextEventResult | undefined;

				// Handlers may return a new list or edit event.messages in place.
				const returned =
					handlerResult?.messages ?? (sameMessages(visibleMessages, visibleSnapshot) ? undefined : visibleMessages);
				if (!returned) continue;
				currentMessages = restoreSystemMessages(currentMessages, visibleSnapshot, returned);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				host.emitError({
					extensionPath: ext.path,
					event: "context",
					error: message,
					stack,
				});
			}
		}
	}

	for (const { ext, handlers } of snapshotEventHandlers(host.extensions, "context_with_system")) {
		for (const handler of handlers) {
			try {
				const hadLeadingSystemMessage = currentMessages[0]?.role === "system";
				const event: ContextWithSystemEvent = { type: "context_with_system", messages: currentMessages };
				const handlerResult = (await handler(event, ctx)) as ContextEventResult | undefined;
				currentMessages = handlerResult?.messages ?? currentMessages;
				// Providers read the prompt and initial tools from the leading system message.
				// Losing it is never intended; report it but honor the handler's output.
				if (hadLeadingSystemMessage && currentMessages[0]?.role !== "system") {
					host.emitError({
						extensionPath: ext.path,
						event: "context_with_system",
						error:
							"Handler removed the leading system message; the request has no prompt or initial tool declarations. Keep it at index 0 or replace a dropped prefix with getCurrentSystemMessage().",
					});
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				host.emitError({
					extensionPath: ext.path,
					event: "context_with_system",
					error: message,
					stack,
				});
			}
		}
	}

	return currentMessages;
}

export async function dispatchBeforeProviderRequest(host: RunnerHost, payload: unknown): Promise<unknown> {
	const ctx = host.createContext();
	let currentPayload = payload;

	for (const { ext, handlers } of snapshotEventHandlers(host.extensions, "before_provider_request")) {
		for (const handler of handlers) {
			try {
				const event: BeforeProviderRequestEvent = {
					type: "before_provider_request",
					payload: currentPayload,
				};
				const handlerResult = await handler(event, ctx);
				if (handlerResult !== undefined) {
					currentPayload = handlerResult;
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				host.emitError({
					extensionPath: ext.path,
					event: "before_provider_request",
					error: message,
					stack,
				});
			}
		}
	}

	return currentPayload;
}

export async function dispatchBeforeProviderHeaders(
	host: RunnerHost,
	headers: ProviderHeaders,
): Promise<ProviderHeaders> {
	const ctx = host.createContext();

	for (const { ext, handlers } of snapshotEventHandlers(host.extensions, "before_provider_headers")) {
		for (const handler of handlers) {
			try {
				// Handlers mutate `headers` in place; the return value is ignored.
				const event: BeforeProviderHeadersEvent = {
					type: "before_provider_headers",
					headers,
				};
				await handler(event, ctx);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				host.emitError({
					extensionPath: ext.path,
					event: "before_provider_headers",
					error: message,
					stack,
				});
			}
		}
	}

	return headers;
}

export async function dispatchBeforeAgentStart(
	host: RunnerHost,
	trigger: BeforeAgentStartTrigger,
	systemPromptOptions: BuildSystemPromptOptions,
): Promise<BeforeAgentStartCombinedResult> {
	const currentOptions = normalizeBuildSystemPromptOptions(systemPromptOptions);
	const renderCurrentSystemPrompt = (): string => buildSystemPrompt(currentOptions);
	const ctx = Object.defineProperties({}, Object.getOwnPropertyDescriptors(host.createContext())) as ExtensionContext;
	ctx.getSystemPrompt = () => {
		host.assertActive();
		return renderCurrentSystemPrompt();
	};
	const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];

	for (const { ext, handlers } of snapshotEventHandlers(host.extensions, "before_agent_start")) {
		for (const handler of handlers) {
			try {
				const event: BeforeAgentStartEvent = {
					...trigger,
					type: "before_agent_start",
					get systemPrompt() {
						return renderCurrentSystemPrompt();
					},
					systemPromptOptions: currentOptions,
				};
				const handlerResult = await handler(event, ctx);

				if (handlerResult) {
					const result = handlerResult as BeforeAgentStartEventResult;
					if (result.message) messages.push(result.message);
					if (result.systemPrompt !== undefined) {
						currentOptions.forceSystemPrompt = result.systemPrompt;
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				host.emitError({
					extensionPath: ext.path,
					event: "before_agent_start",
					error: message,
					stack,
				});
			}
		}
	}

	return { messages, systemPromptOptions: currentOptions };
}

export async function dispatchResourcesDiscover(
	host: RunnerHost,
	cwd: string,
	reason: ResourcesDiscoverEvent["reason"],
): Promise<{
	skillPaths: Array<{ path: string; extensionPath: string }>;
	promptPaths: Array<{ path: string; extensionPath: string }>;
	themePaths: Array<{ path: string; extensionPath: string }>;
}> {
	const ctx = host.createContext();
	const skillPaths: Array<{ path: string; extensionPath: string }> = [];
	const promptPaths: Array<{ path: string; extensionPath: string }> = [];
	const themePaths: Array<{ path: string; extensionPath: string }> = [];

	for (const { ext, handlers } of snapshotEventHandlers(host.extensions, "resources_discover")) {
		for (const handler of handlers) {
			try {
				const event: ResourcesDiscoverEvent = { type: "resources_discover", cwd, reason };
				const handlerResult = await handler(event, ctx);
				const result = handlerResult as ResourcesDiscoverResult | undefined;

				if (result?.skillPaths?.length) {
					skillPaths.push(...result.skillPaths.map((path) => ({ path, extensionPath: ext.path })));
				}
				if (result?.promptPaths?.length) {
					promptPaths.push(...result.promptPaths.map((path) => ({ path, extensionPath: ext.path })));
				}
				if (result?.themePaths?.length) {
					themePaths.push(...result.themePaths.map((path) => ({ path, extensionPath: ext.path })));
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				host.emitError({
					extensionPath: ext.path,
					event: "resources_discover",
					error: message,
					stack,
				});
			}
		}
	}

	return { skillPaths, promptPaths, themePaths };
}

export async function dispatchUserInput(host: RunnerHost, event: UserInputEvent): Promise<UserInputEventResult> {
	const ctx = host.createContext();
	const combined: UserInputEventResult = { additionalContext: [] };
	for (const { ext, handlers } of snapshotEventHandlers(host.extensions, "user_input")) {
		for (const handler of handlers) {
			if (ctx.signal?.aborted) return combined;
			try {
				const result = (await handler(event, ctx)) as UserInputEventResult | undefined;
				combined.block ||= result?.block;
				combined.additionalContext!.push(...(result?.additionalContext ?? []));
			} catch (error) {
				host.emitError({
					extensionPath: ext.path,
					event: "user_input",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	return combined;
}

/** Emit input event. Transforms chain, "handled" short-circuits. */
export async function dispatchInput(
	host: RunnerHost,
	text: string,
	images: ImageContent[] | undefined,
	source: InputSource,
	streamingBehavior?: "steer" | "followUp",
): Promise<InputEventResult> {
	const ctx = host.createContext();
	let currentText = text;
	let currentImages = images;

	for (const { ext, handlers } of snapshotEventHandlers(host.extensions, "input")) {
		for (const handler of handlers) {
			try {
				const event: InputEvent = {
					type: "input",
					text: currentText,
					images: currentImages,
					source,
					streamingBehavior,
				};
				const result = (await handler(event, ctx)) as InputEventResult | undefined;
				if (result?.action === "handled") return result;
				if (result?.action === "transform") {
					currentText = result.text;
					currentImages = result.images ?? currentImages;
				}
			} catch (err) {
				host.emitError({
					extensionPath: ext.path,
					event: "input",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
	}
	return currentText !== text || currentImages !== images
		? { action: "transform", text: currentText, images: currentImages }
		: { action: "continue" };
}
