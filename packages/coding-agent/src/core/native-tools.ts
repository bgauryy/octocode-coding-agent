import type { Extension } from "./extensions/types.ts";
import { DEFAULT_TOOL_NAMES } from "./settings-manager.ts";

export const NATIVE_FEATURE_PATH = "<inline:octocode>";

export function defaultToolNames(extensions: readonly Extension[]): string[] {
	const native = extensions.find((extension) => extension.sourceInfo.path === NATIVE_FEATURE_PATH);
	const names = native ? ["read"] : [...DEFAULT_TOOL_NAMES];
	for (const { definition } of native?.tools.values() ?? []) {
		if (definition.defaultActive !== false && !names.includes(definition.name)) names.push(definition.name);
	}
	return names;
}
