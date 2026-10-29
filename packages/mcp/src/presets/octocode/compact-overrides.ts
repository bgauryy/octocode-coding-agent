import {
	type CompactServerInput,
	type DescriptionOverrides,
	parsePresetOverrides,
	presetOverridesFor,
} from "../../compact/index.ts";
import data from "./compact-overrides.json" with { type: "json" };

const parsed = parsePresetOverrides(data);

/**
 * Description overrides and triggers for the generated file of the Octocode research server, written with the
 * `octocode-compact-mcp` skill. Each tool's entries carry the hash of the tool they describe, so a server release that
 * changes a tool drops only that tool's entries; the skill rewrites them.
 */
export function octocodeCompactOverrides(input: CompactServerInput): DescriptionOverrides | undefined {
	return "overrides" in parsed ? presetOverridesFor(parsed.overrides, input) : undefined;
}
