import type { McpServerPreset } from "../preset.ts";
import { recommendedPresets } from "../recommended/index.ts";
import { browserPreset } from "./browser/index.ts";
import { desktopPreset } from "./desktop/index.ts";

/** Every server Octocode registers itself: the recommended ones, the browser and the desktop. */
export const builtinPresets = (env: NodeJS.ProcessEnv = process.env): McpServerPreset[] => [
	...recommendedPresets(),
	browserPreset(env),
	desktopPreset(env),
];
