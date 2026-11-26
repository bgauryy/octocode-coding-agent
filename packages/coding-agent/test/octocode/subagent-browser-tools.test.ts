import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publishToolRoles, resolveToolRoles } from "../../../mcp/src/roles.ts";
import { builtinPresets } from "../../../mcp/src/presets/index.ts";
import { RESEARCH } from "./research-roles.ts";
import { matchesTool } from "../../src/octocode/subagents/profile-tools.ts";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { tmp } from "./helpers.ts";

/** The bundled Octocode server entry, with the roles a session publishes for it. */
const preset = builtinPresets().find((entry) => entry.config?.roles)!;
const octocode = { name: preset.name, config: preset.config! };

describe("the browser role's Octocode tools", () => {
	beforeEach(() => publishToolRoles(resolveToolRoles([octocode])));
	afterEach(() => publishToolRoles(resolveToolRoles([])));

	it("admits the whole research server beside its browser tools, and no other server", () => {
		const allowed = (loadProfiles(tmp(), tmp(), false, {}).get("browser")!.tools ?? "").split(",");
		// Every specialist but lean gets the research server: its reader and search tools, and any other tool it ships.
		for (const tool of [RESEARCH.reader, ...RESEARCH.search, `${RESEARCH.prefix}any_other_tool`])
			expect(matchesTool(allowed, tool), tool).toBe(true);
		expect(matchesTool(allowed, "mcp__browser__open")).toBe(true);
		// Naming two servers keeps every other server out.
		expect(matchesTool(allowed, "mcp__freellama__chat")).toBe(false);
		expect(matchesTool(allowed, "mcp__desktop__launch_app")).toBe(false);
	});
});
