import type { Settings } from "../settings-schema.ts";

/**
 * Typed configuration items with the place each one came from. Discovery is read-only: it says what exists and which copy
 * wins; loaders still parse the files, and the package manager still decides what is enabled.
 */

export type ConfigKind =
	| "skill"
	| "prompt"
	| "theme"
	| "context"
	| "systemPrompt"
	| "appendSystemPrompt"
	| "keybinding"
	| "extension"
	| "agent"
	| "hook"
	| "plugin"
	| "mcp"
	| "model"
	| "setting";

export type Product = "octocode" | "pi";

export type ConfigScope = "builtin" | "global" | "project";

/** Where an item sits, and why it is not the active copy when it is not. */
export interface Provenance {
	product: Product;
	scope: ConfigScope;
	/** The convention that owns the folder: `octocode`, `agents` (the shared `.agents` folders), `pi`, `bundled`, `claude`, `codex`, `plugin`. */
	origin: string;
	path: string;
	/** The folder the item's enable patterns are relative to. */
	baseDir?: string;
	/** Another item of the same kind and name wins. */
	shadowedBy?: ShadowingItem;
	/** `untrusted`: a project item in a folder that is not trusted. `ignored-code`: user code Octocode does not run. */
	notLoaded?: "untrusted" | "ignored-code";
}

/** The winning copy, without its own shadowing state. */
type ShadowingItem = Omit<Provenance, "shadowedBy" | "notLoaded">;

export interface ConfigItem {
	kind: ConfigKind;
	/** The key items of one kind are compared by: a skill or prompt name, a theme name, a file name. */
	name: string;
	provenance: Provenance;
	/**
	 * `override`: a control-only entry (an MCP `mcp.json` entry that sets `enabled` or `exposure` for a server defined
	 * elsewhere). It never competes with, or shadows, a definition of the same name. Default `definition`.
	 */
	role?: "definition" | "override";
	/** False when the item is shadowed or not loaded; display shows it, loaders skip it. */
	loaded: boolean;
	diagnostics: string[];
}

export interface DiscoverInput {
	cwd: string;
	/** The Octocode global directory. */
	agentDir: string;
	home: string;
	projectTrusted: boolean;
	/** The folder a trust grant is on; project instructions load from it down to `cwd`. */
	contextRoot?: string;
	/**
	 * Pi's read-only roots (`getLegacyConfigDirs`). Empty when an explicit home is set: Pi compatibility is off, and so is
	 * Pi's project folder.
	 */
	piRoots: readonly string[];
	/** The skills bundled with this build. */
	builtinSkillsDir?: string;
	/** The environment the host kinds read their global folders from (`OCTOCODE_HOME`, `CODEX_HOME`). Default `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** The `plugins` entries in effect, for the `plugin` kind; without them no plugin is listed. */
	plugins?: Settings["plugins"];
	/** Return project items of an untrusted folder, marked `notLoaded: "untrusted"`, for display. */
	includeUntrusted?: boolean;
}

/** A provider of items for one kind. Core ships the file-based ones; the host registers the rest (hooks, agents, plugins). */
export interface DiscoverySource {
	kind: ConfigKind;
	discover(input: DiscoverInput): ConfigItem[];
}
