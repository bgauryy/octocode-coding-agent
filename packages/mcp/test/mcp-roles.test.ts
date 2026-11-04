import { describe, expect, it } from "vitest";
import { recommendedPreset, recommendedPresets } from "../src/recommended/index.ts";
import { resolveToolRoles } from "../src/roles.ts";
import { validateMcpServerConfig } from "../src/servers.ts";

const server = (name: string, roles: object, extra: object = {}) => ({
	name,
	config: { command: "x", roles, ...extra },
});

describe("resolveToolRoles", () => {
	it("maps roles to full tool names and implies read-only for readers and searches", () => {
		const roles = resolveToolRoles([
			server("zeta", { reader: ["read"], search: ["find"] }),
			server("alpha-docs", { reader: ["get"], search: ["grep", "glob"], readOnly: ["list"] }, { description: "Docs" }),
			server("plain", { readOnly: ["status"] }),
		]);
		expect([...roles.readers].sort()).toEqual(["mcp__alpha_docs__get", "mcp__zeta__read"]);
		expect(roles.searches.has("mcp__alpha_docs__glob")).toBe(true);
		expect([...roles.readOnly]).toContain("mcp__plain__status");
		expect([...roles.readOnly]).toContain("mcp__zeta__find");
		expect(roles.research).toEqual({
			server: "alpha-docs",
			prefix: "mcp__alpha_docs__",
			reader: "mcp__alpha_docs__get",
			search: ["mcp__alpha_docs__grep", "mcp__alpha_docs__glob"],
			description: "Docs",
		});
	});

	it("counts a project entry's roles only when the project is trusted", () => {
		const entry = { ...server("proj", { reader: ["read"], search: ["find"] }), scope: "project" };
		expect(resolveToolRoles([{ ...entry, trusted: false }]).readOnly.size).toBe(0);
		expect(resolveToolRoles([entry]).research).toBeUndefined();
		expect(resolveToolRoles([{ ...entry, trusted: true }]).research?.server).toBe("proj");
	});
});

describe("roles and install validation", () => {
	it("accepts roles and install, and names a wrong field", () => {
		expect(
			typeof validateMcpServerConfig("s", {
				command: "x",
				roles: { reader: ["r"] },
				install: { npm: "@a/b", version: "1.0.0" },
			}),
		).toBe("object");
		expect(validateMcpServerConfig("s", { command: "x", roles: { writer: ["w"] } })).toMatch(
			/roles\.writer is not a role/,
		);
		expect(validateMcpServerConfig("s", { command: "x", roles: { reader: ["a*"] } })).toMatch(/without "\*"/);
		expect(validateMcpServerConfig("s", { command: "x", install: { npm: "Bad Name", version: "1" } })).toMatch(
			/install\.npm/,
		);
		expect(validateMcpServerConfig("s", { url: "https://x.test", install: { npm: "a", version: "1" } })).toMatch(
			/install needs a stdio server/,
		);
	});
});

describe("recommended servers", () => {
	it("are valid entries whose roles name a research server", () => {
		const presets = recommendedPresets({});
		expect(presets.length).toBeGreaterThan(0);
		const roles = resolveToolRoles(presets.map(({ name, config }) => ({ name, config: config!, scope: "default" })));
		expect(roles.research?.server).toBe(presets[0].name);
		for (const { config } of presets) expect(config && "install" in config && config.install?.version).toBeTruthy();
	});

	it("turn off through their environment flag", () => {
		const data = { name: "rec", enabledEnv: "REC_FLAG", command: "x" };
		expect(recommendedPreset(data, { REC_FLAG: "0" }).config?.enabled).toBe(false);
		expect(recommendedPreset(data, {}).config?.enabled).toBe(true);
		expect(() => recommendedPreset({ name: "rec", command: 1 })).toThrow(/recommended server data/);
	});
});
