import {
	type CompactServerInput,
	type DescriptionOverrides,
	parsePresetOverrides,
	presetOverridesFor,
	presetStatus,
	type StalePresetEntry,
} from "../../compact/index.ts";
import data from "./compact-overrides.json" with { type: "json" };

const parsed = parsePresetOverrides(data);

/** The overrides that no longer match the server's catalogs, each named by tool and field. */
export function browserOverrideStatus(inputs: readonly CompactServerInput[]): StalePresetEntry[] {
	return "overrides" in parsed ? presetStatus(parsed.overrides, inputs) : [];
}

/**
 * Description overrides and triggers for the generated file of the built-in browser server
 * (`@octocodeai/octocode-chrome-devtools`), written with the `octocode-context-optimization` skill against the installed
 * 0.2.0 catalog. Each override carries the hash of the upstream text it replaces, so a package release that rewrites
 * a text drops only that override (`test/mcp-browser-override-drift.test.ts` names it).
 */
export function browserCompactOverrides(input: CompactServerInput): DescriptionOverrides | undefined {
	return "overrides" in parsed ? presetOverridesFor(parsed.overrides, input) : undefined;
}
