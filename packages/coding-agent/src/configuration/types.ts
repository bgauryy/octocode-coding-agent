import type { McpReloadResult, McpServerStatus, McpSwitch } from "../../../mcp/src/api.ts";
import type { SettingsManager } from "../core/settings-manager.ts";

/**
 * One configuration mechanism: every switchable thing (a tool, an MCP server, a harness, a skill, a provider, a settings
 * key) is an entry with an id, and the same verbs act on all of them. Adapters own the writes (they call the existing
 * writers of each owner); the catalog routes by id. Front-ends (`/configuration`, `octocode configuration`) only call the
 * catalog.
 */

/** `global`: the user's files; `project`: this folder's files (trusted folders only); `run`: memory, this process only. */
export type ConfigScope = "global" | "project" | "run";

export type ConfigVerb = "list" | "get" | "enable" | "disable" | "set" | "unset" | "add" | "remove";

/** The verbs that change something (the rest only read). */
type ConfigWriteVerb = Exclude<ConfigVerb, "list" | "get">;

/** When a saved change reaches the running session: at once, after `/reload`, or only for sessions started later. */
export type AppliesWhen = "now" | "reload" | "next-session";

export type ConfigValueType =
	| { type: "toggle" }
	| { type: "boolean" }
	| { type: "number" }
	| { type: "string" }
	| { type: "enum"; values: readonly string[] }
	| { type: "json" };

export interface ConfigEntry {
	/** `kind:name` (`tool:backlog`, `mcp:octocode`), or a settings key's dotted path (`bash.spillMaxBytes`). */
	id: string;
	/** The id's kind, `setting` for a settings key. */
	kind: string;
	label: string;
	description?: string;
	valueType: ConfigValueType;
	/** What applies now: the merged value of all scopes. For a toggle, `true` is on. */
	value: unknown;
	/** The value each scope holds itself; a scope that does not set the entry is absent. */
	scopes: Partial<Record<ConfigScope, unknown>>;
	/** The scope that decides `value`, or `default` when nothing sets it. */
	setBy: ConfigScope | "default";
	/** The built-in value, when the owner declares one. */
	default?: unknown;
	appliesWhen: AppliesWhen;
	/** Why this entry cannot be changed (an always-on built-in), or absent. */
	locked?: string;
	/** Where the entry comes from or what it is, for display (a file path, a state). */
	detail?: string;
}

export interface ConfigFilter {
	/** Kind names (`tool`, `mcp`, `setting`), or empty for all. */
	kinds?: readonly string[];
	/** Case-insensitive text matched against id, label and description. */
	text?: string;
}

/** One change request. `scope` defaults to `global`. */
export type ConfigOp =
	/** `force` lets `disable` switch off what is kept on (a gate hook). */
	| { verb: "enable" | "disable" | "unset" | "remove"; id: string; scope?: ConfigScope; force?: boolean }
	/** `value` is a CLI string (booleans, numbers, enum values and JSON are coerced) or an already typed value. */
	| { verb: "set"; id: string; value: unknown; scope?: ConfigScope }
	/** `value` is the new entry's definition: an MCP server's config, the same object `octocode mcp add` builds. */
	| { verb: "add"; id: string; value: unknown; scope?: ConfigScope };

export interface ConfigApplied {
	status: "applied";
	id: string;
	verb: ConfigWriteVerb;
	scope: ConfigScope;
	appliesWhen: AppliesWhen;
	message: string;
}

export interface ConfigRefused {
	status: "refused";
	id: string;
	verb: ConfigWriteVerb;
	scope: ConfigScope;
	reason: string;
	/** The closest known ids, when the id is unknown. */
	suggestions?: string[];
}

export type ConfigResult = ConfigApplied | ConfigRefused;

/** Hooks only a running session has. Absent in the CLI; an adapter without its hook writes files and says when it applies. */
export interface ConfigLiveHooks {
	/** The MCP owner's switch (`getMcpSwitch(events)`): opens or closes the server now. */
	mcpSwitch?: McpSwitch;
	/** The MCP owner's reload (`requestMcpReload(events)`): a harness switch changes which servers its files supply. */
	mcpReload?: () => Promise<McpReloadResult | undefined>;
	/** The MCP owner's status snapshot (`getMcpSessionStatus(events)`): the connection state the MCP rows show. */
	mcpStatus?: () => McpServerStatus[];
	/** Applies a settings key to the running terminal at once (theme, TUI mode, paddings); true when it did. */
	applySetting?: (key: string, value: unknown) => boolean;
	/** The names of the tools the running session has registered, extension tools included. */
	toolNames?: () => readonly string[];
}

export interface ConfigContext {
	cwd: string;
	agentDir: string;
	/**
	 * The settings manager to read and write through: a running session passes its own, the CLI creates one with
	 * `SettingsManager.create(cwd, agentDir, { projectTrusted })`. It must read the files under `agentDir` and `cwd`.
	 */
	settings: SettingsManager;
	/** Whether the folder is trusted; project scope is refused without it. */
	projectTrusted: boolean;
	/** Home folder other products' files are read from; default is the user's. Tests pass a temporary one. */
	home?: string;
	live?: ConfigLiveHooks;
}

export interface ConfigAdapter {
	/** The id kinds this adapter owns (`["tool"]`); `setting` for settings keys. */
	readonly kinds: readonly string[];
	list(ctx: ConfigContext): Promise<ConfigEntry[]>;
	/** Applies a write verb. The catalog has already checked project trust and that the id's kind is owned. */
	apply(op: ConfigOp, ctx: ConfigContext): Promise<ConfigResult>;
}
