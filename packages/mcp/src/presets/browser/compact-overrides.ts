import {
	type CompactServerInput,
	type DescriptionOverrides,
	parsePresetOverrides,
	presetOverridesFor,
} from "../../compact/index.ts";
import data from "./compact-overrides.json" with { type: "json" };

const parsed = parsePresetOverrides(data);

/**
 * Description overrides and triggers for the generated file of the built-in browser server
 * (`@octocodeai/octocode-chrome-devtools`), written with the `octocode-context-optimization` skill against the installed
 * 0.2.0 catalog. Each tool's entries carry the hash of the tool they describe, so a package release that changes a tool
 * drops only that tool's entries (`test/mcp-browser-override-drift.test.ts` names them); the skill rewrites them.
 */
export function browserCompactOverrides(input: CompactServerInput): DescriptionOverrides | undefined {
	return "overrides" in parsed ? presetOverridesFor(parsed.overrides, input) : undefined;
}
