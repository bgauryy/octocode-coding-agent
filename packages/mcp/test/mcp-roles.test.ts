import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	it("counts a judge tool as read-only and exposes the research server's first one", () => {
		const roles = resolveToolRoles([
			server("research", { reader: ["read"], search: ["find"], judge: ["classify", "other"] }),
			server("plain", { judge: ["score"] }),
		]);
		expect([...roles.judges].sort()).toEqual(["mcp__plain__score", "mcp__research__classify", "mcp__research__other"]);
		expect(roles.readOnly.has("mcp__plain__score")).toBe(true);
		expect(roles.research?.judge).toBe("mcp__research__classify");
		expect(resolveToolRoles([server("r", { reader: ["read"], search: ["find"] })]).research).not.toHaveProperty(
			"judge",
		);
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
		expect(typeof validateMcpServerConfig("s", { command: "x", roles: { judge: ["j"] } })).toBe("object");
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

	it("leave every Octocode tool to the server: no exposure override, the inherited environment plus clone", () => {
		const octocode = recommendedPresets({}).find(({ name }) => name === "octocode")?.config;
		expect(octocode).toMatchObject({ enabled: true, inheritEnv: true, env: { OCTOCODE_ENABLE_CLONE: "true" } });
		expect(octocode && "toolExposure" in octocode).toBe(false);
		expect(octocode && "exposure" in octocode).toBe(false);
		// Graph tools and clasify follow the user's own environment and Octocode configuration, which the server loads.
		const env = (octocode as { env?: Record<string, string> } | undefined)?.env ?? {};
		for (const key of ["OCTOCODE_BETA", "OCTOCODE_CLASSIFICATION_API", "OCTOCODE_HOME", "ENABLE_LOCAL"])
			expect(env).not.toHaveProperty(key);
	});

	it("turn clone on by default, but leave a clone setting in the user's own environment to reach the server", () => {
		const envOf = (env: NodeJS.ProcessEnv) =>
			(recommendedPresets(env).find(({ name }) => name === "octocode")?.config as { env?: Record<string, string> })
				?.env;
		expect(envOf({})).toMatchObject({ OCTOCODE_ENABLE_CLONE: "true" });
		// The server inherits the user's value; ours would override it, so it is left out.
		expect(envOf({ OCTOCODE_ENABLE_CLONE: "false" })).not.toHaveProperty("OCTOCODE_ENABLE_CLONE");
		expect(envOf({ OCTOCODE_ENABLE_CLONE: "false" })).toMatchObject({ WORKSPACE_ROOT: "${workspace}" });
	});

	it("turn off through their environment flag", () => {
		const data = { name: "rec", enabledEnv: "REC_FLAG", command: "x" };
		expect(recommendedPreset(data, { REC_FLAG: "0" }).config?.enabled).toBe(false);
		expect(recommendedPreset(data, {}).config?.enabled).toBe(true);
		expect(() => recommendedPreset({ name: "rec", command: 1 })).toThrow(/recommended server data/);
	});

	it("with enabledByDefault false, stay off until their environment flag turns them on", () => {
		const data = { name: "rec", enabledEnv: "REC_FLAG", enabledByDefault: false, command: "x" };
		const enabled = (env: NodeJS.ProcessEnv) => recommendedPreset(data, env).config?.enabled;
		expect(enabled({})).toBe(false);
		expect(enabled({ REC_FLAG: "1" })).toBe(true);
		expect(enabled({ REC_FLAG: "0" })).toBe(false);
		expect(() => recommendedPreset({ ...data, enabledByDefault: "no" }, {})).toThrow(/enabledByDefault must be/);
	});

	it("include FreeLlama, off by default even where ollama is installed, on through OCTOCODE_MCP_FREELLAMA", () => {
		const bin = mkdtempSync(join(tmpdir(), "octocode-rec-path-"));
		const ollama = join(bin, "ollama");
		writeFileSync(ollama, "#!/bin/sh\n");
		chmodSync(ollama, 0o755);
		const freellama = (env: NodeJS.ProcessEnv) => recommendedPresets(env).find(({ name }) => name === "freellama");
		try {
			expect(freellama({ PATH: bin })?.config?.enabled).toBe(false);
		} finally {
			rmSync(bin, { recursive: true, force: true });
		}
		expect(freellama({})?.config).toMatchObject({
			enabled: false,
			install: { npm: "@octocodeai/freellama-mcp-server", bin: "freellama-mcp-server" },
		});
		expect(freellama({ OCTOCODE_MCP_FREELLAMA: "1" })?.config?.enabled).toBe(true);
		expect(recommendedPresets({})[0]?.name).toBe("octocode");
	});
});
