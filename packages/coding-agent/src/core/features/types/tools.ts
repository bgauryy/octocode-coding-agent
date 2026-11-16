/** Tool definitions, rendering and exposure. */

import type {
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolExecutionMode,
} from "@octocodeai/octocode-agent-core";
import type { ConstrainedSamplingConfig } from "@octocodeai/octocode-ai";
import type { ToolDisplay } from "@octocodeai/octocode-contracts";
import type { Component } from "@octocodeai/octocode-tui";
import type { Static, TSchema } from "typebox";
import type { Theme } from "../../../theme/theme.ts";
import type { SourceInfo } from "../../source-info.ts";
import type { ExtensionToolContext } from "./context.ts";

// Tool Types
// ============================================================================

export interface ToolRenderResultOptions {
	/** Whether the result view is expanded */
	expanded: boolean;
	/** Whether this is a partial/streaming result */
	isPartial: boolean;
}

/** What a tool's `display()` sees: the call's arguments and, once there is one, its partial or final result. */
export interface ToolDisplayInput<TArgs = any, TDetails = any> {
	toolName: string;
	args: TArgs;
	/** Absent before the first result; a partial result while `status` is `running`. */
	result?: AgentToolResult<TDetails>;
	status: "running" | "completed" | "failed";
}

/** Builds how every surface draws a call. Pure: no theme, terminal, session or clock, so a saved result replays the same. */
export type ToolDisplayFunction<TArgs = any, TDetails = any> = (
	input: ToolDisplayInput<TArgs, TDetails>,
) => ToolDisplay;

/** Context passed to tool renderers. */
export interface ToolRenderContext<TState = any, TArgs = any> {
	/** Current tool call arguments. Shared across call/result renders for the same tool call. */
	args: TArgs;
	/** Unique id for this tool execution. Stable across call/result renders for the same tool call. */
	toolCallId: string;
	/** Invalidate just this tool execution component for redraw. */
	invalidate: () => void;
	/** Previously returned component for this render slot, if any. */
	lastComponent: Component | undefined;
	/** Shared renderer state for this tool row. Initialized by tool-execution.ts. */
	state: TState;
	/** Working directory for this tool execution. */
	cwd: string;
	/** Whether the tool execution has started. */
	executionStarted: boolean;
	/** Whether the tool call arguments are complete. */
	argsComplete: boolean;
	/** Whether the tool result is partial/streaming. */
	isPartial: boolean;
	/** Whether the result view is expanded. */
	expanded: boolean;
	/** Whether inline images are currently shown in the TUI. */
	showImages: boolean;
	/** Whether the current result is an error. */
	isError: boolean;
	/**
	 * Milliseconds the tool's execution took, from the final result; `undefined` while it runs, when it did not run, or
	 * for results stored before durations were recorded.
	 */
	durationMs: number | undefined;
	/** Horizontal padding configured by the outputPad setting. Renderers with `renderShell: "self"` apply it themselves. */
	outputPad: number;
}

/**
 * How the model reaches a tool. "Callable" means callable from other tools through
 * `ctx.executeTool()`.
 *
 * - `direct`: declared to the model while active, and callable while active.
 * - `model-only`: declared to the model while active, never callable. Use it for orchestrating or
 *   interactive tools.
 * - `hidden`: registered but unreachable. Activating it has no effect.
 *
 * `direct` and `model-only` tools are activated when they are registered (unless `defaultActive` is false);
 * `hidden` tools are not. The active tool set (`getActiveTools`/`setActiveTools`) is the set declared to the model.
 */
export type ToolExposure = "direct" | "model-only" | "hidden";

/**
 * Hints about what a tool does, with the meaning of MCP tool annotations. They come from the tool's
 * author and are not verified; permission extensions can use them to decide which calls to confirm.
 */
export interface ToolAnnotations {
	/** The tool does not modify its environment. */
	readOnlyHint?: boolean;
	/** The tool may delete or overwrite data, rather than only add to it. Meaningful when not read-only. */
	destructiveHint?: boolean;
	/** Repeating a call with the same arguments has no further effect. Meaningful when not read-only. */
	idempotentHint?: boolean;
	/** The tool reaches an open world of external entities, such as the web, rather than a closed domain. */
	openWorldHint?: boolean;
}

/** One change a call makes to a file: the path as the model wrote it, and how it changes it when the tool says. */
export interface ToolChange {
	path: string;
	type?: "edit" | "write" | "delete";
	/** The part of the arguments that describes this change (its content, replacements), for guards that read it. */
	detail?: unknown;
}

/**
 * What a native tool does to the machine, declared on its definition so the permission layer reads it instead of
 * keeping a list of tool names. `read` changes nothing; `write` changes files, named by `changes`; `exec` runs a
 * program of the model's choosing; `opaque` changes things no argument names.
 */
export interface ToolEffect {
	kind: "read" | "write" | "exec" | "opaque";
	/**
	 * For `write`: the files a call changes, from its arguments. Return `undefined` when the call changes something but
	 * its targets cannot be read from the arguments; the permission layer then treats the write as unresolvable.
	 */
	changes?: (input: Record<string, unknown>) => ToolChange[] | undefined;
}

/** A group of related tools, such as the tools of one MCP server. */
interface ToolNamespace {
	/** For example `mcp__docs`. */
	name: string;
	/** Short summary shown once with the group in model-facing tool listings. */
	description?: string;
	/**
	 * Longer usage guidance, such as MCP server instructions. Not part of tool listings; tools that
	 * describe the namespace on request return it.
	 */
	instructions?: string;
}

/** The tools of a session as {@link ToolDefinition.prepareLoadout} sees them. */
export interface ToolLoadout {
	/** Tools declared to the model (the active tools), in order, with their original descriptions. */
	readonly declared: readonly AgentTool[];
	/** Tools callable through `ctx.executeTool()`. */
	readonly callable: readonly AgentTool[];
	readonly registered: readonly AgentTool[];
	getExposure(name: string): ToolExposure;
	getNamespace(name: string): ToolNamespace | undefined;
	/** A tool's `promptGuidelines`. Hidden declarations leave them out of the system prompt. */
	getPromptGuidelines(name: string): readonly string[];
}

/** Changes {@link ToolDefinition.prepareLoadout} makes to what the model sees. */
interface ToolLoadoutChanges {
	/** Model-facing descriptions of declared tools, by tool name. */
	descriptions?: Readonly<Record<string, string>>;
	/**
	 * Declared tools whose declarations requests leave out. They stay active and callable, and the
	 * transcript still declares them, so the active set survives `/tree` and resume.
	 */
	hiddenDeclarations?: readonly string[];
}

/**
 * Tool definition for registerTool().
 */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
	/** Tool name (used in LLM tool calls) */
	name: string;
	/** Human-readable label for UI */
	label: string;
	/** Description for LLM */
	description: string;
	/**
	 * One short line on what the tool is for, plus when to use it where that decides the choice between tools (how to
	 * call it belongs in the description), listed as `- name: snippet` in the `<tools>` section of the system prompt, in
	 * declaration order, with or without a custom prompt. Every native tool sets one; SDK and extension tools may. A tool
	 * without one is not listed and the section is absent when no active tool has one. MCP tools are described in
	 * `<mcps>`, so a snippet on one is ignored.
	 */
	promptSnippet?: string;
	/** Optional guideline bullets appended to the default system prompt Guidelines section when this tool is active. */
	promptGuidelines?: string[];
	/** Parameter schema (TypeBox) */
	parameters: TParams;
	/** Optional provider-side constrained sampling request for this tool. Set false to explicitly disable it, equivalent to leaving it undefined. */
	constrainedSampling?: false | ConstrainedSamplingConfig;
	/**
	 * Schema that call arguments are validated against when it differs from `parameters`: a tool declared with a thin
	 * stub keeps its exact contract here. Never sent to the provider.
	 */
	validationParameters?: TSchema;
	/**
	 * Text appended to this tool's validation failures, such as its typed signature. `envelope` is true when every
	 * problem is at the top level of the arguments. Never sent to the provider.
	 */
	validationHint?: (failure: { envelope: boolean; properties: string[] }) => string | undefined;
	/** False: arguments are validated as the model sent them and reach `execute` unchanged, with no coercion (MCP tools). */
	coerceArguments?: false;
	/**
	 * True: whether agents declare this tool depends on their role (a child may lack it), or its declaration differs
	 * between roles. It is declared after every role-invariant tool, outside the cache prefix that agents of every role
	 * share. Set it on any tool that is not given alike to every role. Never sent to the provider.
	 */
	roleVariant?: boolean;
	/** Controls whether ToolExecutionComponent renders the standard colored shell or the tool renders its own framing. */
	renderShell?: "default" | "self";

	/** Optional compatibility shim to prepare raw tool call arguments before schema validation. Must return an object conforming to TParams. */
	prepareArguments?: (args: unknown) => Static<TParams>;

	/**
	 * JSON Schema of `structuredContent` in successful results. Tools that declare it should always
	 * set `structuredContent`; programmatic tool callers then receive it instead of the text content.
	 */
	outputSchema?: TSchema;

	/**
	 * How the model reaches the tool. Default: `"direct"`. See {@link ToolExposure}.
	 */
	exposure?: ToolExposure;

	/** Group the tool belongs to, for example its MCP server. */
	namespace?: ToolNamespace;

	/** Hints about what the tool does, for example from an MCP server. */
	annotations?: ToolAnnotations;

	/** What the tool changes, read by the permission gate, the read-only role and provenance. Native tools only. */
	effect?: ToolEffect;

	/**
	 * Whether registering the tool activates it. Default: `true` for `direct` and `model-only` tools;
	 * other exposures are never activated on registration. A tool with `defaultActive: false` is
	 * activated by naming it in `--tools` or the `defaultTools` setting, or with `setActiveTools()`.
	 */
	defaultActive?: boolean;

	/**
	 * Registered but left undeclared until first use (with `defaultActive: false`): a model call to it activates it, the
	 * call runs as usual, and the next request declares it after the cached prefix. Without it, a call to an inactive
	 * tool is refused.
	 */
	onDemand?: boolean;

	/**
	 * Tools this one needs beside it: while it is active they are registered and active too, whatever `--tools`, the
	 * `defaultTools` setting or a deselection say. The operator's `--exclude-tools` and a tool policy still remove them.
	 * Honored only on native and base tools; an extension or SDK tool's companions follow the selection like any tool.
	 */
	companionTools?: readonly string[];

	/**
	 * Adjust how the loadout is presented to the model while this tool is active. Called whenever
	 * the active tools change. Tools that orchestrate other tools use it, for example to list the
	 * callable tools in their own description.
	 */
	prepareLoadout?: (loadout: ToolLoadout) => ToolLoadoutChanges | undefined;

	/**
	 * Per-tool execution mode override.
	 * - "sequential": this tool must execute one at a time with other tool calls.
	 * - "parallel": this tool can execute concurrently with other tool calls.
	 *
	 * If omitted, the default execution mode applies.
	 */
	executionMode?: ToolExecutionMode;

	/** The call's concurrency, fixed or from its validated arguments. Takes precedence over `executionMode`. */
	concurrency?: AgentTool["concurrency"];

	/** How long a call may keep running after an abort before it is abandoned, in ms. If omitted, a short default applies. */
	abortGraceMs?: number;

	/** Execute the tool. */
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ExtensionToolContext,
	): Promise<AgentToolResult<TDetails>>;

	/** How every surface (terminal, web, export, ACP) draws calls to this tool; see {@link ToolDisplayFunction}. */
	display?(input: ToolDisplayInput<Static<TParams>, TDetails>): ToolDisplay;

	/** Custom rendering for tool call display */
	renderCall?: (args: Static<TParams>, theme: Theme, context: ToolRenderContext<TState, Static<TParams>>) => Component;

	/** Custom rendering for tool result display */
	renderResult?: (
		result: AgentToolResult<TDetails>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<TState, Static<TParams>>,
	) => Component;
}

type AnyToolDefinition = ToolDefinition<any, any>;

export type ToolRenderers = Pick<AnyToolDefinition, "renderShell" | "renderCall" | "renderResult" | "display">;

/**
 * Chooses how calls to a tool are drawn, including tools that are not registered. `next()` returns
 * the renderers the remaining resolvers, then the registered tool, would use.
 */
export type ToolRendererResolver = (
	toolName: string,
	next: () => ToolRenderers | undefined,
) => ToolRenderers | undefined;

/**
 * Preserve parameter inference for standalone tool definitions.
 *
 * Use this when assigning a tool to a variable or passing it through arrays such
 * as `customTools`, where contextual typing would otherwise widen params to
 * `unknown`.
 */
export function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(
	tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition {
	return tool as ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
}

/** Tool info with name, description, parameter schema, prompt guidelines, and source metadata. */
export type ToolInfo = Pick<
	ToolDefinition,
	"name" | "description" | "parameters" | "outputSchema" | "promptGuidelines"
> & {
	exposure: ToolExposure;
	namespace?: ToolNamespace;
	annotations?: ToolAnnotations;
	sourceInfo: SourceInfo;
};
