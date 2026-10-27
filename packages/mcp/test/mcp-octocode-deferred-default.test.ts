import { describe, expect, it } from "vitest";
import type { McpServerEntry } from "../src/config.ts";
import { configuredExposures, hasIndirectTools } from "../src/exposure.ts";
import { OCTOCODE_DEFERRED_TOOLS } from "../src/presets/octocode/names.ts";
import { octocodePreset } from "../src/presets/octocode/index.ts";
import { getMcpToolExposure } from "../src/servers.ts";

const defaults = octocodePreset(() => [], {}).toolExposure;
const DIRECT = [
	"localSearch",
	"localFetch",
	"structureSearch",
	"astSearch",
	"lspSearch",
	"ghSearchCode",
	"ghGetFileContent",
	"ghStructure",
];

describe("the Octocode preset's deferred research tools", () => {
	it("defers the five rarely used tools and keeps the others direct", () => {
		expect([...OCTOCODE_DEFERRED_TOOLS].sort()).toEqual([
			"artifactSearch",
			"clasify",
			"ghGetHistoryItem",
			"ghSearchHistory",
			"ghSearchRepo",
		]);
		for (const tool of OCTOCODE_DEFERRED_TOOLS)
			expect(getMcpToolExposure({ command: "x" }, tool, defaults)).toBe("deferred");
		for (const tool of DIRECT) expect(getMcpToolExposure({ command: "x" }, tool, defaults)).toBe("direct");
	});

	it("yields to an explicit server exposure and to a tool exposure in the config", () => {
		expect(getMcpToolExposure({ command: "x", exposure: "direct" }, "clasify", defaults)).toBe("direct");
		expect(getMcpToolExposure({ command: "x", toolExposure: { clasify: "hidden" } }, "clasify", defaults)).toBe(
			"hidden",
		);
		expect(getMcpToolExposure({ command: "x", toolExposure: { "gh*": "direct" } }, "ghSearchRepo", defaults)).toBe(
			"direct",
		);
	});

	it("counts the preset's defaults when the config sets no server exposure, so discovery is known before connecting", () => {
		const entry: McpServerEntry = { name: "octocode", config: { command: "x" }, source: "test" };
		expect(configuredExposures(entry, defaults)).toEqual(new Set(["direct", "deferred"]));
		expect(configuredExposures(entry)).toEqual(new Set(["direct"]));
		expect(hasIndirectTools(entry)).toBe(false);
		const explicit = { ...entry, config: { ...entry.config, exposure: "direct" as const } };
		expect(configuredExposures(explicit, defaults)).toEqual(new Set(["direct"]));
	});
});
