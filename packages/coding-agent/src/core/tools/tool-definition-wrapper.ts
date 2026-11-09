import { withSessionStorage } from "../../storage/runtime-paths.ts";
import { captureToolInvocation } from "./tool-invocation.ts";
import type { AgentTool } from "@octocodeai/octocode-agent-core";
import type { ExtensionToolContext, ToolDefinition } from "../features/types.ts";

/** Creates the context for one tool call. */
type ToolContextFactory = (toolCallId: string, signal: AbortSignal | undefined) => ExtensionToolContext;

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: ToolContextFactory,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		outputSchema: definition.outputSchema,
		constrainedSampling: definition.constrainedSampling,
		validationParameters: definition.validationParameters,
		validationHint: definition.validationHint,
		coerceArguments: definition.coerceArguments,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		abortGraceMs: definition.abortGraceMs,
		execute: async (toolCallId, params, signal, onUpdate, ctx?: ExtensionToolContext) => {
			const base = ctx ?? ctxFactory?.(toolCallId, signal);
			if (!base)
				return definition.execute(toolCallId, params, signal, onUpdate, base as unknown as ExtensionToolContext);
			let active = true;
			const invocation = captureToolInvocation(toolCallId, definition.name, params, () => active);
			const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(base);
			delete descriptors.invocation;
			const context = Object.defineProperties(Object.create(Object.getPrototypeOf(base)), descriptors);
			Object.defineProperty(context, "invocation", {
				enumerable: true,
				get: () => (active ? invocation : undefined),
			});
			try {
				return await withSessionStorage(base.sessionManager, () =>
					definition.execute(toolCallId, params, signal, onUpdate, context),
				);
			} finally {
				active = false;
			}
		},
	};
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		outputSchema: tool.outputSchema,
		constrainedSampling: tool.constrainedSampling,
		validationParameters: tool.validationParameters,
		validationHint: tool.validationHint,
		coerceArguments: tool.coerceArguments,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		abortGraceMs: tool.abortGraceMs,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
