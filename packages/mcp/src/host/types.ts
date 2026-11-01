/**
 * The slice of the host's extension contract that the MCP workspace uses, as structural types. The host's own types
 * (`ExtensionAPI`, `ExtensionContext`, `ToolDefinition`, `Theme`) satisfy them without being imported here: a separate
 * extension-contract leaf is planned, and until it exists this file is the one place the MCP workspace names the
 * host's shapes. Add a member only when MCP code uses it.
 */

import type { AgentToolResult, AgentToolUpdateCallback, EventBus } from "@octocodeai/octocode-agent-core";
import type { ModelInputLimits } from "@octocodeai/octocode-ai";
import type { AutocompleteItem, Component } from "@octocodeai/octocode-tui";
import type { Static, TSchema } from "typebox";
import type { McpServerConfig, RegisteredMcpServer } from "../servers.ts";
import type { McpPresentationMode } from "../presentation/mode.ts";

/** The colours and weights MCP renderers draw with. */
export interface McpTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** The key matching MCP views use: `matches(data, "tui.select.confirm")`. */
export interface McpKeybindings {
	matches(data: string, keybinding: string): boolean;
}

/** A dialog's optional abort signal and timeout. */
interface McpDialogOptions {
	signal?: AbortSignal;
	timeout?: number;
}

interface McpUiContext {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	select(title: string, options: string[], opts?: McpDialogOptions): Promise<string | undefined>;
	confirm(title: string, message: string, opts?: McpDialogOptions): Promise<boolean>;
	input(title: string, placeholder?: string, opts?: McpDialogOptions): Promise<string | undefined>;
}

/** The model a session runs; MCP reads only its input limits (images). */
interface McpModel {
	inputLimits?: ModelInputLimits;
}

/** Resolves a provider's API key for MCP servers with `auth.provider`. */
export interface McpModelRegistry {
	getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

/** Context passed to event handlers, tool execution and commands. */
export interface McpContext {
	ui: McpUiContext;
	mode: string;
	hasUI: boolean;
	cwd: string;
	modelRegistry: McpModelRegistry;
	model: McpModel | undefined;
	signal: AbortSignal | undefined;
	isProjectTrusted(): boolean;
}

/** Context of a slash command: the same members; the host's view runner reaches its UI through it. */
export type McpCommandContext = McpContext;

/** Tool-call render context. */
export interface McpRenderContext {
	args: unknown;
	toolCallId: string;
	invalidate: () => void;
	lastComponent: Component | undefined;
	state: any;
	cwd: string;
	executionStarted: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
	durationMs: number | undefined;
}

interface McpRenderResultOptions {
	expanded: boolean;
	isPartial: boolean;
}

/** A group of related tools: one MCP server's. */
export interface McpToolNamespace {
	name: string;
	description?: string;
	instructions?: string;
}

type McpToolExposure = "direct" | "model-only" | "hidden";

export interface McpToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, _TState = any> {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: TParams;
	validationParameters?: TSchema;
	validationHint?: (failure: { envelope: boolean }) => string | undefined;
	renderShell?: "default" | "self";
	prepareArguments?: (args: unknown) => Static<TParams>;
	outputSchema?: TSchema;
	exposure?: McpToolExposure;
	namespace?: McpToolNamespace;
	defaultActive?: boolean;
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: McpContext,
	): Promise<AgentToolResult<TDetails>>;
	renderCall?: (args: Static<TParams>, theme: McpTheme, context: McpRenderContext) => Component;
	renderResult?: (
		result: AgentToolResult<TDetails>,
		options: McpRenderResultOptions,
		theme: McpTheme,
		context: McpRenderContext,
	) => Component;
}

/**
 * Renderers as the resolver chain passes them between the host and MCP. The host's own renderers take its concrete
 * theme and context, so the chain is typed loosely: MCP calls them with the host's values, never its own.
 */
export interface McpToolRenderers {
	renderShell?: "default" | "self";
	renderCall?: (args: any, theme: any, context: any) => Component;
	renderResult?: (result: any, options: any, theme: any, context: any) => Component;
}

/** A registered tool as `getAllTools()` lists it. */
interface McpToolInfo {
	name: string;
	exposure: McpToolExposure;
	namespace?: McpToolNamespace;
}

/** Chooses how calls to a tool are drawn, including tools not yet registered. */
type McpToolRendererResolver = (
	toolName: string,
	next: () => McpToolRenderers | undefined,
) => McpToolRenderers | undefined;

interface McpRegisteredCommand {
	description?: string;
	argumentHint?: string;
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	handler: (args: string, ctx: McpCommandContext) => Promise<void>;
}

/** The extension API MCP registers its tools, commands, servers and event handlers through. */
export interface McpExtensionApi {
	on(event: string, handler: (event: any, ctx: McpContext) => unknown): void;
	registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
		tool: McpToolDefinition<TParams, TDetails, TState>,
	): void;
	registerTools?<TDetails = unknown>(tools: readonly McpToolDefinition<TSchema, TDetails>[]): void;
	registerCommand(name: string, options: McpRegisteredCommand): void;
	registerToolRenderer(resolver: McpToolRendererResolver): void;
	getActiveTools(): string[];
	getAllTools(): McpToolInfo[];
	setActiveTools(toolNames: string[]): void;
	selectsTools?(prefix: string, activeByDefault: boolean): boolean;
	getSettings?(): { mcpPresentation?: McpPresentationMode };
	getSkillDirectories(): string[];
	registerMcpServer(name: string, config: McpServerConfig): void;
	unregisterMcpServer(name: string): void;
	getMcpServers(): RegisteredMcpServer[];
	events: EventBus;
}

export type McpExtensionFactory = (api: McpExtensionApi) => void | Promise<void>;
