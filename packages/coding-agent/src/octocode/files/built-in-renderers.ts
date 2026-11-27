import type { ToolRenderers } from "../../core/features/types.ts";
import { renderBashCall, renderBashResult } from "./render.ts";

/**
 * The shell row of the core `bash` tool, when no feature replaced it: the native header and result, so a session
 * without native features draws the same shell grammar. Nothing wraps the core tool in `timed`, so no run start is
 * recorded for its call id: the row times itself from its first drawn frame.
 */
const CORE_SHELL: ToolRenderers = {
	renderCall: (args, theme, context) =>
		renderBashCall(args as Parameters<typeof renderBashCall>[0], theme, { ...context, toolCallId: undefined }),
	renderResult: (result, options, theme, context) =>
		renderBashResult(result, options, theme, { ...context, toolCallId: undefined }),
};

/**
 * `definition` with the built-in renderers filled in where it supplies none. Callers (the terminal transcript and the
 * HTML export) do this lookup, not `ToolExecutionComponent`, so a process that renders imports the renderers alone,
 * without the tool implementations.
 */
export function withBuiltInRenderers<TDefinition extends ToolRenderers>(
	toolName: string,
	definition: TDefinition | undefined,
): TDefinition | ToolRenderers | undefined {
	// `bash` is the only core tool with a renderer; other built-in tools render through the generic renderer.
	const builtIn = toolName === "bash" ? CORE_SHELL : undefined;
	if (!definition) return builtIn;
	if (!builtIn) return definition;
	return {
		...definition,
		renderCall: definition.renderCall ?? builtIn.renderCall,
		renderResult: definition.renderResult ?? builtIn.renderResult,
	};
}
