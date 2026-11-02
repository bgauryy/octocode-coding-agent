import type { PathMetadata } from "./package-manager/types.ts";

export type SourceScope = "user" | "project" | "temporary";
export type SourceOrigin = "package" | "top-level";

/** Who supplies a feature: `native` is the Octocode feature set; `builtin` is every other host-supplied feature. */
export type FeatureOwner = "native" | "builtin";

export interface SourceInfo {
	path: string;
	/** Set on tools and commands that a feature registered. */
	owner?: FeatureOwner;
	source: string;
	scope: SourceScope;
	origin: SourceOrigin;
	baseDir?: string;
}

/** Prefix of built-in tool and extension paths, such as `builtin:read` or `builtin:mcp`. */
export const BUILTIN_PATH_PREFIX = "builtin:";

/**
 * Source of a path that names no file: `builtin` for `builtin:<name>`, or the prefix of an
 * angle-bracket path such as `inline` for `<inline:name>`. Undefined for file paths.
 */
export function getSyntheticPathSource(path: string): string | undefined {
	if (path.startsWith(BUILTIN_PATH_PREFIX)) return "builtin";
	if (path.startsWith("<") && path.endsWith(">")) return path.slice(1, -1).split(":")[0] || "temporary";
	return undefined;
}

export function isSyntheticPath(path: string): boolean {
	return path.startsWith(BUILTIN_PATH_PREFIX) || path.startsWith("<");
}

export function createSourceInfo(path: string, metadata: PathMetadata): SourceInfo {
	return {
		path,
		source: metadata.source,
		scope: metadata.scope,
		origin: metadata.origin,
		baseDir: metadata.baseDir,
	};
}

export function createSyntheticSourceInfo(
	path: string,
	options: {
		source: string;
		scope?: SourceScope;
		origin?: SourceOrigin;
		baseDir?: string;
		owner?: FeatureOwner;
	},
): SourceInfo {
	return {
		path,
		...(options.owner ? { owner: options.owner } : {}),
		source: options.source,
		scope: options.scope ?? "temporary",
		origin: options.origin ?? "top-level",
		baseDir: options.baseDir,
	};
}
