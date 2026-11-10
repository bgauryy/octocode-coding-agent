import type { Context, Message, SystemMessage, Tool, ToolReference, TranscriptContext, UserMessage } from "../types.ts";
import { contentText, getSystemMessageText, renderSystemUpdateAsUserText } from "./text.ts";

export type { TranscriptContext } from "../types.ts";

/**
 * Build the leading system message for a prompt and tool set. Returns undefined when
 * both are empty, so an empty transcript stays empty.
 */
export function createInitialSystemMessage(
	systemPrompt: string | undefined,
	tools: Tool[] | undefined,
): SystemMessage | undefined {
	const hasSystemPrompt = systemPrompt !== undefined && systemPrompt.length > 0;
	const hasTools = tools !== undefined && tools.length > 0;
	if (!hasSystemPrompt && !hasTools) return undefined;
	return {
		role: "system",
		content: systemPrompt ?? "",
		...(hasTools ? { toolsAdded: tools } : {}),
		timestamp: 0,
	};
}

/**
 * Fold `Context.systemPrompt` and `Context.tools` into a leading system message.
 * This is the only entry point that produces a {@link TranscriptContext}; every
 * provider-facing function expects the result.
 */
export function normalizeContext(context: Context): TranscriptContext {
	const initialMessage = createInitialSystemMessage(context.systemPrompt, context.tools);
	const messages = initialMessage ? [initialMessage, ...context.messages] : context.messages;
	return { messages } as TranscriptContext;
}

/**
 * Any message list. The replay helpers only read entries whose role is `"system"`, so
 * agent transcripts that carry custom message roles can be passed without filtering.
 */
export type TranscriptMessages = readonly { role: string }[];

function isSystemMessage(message: { role: string }): message is SystemMessage {
	return message.role === "system";
}

export function getInitialSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
	const first = messages[0];
	return first && isSystemMessage(first) ? first : undefined;
}

/** Drop the leading system message for APIs that carry the prompt outside the message list. */
export function withoutInitialSystemMessage(messages: Message[]): Message[] {
	return getInitialSystemMessage(messages) ? messages.slice(1) : messages;
}

/** Resolve the tools available after applying every transcript delta in order. */
export function getCurrentTools(messages: TranscriptMessages): Tool[] {
	const tools = new Map<string, Tool>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return [...tools.values()];
}

/**
 * Replay every system message into one leading system message holding the current
 * prompt and tools. Later `content` is appended to the base prompt, `sections` are
 * patched by name, and tools are resolved with {@link getCurrentTools}.
 */
export function getCurrentSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
	const content: string[] = [];
	const sections = new Map<string, string>();
	let timestamp: number | undefined;
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		timestamp ??= message.timestamp;
		const text = contentText(message.content);
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
	}
	const tools = getCurrentTools(messages);
	if (timestamp === undefined && tools.length === 0) return undefined;
	return {
		role: "system",
		content: content.join("\n\n"),
		...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
		...(tools.length > 0 ? { toolsAdded: tools } : {}),
		timestamp: timestamp ?? 0,
	};
}

/** Render the current system prompt text after replaying every system message. */
export function getCurrentSystemPrompt(messages: TranscriptMessages): string {
	const message = getCurrentSystemMessage(messages);
	return message ? getSystemMessageText(message) : "";
}

/**
 * Rebuild the transcript for APIs without mid-conversation system messages by replaying every
 * system message into one leading message. Later `content` and `sections` rewrite the leading
 * prompt, so the cached prompt prefix is lost once per patch. Prefer
 * {@link collapseSystemMessages} whenever there is a leading system message to preserve.
 */
export function foldSystemMessages(context: TranscriptContext): TranscriptContext {
	const head = getCurrentSystemMessage(context.messages);
	const messages = context.messages.filter((message) => message.role !== "system");
	return { messages: head ? [head, ...messages] : messages } as TranscriptContext;
}

/**
 * Rebuild the transcript for APIs without mid-conversation system messages while keeping the
 * leading prompt byte-identical, so a section patch (MCP connect, tool loadout, Octocode
 * section change) does not invalidate the provider's prompt prefix cache.
 *
 * The leading system message stays as written; it only takes the current tool state, because
 * these APIs send tools in one top-level field. Each later system message becomes a marked
 * user message (see {@link renderSystemUpdateAsUserText}), held back until just before the next
 * assistant message or the end of the transcript. A user turn between a tool call and its
 * result is rejected by every API this serves, and the deferral also keeps each update at a
 * position that later requests do not change. The latest update still wins because updates
 * stay in transcript order and name the sections they replace. A tool-only change produces no
 * message. Without a leading system message there is no head to preserve, so the transcript is
 * folded with {@link foldSystemMessages}.
 *
 * With {@link CollapseSystemOptions.holdAfterToolResult}, an update is held when its first chance
 * to be delivered (the next assistant or user message, or the end of the transcript) comes right
 * after a tool result, wherever it sits relative to the tool call and its results. A held update
 * that changes the prompt cannot travel as a user message, while the tools it describes change in
 * this request. It is folded into the leading message instead, together with every system message
 * before it, so the head keeps system authority over the current tools and no older update is
 * replayed after a newer one. The head is rewritten once per such update and stays the same in
 * later requests, because later messages do not change where the update was first held.
 *
 * The transcript still replays through {@link getCurrentSystemMessage}; this projection is
 * request-time only.
 */
export function collapseSystemMessages(context: TranscriptContext, options?: CollapseSystemOptions): TranscriptContext {
	const first = getInitialSystemMessage(context.messages);
	if (!first) return foldSystemMessages(context);
	const rest = context.messages.slice(1);
	if (!rest.some(isSystemMessage)) return context;
	const holdAfterToolResult = options?.holdAfterToolResult === true;
	let placed = placeSystemUpdates(rest, holdAfterToolResult, -1);
	const foldThrough = findLastPromptChange(first, rest, placed.held);
	if (foldThrough >= 0) placed = placeSystemUpdates(rest, holdAfterToolResult, foldThrough);
	const leading =
		foldThrough < 0 ? first : (getCurrentSystemMessage([first, ...rest.slice(0, foldThrough + 1)]) ?? first);

	const tools = getCurrentTools(context.messages);
	const { toolsAdded: _initialTools, ...base } = leading;
	const head: SystemMessage = { ...base, ...(tools.length > 0 ? { toolsAdded: tools } : {}) };
	return { messages: [head, ...placed.messages] } as TranscriptContext;
}

interface PlacedSystemUpdates {
	messages: Message[];
	/** Indexes in `rest` of updates whose first delivery point came right after a tool result. */
	held: Set<number>;
}

/**
 * Replay the messages after the head with each system update as a marked user message, skipping updates
 * at or before `skipThrough` (they are folded into the head). Updates are delivered before the next
 * assistant message or at the end; with `holdAfterToolResult`, a delivery point right after a tool result
 * holds them instead, and they merge into the next user message.
 */
function placeSystemUpdates(
	rest: readonly Message[],
	holdAfterToolResult: boolean,
	skipThrough: number,
): PlacedSystemUpdates {
	const messages: Message[] = [];
	const held = new Set<number>();
	let pending: { index: number; message: UserMessage }[] = [];
	// A user message directly after a tool result is illegal on strict APIs; hold the update instead.
	const canFlush = (): boolean => !holdAfterToolResult || messages.at(-1)?.role !== "toolResult";
	const reachDeliveryPoint = (): void => {
		if (!canFlush()) for (const update of pending) held.add(update.index);
	};
	const flush = (): void => {
		// Strict APIs also dislike consecutive user messages, so held updates travel as one.
		if (holdAfterToolResult && pending.length > 1) {
			const text = pending.map((update) => contentText(update.message.content)).join("\n\n");
			messages.push({ ...pending[0].message, content: text });
		} else {
			messages.push(...pending.map((update) => update.message));
		}
		pending = [];
	};
	for (const [index, message] of rest.entries()) {
		if (isSystemMessage(message)) {
			if (index <= skipThrough) continue;
			const text = renderSystemUpdateAsUserText(message);
			if (text.length > 0)
				pending.push({ index, message: { role: "user", content: text, timestamp: message.timestamp } });
			continue;
		}
		if (message.role === "user" || message.role === "assistant") reachDeliveryPoint();
		if (holdAfterToolResult && message.role === "user" && pending.length > 0) {
			messages.push(
				prependToUserMessage(
					message,
					pending.map((update) => update.message),
				),
			);
			pending = [];
			continue;
		}
		if (message.role === "assistant" && canFlush()) flush();
		messages.push(message);
	}
	reachDeliveryPoint();
	if (canFlush()) flush();
	return { messages, held };
}

export interface CollapseSystemOptions {
	/**
	 * For adapters that keep a user message from directly following a tool result (a compatibility policy, e.g.
	 * for endpoints that reject that order). An update that changes the prompt
	 * there is folded into the leading prompt with every system message before it, which costs the cached
	 * prompt prefix once per such update. Any other update that would land there is held and merged into the
	 * next user message.
	 */
	holdAfterToolResult?: boolean;
}

/**
 * Index in `rest` of the last held update that changes the prompt text, or -1. Held updates only carry
 * text (a tool-only change is never pending), and one that leaves the prompt as it was does not count.
 */
function findLastPromptChange(first: SystemMessage, rest: readonly Message[], held: ReadonlySet<number>): number {
	const systemMessages: SystemMessage[] = [first];
	let last = -1;
	for (const [index, message] of rest.entries()) {
		if (!isSystemMessage(message)) continue;
		const before = held.has(index) ? getCurrentSystemPrompt(systemMessages) : undefined;
		systemMessages.push(message);
		if (before !== undefined && getCurrentSystemPrompt(systemMessages) !== before) last = index;
	}
	return last;
}

/** Put held system updates in front of the user's own content. */
function prependToUserMessage(message: UserMessage, updates: readonly UserMessage[]): UserMessage {
	const prefix = updates.map((update) => contentText(update.content)).join("\n\n");
	const content =
		typeof message.content === "string"
			? `${prefix}\n\n${message.content}`
			: [{ type: "text" as const, text: prefix }, ...message.content];
	return { ...message, content };
}

/** Keep later system messages in place when the model accepts them; otherwise collapse them. */
export function resolveTranscript(
	context: TranscriptContext,
	supportsMidConvoSystemMessages: boolean | undefined,
	options?: CollapseSystemOptions,
): TranscriptContext {
	return supportsMidConvoSystemMessages ? context : collapseSystemMessages(context, options);
}

/** Strip executable and display-only fields from a tool before transcript comparison or persistence. */
export function toToolDeclaration(tool: Tool): Tool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters)) as Tool["parameters"],
		...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
	};
}

/**
 * Whether two tools declare the same interface to the model.
 *
 * Both sides go through {@link toToolDeclaration} first: its JSON round-trip drops the
 * typebox symbol keys and `undefined` fields that a structural comparison would see, and
 * builds both objects with the same key order, so comparing the serialized declarations
 * is exact. This avoids a deep-equal dependency in a browser-safe package.
 */
export function declarationsEqual(left: Tool, right: Tool): boolean {
	return JSON.stringify(toToolDeclaration(left)) === JSON.stringify(toToolDeclaration(right));
}

export interface ToolStateChanges {
	toolsAdded: Tool[];
	toolsRemoved: ToolReference[];
}

/** Compare two complete tool states. A changed definition is a removal followed by an addition. */
export function getToolStateChanges(previous: readonly Tool[], current: readonly Tool[]): ToolStateChanges {
	const previousTools = new Map(previous.map((tool) => [tool.name, tool]));
	const currentTools = new Map(current.map((tool) => [tool.name, tool]));
	return {
		toolsAdded: current
			.filter((tool) => {
				const previousTool = previousTools.get(tool.name);
				return previousTool === undefined || !declarationsEqual(previousTool, tool);
			})
			.map(toToolDeclaration),
		toolsRemoved: previous
			.filter((tool) => {
				const currentTool = currentTools.get(tool.name);
				return currentTool === undefined || !declarationsEqual(tool, currentTool);
			})
			.map((tool) => ({ name: tool.name })),
	};
}

/** Every definition referenced by transcript tool state, in first-declaration order. */
export function getDeclaredTools(messages: TranscriptMessages): Tool[] {
	const definitions = new Map<string, Tool>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const tool of message.toolsAdded ?? []) definitions.set(tool.name, tool);
	}
	return [...definitions.values()];
}

/** Whether tool history contains a removal or same-name redeclaration that an addition-only transport cannot replay. */
export function hasNonAdditiveToolChanges(messages: TranscriptMessages): boolean {
	return findLastNonAdditiveToolChange(messages.filter(isSystemMessage)) >= 0;
}

/** Index of the last system message with a removal or same-name redeclaration, or -1. */
function findLastNonAdditiveToolChange(systemMessages: readonly SystemMessage[]): number {
	// A name declared before counts as a redeclaration even after its removal: Kimi K3 ignores a
	// removed tool that a later tool message declares again (verified October 2026).
	const declared = new Set<string>();
	let last = -1;
	for (let index = 0; index < systemMessages.length; index++) {
		const message = systemMessages[index];
		if ((message.toolsRemoved?.length ?? 0) > 0) last = index;
		for (const tool of message.toolsAdded ?? []) {
			if (declared.has(tool.name)) last = index;
			declared.add(tool.name);
		}
	}
	return last;
}

/**
 * How a transport can express tool changes after the first request.
 *
 * - `"none"`: only the top-level tool list exists; it always holds the current tools.
 * - `"additions"`: tools can be added at a later message, but not removed or redefined.
 * - `"changes"`: every tool, including the initial ones, is declared in place, and a later
 *   declaration under the same name replaces the earlier one. Removals are not expressible on
 *   the wire, so the transport announces them as text and the removed tools stay declared.
 */
export type TranscriptToolSupport = "none" | "additions" | "changes";

export interface TranscriptTools {
	/** Tools sent in the top-level request field. */
	requestTools: Tool[];
	/**
	 * Number of leading system messages whose tool changes `requestTools` already holds. Every
	 * later system message carries its own tool changes in place.
	 */
	foldedSystemMessages: number;
}

/**
 * Split tool declarations between the top-level request field and in-place changes.
 *
 * With `"changes"`, the top-level list stays empty and every system message, including the
 * leading one, declares its tools in place: an in-place declaration can replace an earlier
 * in-place one, but not a top-level one. With `"additions"`, a removal or redefinition cannot be
 * expressed in place, so the top-level list becomes the tool state after the last such change;
 * later additions stay anchored, and the cached prefix is invalidated once per removal instead
 * of on every later addition. With `"none"`, the top-level list is the current tool set.
 */
export function resolveTranscriptTools(messages: TranscriptMessages, support: TranscriptToolSupport): TranscriptTools {
	const systemMessages = messages.filter(isSystemMessage);
	if (support === "none") {
		return { requestTools: getCurrentTools(systemMessages), foldedSystemMessages: systemMessages.length };
	}
	if (support === "changes") return { requestTools: [], foldedSystemMessages: 0 };
	const folded = Math.max(getInitialSystemMessage(messages) ? 1 : 0, findLastNonAdditiveToolChange(systemMessages) + 1);
	return { requestTools: getCurrentTools(systemMessages.slice(0, folded)), foldedSystemMessages: folded };
}
