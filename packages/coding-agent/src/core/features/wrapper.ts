/**
 * Tool wrappers for feature-registered tools.
 *
 * These wrappers only adapt tool execution so feature tools receive the runner context.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 */

import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import type { FeatureHost } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createToolContext() for consistent context across tools and event handlers.
 */
function wrapRegisteredTool(registeredTool: RegisteredTool, runner: FeatureHost): AgentTool {
	return wrapToolDefinition(registeredTool.definition, (toolCallId, signal) =>
		runner.createToolContext(toolCallId, signal),
	);
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createToolContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: FeatureHost): AgentTool[] {
	return registeredTools.map((tool) => wrapRegisteredTool(tool, runner));
}
