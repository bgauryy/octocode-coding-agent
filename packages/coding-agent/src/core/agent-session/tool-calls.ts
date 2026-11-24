/**
 * The session's tool call hooks: `tool_call` and `tool_result` feature handlers with tool result
 * image normalization, and the calls tools make through `ctx.executeTool()`.
 */

import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	type AgentEvent,
	type AgentTool,
	type AgentToolCallOutcome,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	runToolCall,
} from "@octocodeai/octocode-agent-core";
import type { Model } from "@octocodeai/octocode-ai/compat";
import { normalizeToolResultImages } from "../../utils/tool-result-images.ts";
import type { ExecuteToolOptions } from "../features/index.ts";
import type { ToolInfo } from "../features/types.ts";
import { NestedToolCallRunner } from "../nested-tool-calls.ts";
import { combineUsage } from "../usage-totals.ts";
import type { SessionInternals, SessionPublic } from "./host.ts";
import { findLastAssistantMessage } from "./messages.ts";

export interface ToolCallsHost extends Pick<SessionInternals, "session" | "emit"> {
	limitsModel(): Model<any> | undefined;
	getCallableTools(): AgentTool[];
	/** Activate a registered on-demand tool the model called undeclared (`activateOnDemand`). */
	resolveUndeclaredTool(name: string): AgentTool | undefined;
	/** Declared MCP tools whose server is still connecting. */
	pendingToolNames(): ReadonlySet<string>;
	/** Tools switched off that the transcript still declares (`HeldTools`); a call to one is refused. */
	heldToolNames?(): ReadonlySet<string>;
	/** The refusal text for a call to a held tool, after `Tool <name> not found: `. */
	heldToolRefusal?(name: string): string | undefined;
}

/**
 * Tools this version removed, with what replaces each: a model that still calls one (from a replayed session, a saved
 * profile or habit) learns it is gone instead of being told to ask for it. The text follows `Tool <name> not found: `.
 */
const REMOVED_TOOLS: ReadonlyMap<string, string> = new Map([
	[
		"steps",
		"it was removed. Keep the steps of an item in its plan (backlogPlan edit) and record progress with backlog note.",
	],
]);

const MCP_NAME = /^mcp__(.+?)__(.+)$/;

/** A bare MCP tool name, or a native tool name with a server prefix glued on: the registered name to call instead. */
function prefixMistake(tools: readonly Pick<ToolInfo, "name">[], name: string): string | undefined {
	const names = tools.map((tool) => tool.name);
	const suffixOf = (full: string) => MCP_NAME.exec(full)?.[2];
	const full = names.filter((candidate) => suffixOf(candidate) === name);
	if (full.length === 1) return `Tool ${name} not found: call it as ${full[0]}.`;
	if (full.length > 1) return `Tool ${name} not found: call it by its full name, one of ${full.join(", ")}.`;
	const glued = suffixOf(name);
	if (glued !== undefined && names.includes(glued) && suffixOf(glued) === undefined)
		return `Tool ${name} not found: \`${glued}\` is a native tool, not an MCP tool: call it as ${glued}.`;
	return undefined;
}

/**
 * The error a call to an undeclared tool gets when the session knows the tool: it is switched off for this session.
 * A removed tool names its replacement, unless a feature or MCP server registered a tool of that name. Other unknown
 * names keep the agent's default. A declared MCP tool whose server is still connecting is retried shortly.
 * Each text keeps the default's `Tool <name> not found` prefix, which consumers match.
 */
export function unknownToolMessage(
	session: Pick<SessionPublic, "getAllTools">,
	name: string,
	pending: ReadonlySet<string> = new Set(),
): string | undefined {
	if (pending.has(name)) return `Tool ${name} not found: its MCP server is still connecting. Retry in a moment.`;
	const tools = session.getAllTools();
	if (!tools.some((candidate) => candidate.name === name)) {
		const removed = REMOVED_TOOLS.get(name);
		return removed ? `Tool ${name} not found: ${removed}` : (prefixMistake(tools, name) ?? undefined);
	}
	return `Tool ${name} not found: it is not active in this session. Use another tool, or ask the user to enable it.`;
}

/** What `activateOnDemand` reads and changes of the loadout. */
export interface OnDemandLoadout {
	getToolDefinition(name: string): { onDemand?: boolean } | undefined;
	getActiveToolNames(): string[];
	setActiveTools(names: string[]): void;
	/** The tools the agent declares now. */
	declared(): readonly AgentTool[];
}

/**
 * A call to a registered `onDemand` tool the request did not declare activates it and runs: the loadout adds it, so the
 * next request declares it after the cached prefix. Undefined for any other name, or when the tool policy or `--tools`
 * keeps it inactive.
 */
export function activateOnDemand(loadout: OnDemandLoadout, name: string): AgentTool | undefined {
	if (loadout.getToolDefinition(name)?.onDemand !== true) return undefined;
	const active = loadout.getActiveToolNames();
	if (!active.includes(name)) loadout.setActiveTools([...active, name]);
	return loadout.declared().find((tool) => tool.name === name);
}

export class SessionToolCalls {
	/** Created on the first `ctx.executeTool()` call. */
	private _nestedToolCalls: NestedToolCallRunner | undefined;

	private readonly host: ToolCallsHost;

	constructor(host: ToolCallsHost) {
		this.host = host;
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read the session's feature runner at execution time, so feature reload swaps in the
	 * new runner without reinstalling hooks. Feature-specific tool wrappers are still used to adapt
	 * registered tool execution to the feature context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	install(): void {
		const agent = this.host.session.agent;
		agent.beforeToolCall = (context, signal) => this._beforeToolCall(context, signal);
		agent.afterToolCall = (context) => this._afterToolCall(context);
		agent.unknownToolMessage = (name) => {
			const held = this.host.heldToolRefusal?.(name);
			return held === undefined
				? unknownToolMessage(this.host.session, name, this.host.pendingToolNames())
				: `Tool ${name} not found: ${held}`;
		};
		// Declared but not executable: servers still connecting and held tools stay declared.
		agent.pendingToolNames = () => new Set([...this.host.pendingToolNames(), ...(this.host.heldToolNames?.() ?? [])]);
		agent.resolveUndeclaredTool = (name) => this.host.resolveUndeclaredTool(name);
		// `toolExecution.earlyStart`: the features decide which calls may start while the message streams (no dialog).
		agent.earlyStart = {
			mayStart: (toolCall) =>
				this.host.session.settingsManager.getToolExecutionEarlyStart() &&
				this.host.session.featureHost.mayStartToolCallEarly({
					origin: "model",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: toolCall.arguments,
				}),
			onDiscarded: (toolCallId) => this.host.session.featureHost.toolCallDiscarded(toolCallId),
		};
	}

	/** `tool_call` handlers. `parentToolCallId` is set for calls another tool made. */
	private async _beforeToolCall(
		{ toolCall, args, early }: BeforeToolCallContext,
		signal?: AbortSignal,
		parentToolCallId?: string,
	): Promise<BeforeToolCallResult | undefined> {
		const runner = this.host.session.featureHost;
		if (!runner.hasHandlers("tool_call")) {
			return undefined;
		}

		try {
			return await runner.emitToolCall(
				{
					type: "tool_call",
					origin: parentToolCallId ? "tool" : "model",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					...(parentToolCallId ? { parentToolCallId } : {}),
					...(early ? { early } : {}),
					input: args as Record<string, unknown>,
				},
				signal,
			);
		} catch (err) {
			if (err instanceof Error) {
				throw err;
			}
			throw new Error(`Feature failed, blocking execution: ${String(err)}`, { cause: err });
		}
	}

	/** `tool_result` handlers and image normalization. `parentToolCallId` is set for calls another tool made. */
	private async _afterToolCall(
		{ toolCall, args, result, isError }: AfterToolCallContext,
		parentToolCallId?: string,
	): Promise<AfterToolCallResult | undefined> {
		const runner = this.host.session.featureHost;
		const hookResult = runner.hasHandlers("tool_result")
			? await runner.emitToolResult({
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					...(parentToolCallId ? { parentToolCallId } : {}),
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
					isError,
					usage: result.usage,
				})
			: undefined;

		const content = hookResult?.content ?? result.content ?? [];
		// Runs after the feature hook so images injected or replaced by features are normalized too.
		const resizeOptions = this.host.limitsModel()?.inputLimits?.images?.resize;
		const normalizedContent = await normalizeToolResultImages(content, {
			autoResizeImages: this.host.session.settingsManager.getImageAutoResize(),
			...(resizeOptions ? { resizeOptions } : {}),
		});

		if (!hookResult && normalizedContent === content) {
			return undefined;
		}

		// The hook result already dropped structured content that replaced content no longer matches.
		return {
			content: normalizedContent,
			details: hookResult?.details,
			structuredContent: hookResult ? hookResult.structuredContent : result.structuredContent,
			isError: hookResult?.isError ?? isError,
			usage: hookResult?.usage,
		};
	}

	/**
	 * Run a call that the tool call `parentToolCallId` made through `ctx.executeTool()`. It goes
	 * through the agent's tool pipeline with the session's hooks, against the callable tools.
	 */
	async executeNested(
		parentToolCallId: string,
		name: string,
		args: unknown,
		options: ExecuteToolOptions,
	): Promise<AgentToolCallOutcome> {
		const { session } = this.host;
		this._nestedToolCalls ??= new NestedToolCallRunner({
			getTools: () => this.host.getCallableTools(),
			isSequential: () => session.agent.toolExecution === "sequential",
			runToolCall: (toolCall, parentId, signal, onUpdate) => {
				const assistantMessage = findLastAssistantMessage(session.agent.state.messages);
				if (!assistantMessage) {
					return Promise.resolve({
						toolCall,
						result: {
							content: [{ type: "text", text: "No assistant message issued this call" }],
							details: {},
						},
						isError: true,
					});
				}
				return runToolCall(toolCall, {
					tools: this.host.getCallableTools(),
					assistantMessage,
					context: {
						messages: session.agent.state.messages,
						tools: session.agent.state.tools,
					},
					beforeToolCall: (context, callSignal) => this._beforeToolCall(context, callSignal, parentId),
					afterToolCall: (context) => this._afterToolCall(context, parentId),
					signal,
					onUpdate,
				});
			},
			emit: async (event) => {
				await session.featureHost.emit(event);
				this.host.emit(event);
			},
		});
		return this._nestedToolCalls.execute(parentToolCallId, name, args, options);
	}

	/** Record the calls a tool made through ctx.executeTool() and their usage on its result message. */
	recordNestedCalls(event: AgentEvent): void {
		if (!this._nestedToolCalls) return;
		if (event.type === "message_start" && event.message.role === "toolResult") {
			const message = event.message;
			const summary = this._nestedToolCalls.takeRecord(message.toolCallId);
			if (summary?.calls) message.nestedCalls = summary.calls;
			if (summary?.usage) {
				message.usage = message.usage ? combineUsage(message.usage, summary.usage) : summary.usage;
			}
		} else if (event.type === "agent_end") {
			this._nestedToolCalls.clear();
		}
	}
}
