/**
 * Ids of the built-in features, as `builtin:<id>` entries of the `extensions` setting name them. Kept apart from the
 * feature list (`resource-loader/builtins.ts`, which imports the whole native feature set) so settings and inventory
 * code can name them without importing the features.
 */
const BUILTIN_FEATURE_IDS = ["llama.cpp", "mcp"] as const;

export type BuiltinFeatureId = (typeof BUILTIN_FEATURE_IDS)[number];

/**
 * Built-ins that are part of the core: they are on in every session, whatever the `extensions` setting says, and no
 * switch lists them. Each maps to why a `-builtin:<id>` entry does nothing and what to use instead.
 */
const ALWAYS_ON_BUILTINS: Readonly<Partial<Record<BuiltinFeatureId, string>>> = {
	mcp: "MCP is always on; turn servers off in /mcp or mcp.json, or start with --no-mcp",
};

export const isAlwaysOnBuiltin = (id: string): boolean => Object.hasOwn(ALWAYS_ON_BUILTINS, id);

/** The built-ins `extensions` and the switch lists can turn off. */
export const SWITCHABLE_BUILTIN_IDS: readonly BuiltinFeatureId[] = BUILTIN_FEATURE_IDS.filter(
	(id) => !isAlwaysOnBuiltin(id),
);

/** One message for each entry of `extensions` that tries to switch an always-on built-in off; those entries do nothing. */
export function ignoredBuiltinSwitches(extensions: readonly string[]): string[] {
	return extensions.flatMap((entry) => {
		const id = /^[-!]builtin:(.+)$/.exec(entry)?.[1];
		const why = id === undefined ? undefined : ALWAYS_ON_BUILTINS[id as BuiltinFeatureId];
		return why ? [`"${entry}" in extensions is ignored: ${why}`] : [];
	});
}

/** What switching a built-in feature off takes away, in one line for the row and the switch message. */
const BUILTIN_FEATURE_EFFECTS: Readonly<Partial<Record<BuiltinFeatureId, string>>> = {
	"llama.cpp": "turns off the local llama.cpp provider and its commands",
};

/** What switching off the built-in extension at `path` (`builtin:<id>`) takes away, or undefined for any other path. */
export function builtinEffect(path: string): string | undefined {
	const id = path.startsWith("builtin:") ? path.slice("builtin:".length) : undefined;
	return id !== undefined && Object.hasOwn(BUILTIN_FEATURE_EFFECTS, id)
		? BUILTIN_FEATURE_EFFECTS[id as BuiltinFeatureId]
		: undefined;
}
