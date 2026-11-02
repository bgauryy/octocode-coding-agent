/**
 * Ids of the built-in features, as `builtin:<id>` entries of the `extensions` setting name them. Kept apart from the
 * feature list (`resource-loader/builtins.ts`, which imports the whole native feature set) so settings and inventory
 * code can name them without importing the features.
 */
export const BUILTIN_FEATURE_IDS = ["llama.cpp", "mcp"] as const;

export type BuiltinFeatureId = (typeof BUILTIN_FEATURE_IDS)[number];
