import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recommendedPresets } from "../../../mcp/src/recommended/index.ts";
import { publishToolRoles, resolveToolRoles } from "../../../mcp/src/roles.ts";
import { matchesTool } from "../../src/octocode/subagents/profile-tools.ts";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { tmp } from "./helpers.ts";

/** The bundled Octocode server entry, with the roles a session publishes for it. */
const preset = recommendedPresets().find((entry) => entry.name === "octocode")!;
const octocode = { name: preset.name, config: preset.config! };

describe("the browser role's Octocode tools", () => {
	beforeEach(() => publishToolRoles(resolveToolRoles([octocode])));
	afterEach(() => publishToolRoles(resolveToolRoles([])));

	it("keeps local search, read and the judge for its saved captures, and drops the GitHub tools", () => {
		const allowed = (loadProfiles(tmp(), tmp(), false, {}).get("browser")!.tools ?? "").split(",");
		const octocodeTools = allowed.filter((name) => name.startsWith("mcp__octocode__")).sort();
		expect(octocodeTools).toEqual([
			"mcp__octocode__astSearch",
			"mcp__octocode__clasify",
			"mcp__octocode__localFetch",
			"mcp__octocode__localSearch",
			"mcp__octocode__lspSearch",
			"mcp__octocode__structureSearch",
		]);
		// No pattern in the list reaches them either: the role names one MCP server, so it does not keep every server.
		const dropped = [
			"ghSearchRepo",
			"ghSearchCode",
			"ghStructure",
			"ghGetFileContent",
			"ghSearchHistory",
			"ghGetHistoryItem",
		];
		expect(octocode.config.roles?.readOnly).toEqual(expect.arrayContaining(dropped));
		for (const tool of dropped) expect(matchesTool(allowed, `mcp__octocode__${tool}`)).toBe(false);
		expect(matchesTool(allowed, "mcp__browser__open")).toBe(true);
	});
});
