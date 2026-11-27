/** Where providers, models and credentials come from. `octocode` is ours and always on; the others can be toggled. */
export type ProviderSourceId = "octocode" | "pi" | "copilot-env";

/** The sources a user can switch. */
export type ToggleableSourceId = Exclude<ProviderSourceId, "octocode">;

export const TOGGLEABLE_SOURCE_IDS: readonly ToggleableSourceId[] = ["pi", "copilot-env"];

/** The `providerSources` setting: only the user's changes from each source's default. */
export type ProviderSourceOverrides = Partial<Record<ToggleableSourceId, boolean>>;

/** What a source gives the session. */
type ProviderSourceProvides = "credentials" | "models";

interface ProviderSourceState {
	/** In effect now: the default, or the user's override. */
	enabled: boolean;
	/** The user changed it from `defaultEnabled`. */
	overridden: boolean;
	/** Something is there to read: a config file exists, or the variable is set. Never the value. */
	present: boolean;
}

export interface ProviderSource {
	id: ProviderSourceId;
	label: string;
	provides: readonly ProviderSourceProvides[];
	/** Files or variable names, for display (`~` for the home directory). */
	paths: readonly string[];
	defaultEnabled: boolean;
	toggleable: boolean;
	state: ProviderSourceState;
}

/** What Octocode offers for a detected tool's account. Nothing is read from the tool. */
export type DetectedToolAction =
	/** Octocode's own sign-in covers the account. */
	| { kind: "sign-in"; providerId: string }
	/** No sign-in covers it: set up an API key for this vendor provider. */
	| { kind: "api-key"; providerId: string };

export interface DetectedTool {
	id: string;
	label: string;
	/** The known install or config paths that exist, for display (`~` for the home directory). */
	foundAt: readonly string[];
	action: DetectedToolAction;
}

/** Filesystem access for detection and source state; injectable so tests use a temp home. */
export interface ProviderSourceFs {
	exists(path: string): boolean;
	/** The resolved path of a link, or undefined when it cannot be resolved. */
	realpath(path: string): string | undefined;
}

/** Where to look. Defaults: the real home, `process.env` and the real filesystem. */
export interface ProviderSourceEnvironment {
	home?: string;
	env?: Readonly<Record<string, string | undefined>>;
	fs?: ProviderSourceFs;
	/** Octocode's agent directory, for the `octocode` source paths. */
	agentDir?: string;
	piDirs?: readonly string[];
}
