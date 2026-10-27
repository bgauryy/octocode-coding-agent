/** The session's allowed tools, model declarations, `prepareLoadout` hooks and resulting system prompt. */

import type { AgentMessage, AgentTool } from "@octocodeai/octocode-agent-core";
import { getCurrentSystemMessage } from "@octocodeai/octocode-ai";
import type { SystemMessage } from "@octocodeai/octocode-ai/compat";
import {
	type ToolDefinition,
	type ToolExposure,
	type ToolInfo,
	type ToolLoadout,
	wrapRegisteredTools,
} from "../extensions/index.ts";
import { createToolNameMatcher, isMcpToolName } from "../../../../mcp/src/servers.ts";
import { NATIVE_FEATURE_PATH } from "../native-tools.ts";
import { applyToolModifiers } from "../settings-manager.ts";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	diffSystemPromptSections,
	type NormalizedBuildSystemPromptOptions,
	normalizeBuildSystemPromptOptions,
} from "../system-prompt.ts";
import type { SessionInternals } from "./host.ts";
import { buildToolDefinitionRegistry, orderToolNames } from "./tool-definitions.ts";
import { PendingMcpTools } from "./pending-mcp-tools.ts";
import type { ToolDefinitionEntry } from "./types.ts";
import { errorMessage } from "../../utils/guards.ts";

export interface ToolLoadoutOptions {
	customTools?: ToolDefinition[];
	allowedToolNames?: string[];
	excludedToolNames?: string[];
}

export class SessionToolLoadout {
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	/**
	 * Tools of the restored or reloaded loadout that are not registered yet. They are activated when
	 * registered, and dropped when `setActiveToolsByName()` deactivates a tool or the next run starts,
	 * except MCP tools of servers still connecting, which `pendingMcp` keeps until registered or settled.
	 */
	private _pendingToolNames = new Set<string>();
	readonly pendingMcp = new PendingMcpTools();
	/** Matches the `--tools` entries: tool names or patterns. */
	private _allowedTools?: (name: string) => boolean;
	/** Whether the allowlist filters MCP tools: it is empty (`--no-tools`) or names an `mcp__*` tool. */
	private _allowlistFiltersMcp = false;
	private _excludedTools?: (name: string) => boolean;
	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	/** Declared tools whose declarations requests leave out, from `prepareLoadout` hooks. */
	private _hiddenDeclarations: ReadonlySet<string> = new Set();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();
	private _toolPolicy?: (name: string) => boolean;
	private _policyRequestedTools: string[] = [];

	baseSystemPromptOptions!: NormalizedBuildSystemPromptOptions;
	/** Prompt options after before_agent_start mutations for the active run. */
	runSystemPromptOptions?: NormalizedBuildSystemPromptOptions;

	private readonly host: Pick<SessionInternals, "session" | "cwd">;

	constructor(host: Pick<SessionInternals, "session" | "cwd">, options: ToolLoadoutOptions) {
		this.host = host;
		this._customTools = options.customTools ?? [];
		if (options.allowedToolNames) {
			this._allowedTools = createToolNameMatcher(options.allowedToolNames);
			this._allowlistFiltersMcp =
				options.allowedToolNames.length === 0 || options.allowedToolNames.some((entry) => entry.startsWith("mcp__"));
		}
		this._excludedTools = options.excludedToolNames ? createToolNameMatcher(options.excludedToolNames) : undefined;
	}

	get hiddenDeclarations(): ReadonlySet<string> {
		return this._hiddenDeclarations;
	}

	/** Current effective system prompt, including changes not yet sent to the model. */
	get systemPrompt(): string {
		return buildSystemPrompt(this.runSystemPromptOptions ?? this.baseSystemPromptOptions);
	}

	setBaseToolDefinitions(definitions: Map<string, ToolDefinition>): void {
		this._baseToolDefinitions = definitions;
	}

	/** Tool names the user named: the active tools under `--tools`, otherwise the `+name` modifiers. */
	explicitToolNames(defaultToolModifiers: readonly string[]): string[] {
		return this._allowedTools
			? this.host.session.getActiveToolNames()
			: defaultToolModifiers.filter((entry) => entry.startsWith("+")).map((entry) => entry.slice(1));
	}

	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
			promptGuidelines: definition.promptGuidelines,
			exposure: this._getToolExposure(definition.name),
			...(definition.namespace ? { namespace: definition.namespace } : {}),
			...(definition.annotations ? { annotations: { ...definition.annotations } } : {}),
			...(definition.reachesTools ? { reachesTools: definition.reachesTools } : {}),
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	setActiveToolsByName(toolNames: string[]): void {
		const { session } = this.host;
		const previous = session.getActiveToolNames();
		this.setActiveTools(toolNames);
		// A loadout that deactivates a tool replaces the restored one, whose pending tools are dropped.
		// One that only adds tools, like activating tool_search, keeps them.
		const active = new Set(session.getActiveToolNames());
		if (previous.some((name) => !active.has(name))) this._pendingToolNames.clear();
	}

	setActiveTools(toolNames: string[]): void {
		this._policyRequestedTools = [...toolNames];
		const tools = this._applyToolLoadout(toolNames);
		for (const tool of tools) this._pendingToolNames.delete(tool.name);
		this.rebuildSystemPrompt(tools.map((tool) => tool.name));
	}

	setToolPolicy(allows: ((name: string) => boolean) | undefined): void {
		this._toolPolicy = allows;
		this.setActiveTools(
			this._policyRequestedTools.length ? this._policyRequestedTools : this.host.session.getActiveToolNames(),
		);
	}

	/** Drop the tool policy for a reload and return the tools to activate on the reloaded runtime. */
	resetToolPolicy(): string[] {
		const policyRequestedTools = this._toolPolicy
			? [...this._policyRequestedTools]
			: this.host.session.getActiveToolNames();
		this._toolPolicy = undefined;
		return policyRequestedTools;
	}

	/** Keep the active tools pending, so tools registered later by reloaded extensions become active again. */
	markActiveToolsPending(): void {
		for (const name of this.host.session.getActiveToolNames()) this._pendingToolNames.add(name);
	}

	/** Declared MCP tools kept pending until their server registers them; the model's declarations keep them. */
	pendingMcpToolNames = (): ReadonlySet<string> => new Set([...this._pendingToolNames].filter(isMcpToolName));

	settlePendingToolNames(): void {
		this.pendingMcp.retain(() => this._pendingToolNames, this.host.session.resourceLoader.getEventBus?.());
	}

	/**
	 * Whether `--tools` and `--exclude-tools` keep the tool registered. MCP tools stay registered
	 * unless the allowlist filters them (see `_allowlistFiltersMcp`).
	 */
	private _isAllowedTool(name: string): boolean {
		if (this._excludedTools?.(name)) return false;
		if (!this._allowedTools || this._allowedTools(name)) return true;
		return !this._allowlistFiltersMcp && isMcpToolName(name);
	}

	/**
	 * Whether the tool may be active, which declares it to the model. MCP tools the allowlist keeps
	 * without matching them are only for tool_search: they may be declared only when
	 * tool_search can load them (non-`direct` exposure and tool_search registered). This also applies
	 * to tools restored from the transcript or set by extensions.
	 */
	private _isActivatable(name: string): boolean {
		if (this._toolPolicy && !this._toolPolicy(name)) return false;
		if (!this._allowedTools || this._allowedTools(name) || !isMcpToolName(name)) return true;
		return this._getToolExposure(name) !== "direct" && this._toolRegistry.has("tool_search");
	}

	/** Registered `deferred` tools the model can load, which needs an active `tool_search`. */
	private _getLoadableDeferredToolNames(activeToolNames: readonly string[]): string[] {
		if (!activeToolNames.includes("tool_search")) return [];
		return [...this._toolRegistry.keys()].filter(
			(name) => this._getToolExposure(name) === "deferred" && (!this._toolPolicy || this._toolPolicy(name)),
		);
	}

	private _getToolExposure(name: string): ToolExposure {
		return this._toolDefinitions.get(name)?.definition.exposure ?? "direct";
	}

	/**
	 * Tools callable through `ctx.executeTool()`: the active `direct` tools and every registered
	 * `deferred` tool.
	 */
	getCallableTools(active: ReadonlySet<string> = new Set(this.host.session.getActiveToolNames())): AgentTool[] {
		return [...this._toolRegistry.values()].filter((tool) => {
			if (this._toolPolicy && !this._toolPolicy(tool.name)) return false;
			const exposure = this._getToolExposure(tool.name);
			return exposure === "deferred" || (exposure === "direct" && active.has(tool.name));
		});
	}

	/**
	 * Set the agent's tools for the given active tool names and return them. The active tools are
	 * the registered, non-hidden ones; they are declared to the model. Active tools with a
	 * `prepareLoadout` hook can change the declared descriptions and hide declarations from
	 * requests (see `installHiddenDeclarationsProjection`).
	 */
	private _applyToolLoadout(toolNames: string[]): AgentTool[] {
		const namespaceOf = (name: string) => this._toolDefinitions.get(name)?.definition.namespace?.name;
		const tools = orderToolNames(toolNames, namespaceOf).flatMap((name) => {
			const tool = this._toolRegistry.get(name);
			return tool && this._getToolExposure(name) !== "hidden" && this._isActivatable(name) ? [tool] : [];
		});
		const hooks = tools.flatMap((tool) => {
			const entry = this._toolDefinitions.get(tool.name);
			return entry?.definition.prepareLoadout ? [entry] : [];
		});
		const hidden = new Set<string>();
		let declared = tools;
		if (hooks.length > 0) {
			const loadout: ToolLoadout = {
				declared: tools,
				callable: this.getCallableTools(new Set(tools.map((tool) => tool.name))),
				registered: [...this._toolRegistry.values()],
				getExposure: (name) => this._getToolExposure(name),
				getNamespace: (name) => this._toolDefinitions.get(name)?.definition.namespace,
				getPromptGuidelines: (name) => this._toolPromptGuidelines.get(name) ?? [],
			};
			const descriptions = new Map<string, string>();
			for (const { definition, sourceInfo } of hooks) {
				try {
					const changes = definition.prepareLoadout?.(loadout);
					for (const [name, description] of Object.entries(changes?.descriptions ?? {})) {
						descriptions.set(name, description);
					}
					for (const name of changes?.hiddenDeclarations ?? []) hidden.add(name);
				} catch (error) {
					this.host.session.extensionRunner.emitError({
						extensionPath: sourceInfo.path,
						event: "prepare_loadout",
						error: errorMessage(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
				}
			}
			declared = tools.map((tool) => {
				const description = descriptions.get(tool.name);
				return description === undefined ? tool : { ...tool, description };
			});
		}
		this._hiddenDeclarations = hidden;
		this.host.session.agent.state.tools = declared;
		return declared;
	}

	rebuildSystemPrompt(toolNames: string[]): void {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		for (const name of this._toolRegistry.keys()) {
			const snippet = this._toolPromptSnippets.get(name);
			// Tools without a snippet are not listed.
			if (snippet) toolSnippets[name] = snippet;
		}

		const resourceLoader = this.host.session.resourceLoader;
		const loaderSystemPrompt = resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt = loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : "";
		const loadedSkills = resourceLoader.getSkills().skills;
		const loadedContextFiles = resourceLoader.getAgentsFiles().agentsFiles;

		this.baseSystemPromptOptions = normalizeBuildSystemPromptOptions({
			cwd: this.host.cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			hiddenTools: [...this._hiddenDeclarations],
			deferredTools: this._getLoadableDeferredToolNames(validToolNames),
			toolSnippets,
			toolGuidelines: Object.fromEntries(this._toolPromptGuidelines),
		});
	}

	/**
	 * Apply a prompt and tool loadout for the next request. Sets the executable tools and
	 * returns a system message patching the prompt sections the model currently has (replayed
	 * from `messages`), or undefined when the prompt is unchanged. Tool changes are declared by
	 * the agent loop before the request.
	 *
	 * A forced prompt does not affect the transcript: the structured sections are still diffed
	 * and persisted, and the forced text is projected onto the request by
	 * `installForcedPromptProjection`.
	 */
	preparePromptAndToolLoadout(
		options: NormalizedBuildSystemPromptOptions,
		messages: AgentMessage[] = this.host.session.agent.state.messages,
	): SystemMessage | undefined {
		options.selectedTools = this._applyToolLoadout(options.selectedTools).map((tool) => tool.name);
		// The tool list and rules must match the declarations the request carries.
		options.hiddenTools = [...this._hiddenDeclarations];
		options.deferredTools = this._getLoadableDeferredToolNames(options.selectedTools);
		const sections = diffSystemPromptSections(
			getCurrentSystemMessage(messages)?.sections ?? {},
			buildSystemPromptSections(options),
		);
		return sections ? { role: "system", content: "", sections, timestamp: Date.now() } : undefined;
	}

	/**
	 * Restore the active tool loadout declared by the session transcript, if it declares one.
	 * Tools reachable only from other tools are never declared, but they do not depend on the active
	 * set, so the transcript's declarations are the whole loadout.
	 * @param modifiers `+name`/`-name` entries applied to the restored loadout.
	 */
	restoreFromTranscript(modifiers: readonly string[] = []): void {
		this._pendingToolNames.clear();
		const current = getCurrentSystemMessage(this.host.session.sessionManager.buildSessionContext().messages);
		if (!current) return;
		const names = applyToolModifiers(
			(current.toolsAdded ?? []).map((tool) => tool.name),
			modifiers,
		);
		this._pendingToolNames = new Set(names.filter((name) => this._isAllowedTool(name)));
		this.setActiveTools(names);
	}

	refresh(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		// Tools that were already activated on registration. A tool whose exposure changes to
		// `direct` or `model-only` (for example from `hidden`) is activated like a new tool.
		const previousActivatedOnRegistration = new Set(
			[...this._toolRegistry.keys()].filter((name) => this._isActivatedOnRegistration(name)),
		);
		const previousActiveToolNames = this.host.session.getActiveToolNames();
		const allowedTools = this._allowedTools;

		const registeredTools = this.host.session.extensionRunner.getAllRegisteredTools();
		const { allCustomTools, definitions, promptSnippets, promptGuidelines } = buildToolDefinitionRegistry(
			registeredTools,
			this._customTools,
			this._baseToolDefinitions,
			(name) => this._isAllowedTool(name),
		);
		this._toolDefinitions = definitions;
		this._toolPromptSnippets = promptSnippets;
		this._toolPromptGuidelines = promptGuidelines;
		const runner = this.host.session.extensionRunner;
		const wrappedTools = wrapRegisteredTools([...definitions.values()], runner);
		this._toolRegistry = new Map(wrappedTools.map((tool) => [tool.name, tool]));

		const nextActiveToolNames = (
			options?.activeToolNames
				? [...options.activeToolNames]
				: [...(this._toolPolicy ? this._policyRequestedTools : previousActiveToolNames)]
		).filter((name) => this._isAllowedTool(name));

		if (allowedTools) {
			for (const toolName of this._toolRegistry.keys()) {
				// Naming or matching a tool activates it even when it is not active by default. MCP tools
				// kept registered without being named stay inactive.
				if (allowedTools(toolName) && this._isDeclarable(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of allCustomTools) {
				if (tool.sourceInfo.path !== NATIVE_FEATURE_PATH && this._isActivatedOnRegistration(tool.definition.name))
					nextActiveToolNames.push(tool.definition.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousActivatedOnRegistration.has(toolName) && this._isActivatedOnRegistration(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}
		// Pending tools that are registered now become active.
		nextActiveToolNames.push(...this._pendingToolNames);

		this.setActiveTools([...new Set(nextActiveToolNames)]);
	}

	/** Whether activating the tool declares it to the model. */
	private _isDeclarable(name: string): boolean {
		const exposure = this._getToolExposure(name);
		return exposure === "direct" || exposure === "model-only";
	}

	/** Whether registering the tool activates it, which declares it to the model. */
	private _isActivatedOnRegistration(name: string): boolean {
		return this._isDeclarable(name) && this._toolDefinitions.get(name)?.definition.defaultActive !== false;
	}
}
