/**
 * The session's tool call hooks: `tool_call` and `tool_result` extension handlers with tool result
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
import type { ExecuteToolOptions } from "../extensions/index.ts";
import { NestedToolCallRunner } from "../nested-tool-calls.ts";
import { combineUsage } from "../usage-totals.ts";
import type { SessionInternals, SessionPublic } from "./host.ts";
import { findLastAssistantMessage } from "./messages.ts";

export interface ToolCallsHost extends Pick<SessionInternals, "session" | "emit"> {
	limitsModel(): Model<any> | undefined;
	getCallableTools(): AgentTool[];
	/** Declared MCP tools whose server is still connecting. */
	pendingToolNames(): ReadonlySet<string>;
}

/**
 * The error a call to an undeclared tool gets when the session knows the tool: it is switched off for this session.
 * Unknown names keep the agent's default. A declared MCP tool whose server is still connecting is retried shortly.
 * Each text keeps the default's `Tool <name> not found` prefix, which consumers match.
 */
export function unknownToolMessage(
	session: Pick<SessionPublic, "getAllTools">,
	name: string,
	pending: ReadonlySet<string> = new Set(),
): string | undefined {
	if (pending.has(name)) return `Tool ${name} not found: its MCP server is still connecting. Retry in a moment.`;
	if (!session.getAllTools().some((candidate) => candidate.name === name)) return undefined;
	return `Tool ${name} not found: it is not active in this session. Use another tool, or ask the user to enable it.`;
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
	 * The callbacks read the session's extension runner at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	install(): void {
		const agent = this.host.session.agent;
		agent.beforeToolCall = (context, signal) => this._beforeToolCall(context, signal);
		agent.afterToolCall = (context) => this._afterToolCall(context);
		agent.unknownToolMessage = (name) => unknownToolMessage(this.host.session, name, this.host.pendingToolNames());
		agent.pendingToolNames = () => this.host.pendingToolNames();
	}

	/** `tool_call` handlers. `parentToolCallId` is set for calls another tool made. */
	private async _beforeToolCall(
		{ toolCall, args }: BeforeToolCallContext,
		signal?: AbortSignal,
		parentToolCallId?: string,
	): Promise<BeforeToolCallResult | undefined> {
		const runner = this.host.session.extensionRunner;
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
					input: args as Record<string, unknown>,
				},
				signal,
			);
		} catch (err) {
			if (err instanceof Error) {
				throw err;
			}
			throw new Error(`Extension failed, blocking execution: ${String(err)}`);
		}
	}

	/** `tool_result` handlers and image normalization. `parentToolCallId` is set for calls another tool made. */
	private async _afterToolCall(
		{ toolCall, args, result, isError }: AfterToolCallContext,
		parentToolCallId?: string,
	): Promise<AfterToolCallResult | undefined> {
		const runner = this.host.session.extensionRunner;
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
		// Runs after the extension hook so images injected or replaced by extensions are normalized too.
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
				await session.extensionRunner.emit(event);
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
