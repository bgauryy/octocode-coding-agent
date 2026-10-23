import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { Model } from "@octocodeai/octocode-ai/compat";
import type { AgentSession } from "../agent-session.ts";
import type { LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "../extensions/index.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import type { SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.octocode/octocodecode */
	agentDir?: string;

	/** Canonical model/auth runtime. Defaults to a runtime using agentDir/auth.json and models.json. */
	modelRuntime?: ModelRuntime;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in Octocode tools
	 *   but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names or patterns, where `*` matches any characters.
	 *
	 * When omitted, Octocode uses the resolved `defaultTools` setting for the initial
	 * selection when configured. Otherwise it enables the default built-in tools
	 * from the loaded runtime, including native Octocode tools. Extension/custom tools remain enabled unless
	 * `noTools` changes that default. When provided, only matching tools are
	 * enabled. MCP tools stay registered for tool search unless an
	 * entry starts with `mcp__`; then only matching MCP tools are kept. An empty
	 * list, like `noTools: "all"`, disables MCP tools too.
	 *
	 * A list of only `+name` and `-name` entries is not an allowlist: it adds tools
	 * to or removes them from the default selection, like the `defaultTools` setting.
	 * These entries take exact names. Mixing them with plain entries throws.
	 */
	tools?: string[];
	/**
	 * Optional denylist of tool names or patterns to disable. Applies after `tools` when both are
	 * provided, MCP tools included.
	 */
	excludeTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir), which treats the project as untrusted. */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}
