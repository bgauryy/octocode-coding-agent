import { isAlwaysOnBuiltin } from "../features/builtin-ids.ts";
import type { Settings } from "../settings-schema.ts";
import { BUILTIN_PATH_PREFIX } from "../source-info.ts";
import { applyAutoloadDisabledPatterns, getOverridePatterns, isEnabledByOverrides } from "./patterns.ts";

/**
 * Whether the built-in feature at `path` (`builtin:<id>`) is on, and which scope decided it. Built-ins are on unless the
 * user `extensions` setting excludes them, for example with `-builtin:llama.cpp`; a matching `+`, `-` or `!` entry in the
 * project setting overrides that. An always-on built-in (see `isAlwaysOnBuiltin`) ignores both.
 */
export function builtinEnablement(
	path: string,
	globalSettings: Settings,
	projectSettings: Settings,
	globalBaseDir: string,
	projectBaseDir: string,
): { enabled: boolean; scope: "user" | "project" } {
	if (isAlwaysOnBuiltin(path.slice(BUILTIN_PATH_PREFIX.length))) return { enabled: true, scope: "user" };
	const projectEnabled = applyAutoloadDisabledPatterns(
		[path],
		getOverridePatterns(projectSettings.extensions ?? []),
		projectBaseDir,
	).get(path);
	return projectEnabled === undefined
		? { enabled: isEnabledByOverrides(path, globalSettings.extensions ?? [], globalBaseDir), scope: "user" }
		: { enabled: projectEnabled, scope: "project" };
}
