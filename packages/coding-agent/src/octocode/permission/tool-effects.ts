import { FILE_TOOL_EFFECT } from "../tool-input/file-input.ts";
import type { ToolDefinition, ToolEffect } from "../../core/features/types.ts";

/**
 * The effect each native tool declared on its definition (`ToolDefinition.effect`), by tool name. Registration records it
 * (`declareToolEffect`); the gate, the read-only role, the isolated-tree guard, source policy and provenance read it, so a
 * new mutating tool is covered by declaring its effect and not by editing a list of names here.
 */
/**
 * Pi's single-file tools, `write` and `edit` with a `path` argument, as extensions written for Pi register them without
 * declaring an effect. A call without a readable path is undefined, so a guard treats every argument as consequential.
 */
const singleFileEffect = (type: "write" | "edit"): ToolEffect => ({
	kind: "write",
	changes: (input) =>
		typeof input.path === "string" && input.path ? [{ path: input.path, type, detail: input }] : undefined,
});

/**
 * The `file` tool starts declared, so guards that run on a bare call (no session, no registration) still see its paths;
 * so do Pi's `write` and `edit`, which an extension may register under those names with no effect of its own.
 */
const declared = new Map<string, ToolEffect>([
	["file", FILE_TOOL_EFFECT],
	["write", singleFileEffect("write")],
	["edit", singleFileEffect("edit")],
]);

/** Records the effect `tool` declares, if any, and returns the tool. */
export function declareToolEffect<T extends Pick<ToolDefinition, "name" | "effect">>(tool: T): T {
	if (tool.effect) declared.set(tool.name, tool.effect);
	return tool;
}

/** The effect the registered tool `name` declared, or undefined (an MCP tool, an extension tool or an undeclared one). */
export const toolEffect = (name: string): ToolEffect | undefined => declared.get(name);

/** Whether the tool `name` declared an effect, which is the review a native registration needs. */
export const declaresEffect = (name: string): boolean => declared.has(name);
