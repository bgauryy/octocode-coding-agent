import { describe, expect, it } from "vitest";
import { SessionToolLoadout } from "../src/core/agent-session/tool-loadout.ts";

/** A loadout with only a selection: `selectsTools` reads nothing else. */
const loadout = (allowedToolNames?: string[], excludedToolNames?: string[]) =>
	new SessionToolLoadout({ session: {} as never, cwd: "/" }, { allowedToolNames, excludedToolNames });

const BROWSER = "mcp__browser__";

describe("SessionToolLoadout.selectsTools", () => {
	it("selects tools active by default without an allowlist, and others only when a modifier names one", () => {
		expect(loadout().selectsTools("mcp__docs__", true, [])).toBe(true);
		expect(loadout().selectsTools(BROWSER, false, [])).toBe(false);
		expect(loadout().selectsTools(BROWSER, false, ["+mcp__browser__open"])).toBe(true);
		expect(loadout().selectsTools(BROWSER, false, ["mcp__browser__open"])).toBe(true);
		expect(loadout().selectsTools(BROWSER, false, ["-mcp__browser__open", "+bash"])).toBe(false);
	});

	it("needs an allowlist entry naming the prefix for tools off by default; broad wildcards do not select them", () => {
		expect(loadout(["mcp__browser__*"]).selectsTools(BROWSER, false, [])).toBe(true);
		expect(loadout(["mcp__browser__open"]).selectsTools(BROWSER, false, [])).toBe(true);
		for (const broad of ["mcp__*", "*"]) expect(loadout([broad]).selectsTools(BROWSER, false, []), broad).toBe(false);
		expect(loadout(["bash"]).selectsTools(BROWSER, false, ["+mcp__browser__open"])).toBe(false);
	});

	it("selects tools active by default through any allowlist entry that can match them", () => {
		for (const entry of ["mcp__*", "*", "mcp__docs__search", "mcp__docs__s*"])
			expect(loadout([entry]).selectsTools("mcp__docs__", true, []), entry).toBe(true);
		expect(loadout(["bash", "mcp__other__*"]).selectsTools("mcp__docs__", true, [])).toBe(false);
		expect(loadout([]).selectsTools("mcp__docs__", true, [])).toBe(false);
	});

	it("drops a prefix an exclusion covers entirely, and only then", () => {
		expect(loadout(undefined, ["mcp__browser__*"]).selectsTools(BROWSER, true, [])).toBe(false);
		expect(loadout(["mcp__browser__*"], ["mcp__*"]).selectsTools(BROWSER, false, [])).toBe(false);
		expect(loadout(undefined, ["mcp__browser__open"]).selectsTools(BROWSER, true, [])).toBe(true);
	});
});
