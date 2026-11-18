/** The session's allowed tools, model declarations, `prepareLoadout` hooks and resulting system prompt. */

import type { AgentMessage, AgentTool } from "@octocodeai/octocode-agent-core";
import { getCurrentSystemMessage } from "@octocodeai/octocode-ai";
import type { SystemMessage } from "@octocodeai/octocode-ai/compat";
import { type ToolDefinition, type ToolExposure, type ToolInfo, wrapRegisteredTools } from "../features/index.ts";
import { createToolNameMatcher, isMcpToolName } from "@octocodeai/octocode-common/mcp-names";
import { applyToolModifiers } from "../settings-manager.ts";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	diffSystemPromptSections,
	type NormalizedBuildSystemPromptOptions,
} from "../system-prompt.ts";
import type { SessionInternals } from "./host.ts";
import { buildToolDefinitionRegistry, orderToolNames } from "./tool-definitions.ts";
import { selectsToolPrefix } from "./tool-selection.ts";
import { PendingMcpTools } from "./pending-mcp-tools.ts";
import type { ToolDefinitionEntry } from "./types.ts";
import { companionFloor, toolsToActivate, toToolInfo, withCompanions } from "./tool-loadout/activation.ts";
import { heldToolsFor, spanOf, withToolsOffNotice } from "./tool-loadout/held-tools.ts";
import { runPrepareLoadoutHooks } from "./tool-loadout/prepare-hooks.ts";
import { ancestors } from "../session-manager/ancestors.ts";
import type { RequestSystemOverride } from "../forced-system-prompt.ts";
import { buildBaseSystemPromptOptions } from "./tool-loadout/prompt-options.ts";

export interface ToolLoadoutOptions {
	customTools?: ToolDefinition[];
	allowedToolNames?: string[];
	excludedToolNames?: string[];
}

export class SessionToolLoadout {
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	/** Restored or reloaded tools not registered yet: activated when registered, dropped by a deactivation (MCP ones stay in `pendingMcp`). */
	private _pendingToolNames = new Set<string>();
	/** Tools `setActiveToolsByName()` deactivated since: re-registration (an MCP reconnect) keeps them inactive. */
	private _deselectedToolNames = new Set<string>();
	readonly pendingMcp = new PendingMcpTools();
	/** Tool changes the transport cannot carry in place, held to the next span. */
	readonly held = heldToolsFor(
		() => this.host.session,
		(name) => this._toolDefinitions.get(name)?.definition.namespace?.name,
	);
	/** Matches the `--tools` entries: tool names or patterns. */
	private _allowedTools?: (name: string) => boolean;
	private readonly _allowedEntries?: readonly string[];
	/** Whether the allowlist filters MCP tools: it is empty (`--no-tools`) or names an `mcp__*` tool. */
	private _allowlistFiltersMcp = false;
	private _excludedTools?: (name: string) => boolean;
	private readonly _excludedEntries: readonly string[];
	/** Companions of the selected tools (`ToolDefinition.companionTools`): registered whatever the selection says. */
	private _companionFloor: ReadonlySet<string> = new Set();
	// Tool registry for feature getTools/setTools
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
	private _lastRequestOverride?: RequestSystemOverride;

	private readonly host: Pick<SessionInternals, "session" | "cwd">;

	constructor(host: Pick<SessionInternals, "session" | "cwd">, options: ToolLoadoutOptions) {
		this.host = host;
		this._customTools = options.customTools ?? [];
		if (options.allowedToolNames) {
			this._allowedTools = createToolNameMatcher(options.allowedToolNames);
			this._allowedEntries = [...options.allowedToolNames];
			this._allowlistFiltersMcp =
				options.allowedToolNames.length === 0 || options.allowedToolNames.some((entry) => entry.startsWith("mcp__"));
		}
		this._excludedTools = options.excludedToolNames ? createToolNameMatcher(options.excludedToolNames) : undefined;
		this._excludedEntries = [...(options.excludedToolNames ?? [])];
	}

	/** What requests leave out; given a request's `messages`, a compaction in them declares the held late tools. */
	hiddenDeclarations(messages?: readonly AgentMessage[]): ReadonlySet<string> {
		return messages ? (this._hiddenDeclarations = this.held.hiddenIn(spanOf(messages))) : this._hiddenDeclarations;
	}

	/** Current effective system prompt, including changes not yet sent to the model. */
	get systemPrompt(): string {
		return buildSystemPrompt(this.runSystemPromptOptions ?? this.baseSystemPromptOptions);
	}

	/** Retain only the last request's override and origin, not another copy of its messages. */
	rememberRequestSystemOverride(snapshot: RequestSystemOverride): void {
		this._lastRequestOverride = snapshot;
	}

	/** A different session or sibling branch cannot reuse this transient override. */
	get requestForcedSystemPrompt(): string | undefined {
		const session = this.host.session.sessionManager;
		const saved = this._lastRequestOverride;
		if (!saved || saved.sessionId !== session.getSessionId()) return undefined;
		for (const entry of ancestors(session.getLeafEntry(), (id) => session.getEntry(id)))
			if (entry.id === saved.leafId) return saved.forced;
		return undefined;
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
		return Array.from(this._toolDefinitions.values()).map((entry) =>
			toToolInfo(entry, this._getToolExposure(entry.definition.name)),
		);
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	setActiveToolsByName(toolNames: string[]): void {
		const { session } = this.host;
		const previous = session.getActiveToolNames();
		this.setActiveTools(toolNames);
		// A loadout that deactivates a tool replaces the restored one, whose pending tools are dropped.
		// One that only adds tools keeps them.
		const active = new Set(session.getActiveToolNames());
		if (previous.some((name) => !active.has(name))) this._pendingToolNames.clear();
		// The caller's request, not what policy or exposure let through, decides what stays deselected.
		const requested = new Set(toolNames);
		for (const name of previous) if (!requested.has(name)) this._deselectedToolNames.add(name);
		for (const name of requested) this._deselectedToolNames.delete(name);
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

	/** Keep the active tools pending, so tools registered later by reloaded features become active again. */
	markActiveToolsPending(): void {
		for (const name of this.host.session.getActiveToolNames()) this._pendingToolNames.add(name);
	}

	/** Declared MCP tools kept pending until their server registers them; the model's declarations keep them. */
	pendingMcpToolNames = (): ReadonlySet<string> => new Set([...this._pendingToolNames].filter(isMcpToolName));

	settlePendingToolNames(): void {
		this.pendingMcp.retain(() => this._pendingToolNames, this.host.session.resourceLoader.getEventBus?.());
	}

	/** Whether `--tools` and `--exclude-tools` keep the tool registered (MCP tools stay registered, never active, under an allowlist without `mcp__` entries: `_isActivatable`). */
	private _isAllowedTool(name: string): boolean {
		return this._isSelectedTool(name) || (this._companionFloor.has(name) && !this._excludedTools?.(name));
	}

	/** The companions of a registered native or base tool; a feature or SDK tool's `companionTools` are ignored. */
	private _trustedCompanions(name: string): readonly string[] | undefined {
		const entry = this._toolDefinitions.get(name);
		if (!entry) return undefined;
		const trusted = entry.sourceInfo.owner === "native" || this._baseToolDefinitions.get(name) === entry.definition;
		return trusted ? entry.definition.companionTools : undefined;
	}

	/** Whether `--tools` and `--exclude-tools` select the tool, before companions are added. */
	private _isSelectedTool(name: string): boolean {
		if (this._excludedTools?.(name)) return false;
		return !this._allowedTools || this._allowedTools(name) || (!this._allowlistFiltersMcp && isMcpToolName(name));
	}

	/** Whether the tool may be active (declared), including when restored from the transcript or set by features. */
	private _isActivatable(name: string): boolean {
		if (this._toolPolicy && !this._toolPolicy(name)) return false;
		return !this._allowedTools || this._allowedTools(name) || !isMcpToolName(name);
	}

	/** Whether the session's selection can activate tools named `<prefix>…` (`selectsToolPrefix`). */
	selectsTools(prefix: string, activeByDefault: boolean, modifiers: readonly string[]): boolean {
		return selectsToolPrefix(prefix, activeByDefault, {
			allowed: this._allowedEntries,
			excluded: this._excludedEntries,
			modifiers,
		});
	}

	private _getToolExposure(name: string): ToolExposure {
		return this._toolDefinitions.get(name)?.definition.exposure ?? "direct";
	}

	/** Tools callable through `ctx.executeTool()`: the active `direct` tools. */
	getCallableTools(active: ReadonlySet<string> = new Set(this.host.session.getActiveToolNames())): AgentTool[] {
		return [...this._toolRegistry.values()].filter(
			(tool) =>
				(!this._toolPolicy || this._toolPolicy(tool.name)) &&
				this._getToolExposure(tool.name) === "direct" &&
				active.has(tool.name),
		);
	}

	/**
	 * Set the agent's tools for the given active tool names and return them. The active tools are
	 * the registered, non-hidden ones; they are declared to the model. Active tools with a
	 * `prepareLoadout` hook can change the declared descriptions and hide declarations from
	 * requests (see `installHiddenDeclarationsProjection`).
	 */
	private _applyToolLoadout(toolNames: string[]): AgentTool[] {
		const namespaceOf = (name: string) => this._toolDefinitions.get(name)?.definition.namespace?.name;
		const names = withCompanions(toolNames, (name) => this._trustedCompanions(name));
		const tools = orderToolNames(
			names,
			namespaceOf,
			(name) => this._toolDefinitions.get(name)?.definition.roleVariant === true,
		).flatMap((name) => {
			const tool = this._toolRegistry.get(name);
			return tool && this._getToolExposure(name) !== "hidden" && this._isActivatable(name) ? [tool] : [];
		});
		const hooks = tools.flatMap((tool) => {
			const entry = this._toolDefinitions.get(tool.name);
			return entry?.definition.prepareLoadout ? [entry] : [];
		});
		const { declared, hidden } = runPrepareLoadoutHooks(
			tools,
			hooks,
			() => ({
				declared: tools,
				callable: this.getCallableTools(new Set(tools.map((tool) => tool.name))),
				registered: [...this._toolRegistry.values()],
				getExposure: (name) => this._getToolExposure(name),
				getNamespace: (name) => this._toolDefinitions.get(name)?.definition.namespace,
				getPromptGuidelines: (name) => this._toolPromptGuidelines.get(name) ?? [],
			}),
			(entry, error, stack) =>
				this.host.session.featureHost.emitError({
					source: entry.sourceInfo.path,
					event: "prepare_loadout",
					error,
					stack,
				}),
		);
		const active = this.host.session.getActiveToolNames();
		this._hiddenDeclarations = this.held.apply(
			active,
			declared.map((tool) => tool.name),
			hidden,
		);
		this.host.session.agent.state.tools = declared;
		return declared;
	}

	rebuildSystemPrompt(toolNames: string[]): void {
		this.baseSystemPromptOptions = buildBaseSystemPromptOptions(
			this.host,
			this._toolRegistry,
			toolNames,
			this._toolPromptSnippets,
			this._toolPromptGuidelines,
			[...this._hiddenDeclarations],
			[
				...[...this._toolDefinitions].filter(([, entry]) => entry.definition.onDemand === true).map(([name]) => name),
				...this.held.late,
			],
		);
		const base = this.baseSystemPromptOptions;
		base.sections = withToolsOffNotice(base.sections, this.held.notice(toolNames));
	}

	/**
	 * Apply a prompt and tool loadout for the next request: sets the executable tools and returns a system message
	 * patching the sections the model has (replayed from `messages`), or undefined when unchanged. The agent loop
	 * declares tool changes. A forced prompt is projected onto the request by `installForcedPromptProjection`.
	 */
	preparePromptAndToolLoadout(
		options: NormalizedBuildSystemPromptOptions,
		messages: AgentMessage[] = this.host.session.agent.state.messages,
	): SystemMessage | undefined {
		this.held.beginSpan(spanOf(messages));
		options.selectedTools = this._applyToolLoadout(options.selectedTools).map((tool) => tool.name);
		// The tool list and rules must match the declarations the request carries.
		options.hiddenTools = [...this._hiddenDeclarations];
		options.onDemandTools = [...new Set([...(options.onDemandTools ?? []), ...this.held.late])];
		options.sections = withToolsOffNotice(options.sections, this.held.notice(options.selectedTools));
		const sections = diffSystemPromptSections(
			getCurrentSystemMessage(messages)?.sections ?? {},
			buildSystemPromptSections(options),
		);
		return sections ? { role: "system", content: "", sections, timestamp: Date.now() } : undefined;
	}

	/**
	 * Restore the active tool loadout the session transcript declares, if any: its declarations are the whole loadout.
	 * @param modifiers `+name`/`-name` entries applied to the restored loadout.
	 */
	restoreFromTranscript(modifiers: readonly string[] = []): void {
		this._pendingToolNames.clear();
		this._deselectedToolNames.clear();
		this.held.clear();
		const current = getCurrentSystemMessage(this.host.session.sessionManager.buildSessionContext().messages);
		if (!current) return;
		const names = applyToolModifiers(
			(current.toolsAdded ?? []).map((tool) => tool.name),
			modifiers,
		);
		this._pendingToolNames = new Set(names.filter((name) => this._isAllowedTool(name)));
		this.setActiveTools(names);
	}

	refresh(options?: { activeToolNames?: string[]; includeAllFeatureTools?: boolean }): void {
		// Tools already activated on registration. One whose exposure changes to `direct` or `model-only` (say from
		// `hidden`) is activated like a new tool, unless deselected.
		const previousActivatedOnRegistration = new Set(
			[...this._toolRegistry.keys()].filter((name) => this._isActivatedOnRegistration(name)),
		);
		const previousActiveToolNames = this.host.session.getActiveToolNames();
		const allowedTools = this._allowedTools;
		const registeredTools = this.host.session.featureHost.getAllRegisteredTools();
		// Only native and base tools may name companions: a feature tool's companions never get past `--tools`.
		this._companionFloor = companionFloor(
			[
				...this._baseToolDefinitions.values(),
				...registeredTools.filter((tool) => tool.sourceInfo.owner === "native").map((tool) => tool.definition),
			],
			(name) => this._isSelectedTool(name),
		);

		const { allCustomTools, definitions, promptSnippets, promptGuidelines } = buildToolDefinitionRegistry(
			registeredTools,
			this._customTools,
			this._baseToolDefinitions,
			(name) => this._isAllowedTool(name),
		);
		this._toolDefinitions = definitions;
		this._toolPromptSnippets = promptSnippets;
		this._toolPromptGuidelines = promptGuidelines;
		const wrappedTools = wrapRegisteredTools([...definitions.values()], this.host.session.featureHost);
		this._toolRegistry = new Map(wrappedTools.map((tool) => [tool.name, tool]));

		const nextActiveToolNames = (
			options?.activeToolNames
				? [...options.activeToolNames]
				: [...(this._toolPolicy ? this._policyRequestedTools : previousActiveToolNames)]
		).filter((name) => this._isAllowedTool(name));

		nextActiveToolNames.push(
			...toolsToActivate({
				allowedTools,
				explicitActiveNames: options?.activeToolNames !== undefined,
				includeAllFeatureTools: options?.includeAllFeatureTools === true,
				registered: this._toolRegistry.keys(),
				customTools: allCustomTools,
				previousActivated: previousActivatedOnRegistration,
				deselected: this._deselectedToolNames,
				isDeclarable: (name) => this._isDeclarable(name),
				isActivatedOnRegistration: (name) => this._isActivatedOnRegistration(name),
			}),
		);
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
