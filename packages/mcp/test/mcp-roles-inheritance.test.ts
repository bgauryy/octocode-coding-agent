import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../src/config.ts";
import { presetEntries } from "../src/preset.ts";
import { builtinPreset } from "../src/presets/index.ts";
import { resolveToolRoles } from "../src/roles.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
	const root = mkdtempSync(join(tmpdir(), "octocode-mcp-roles-"));
	roots.push(root);
	const options = { cwd: join(root, "project"), agentDir: join(root, "home"), projectTrusted: true };
	mkdirSync(options.cwd);
	mkdirSync(options.agentDir);
	const write = (file: string, servers: Record<string, unknown>) => {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ mcpServers: servers }));
	};
	const defaults = presetEntries(["octocode", "freellama"].map((name) => builtinPreset(name, {})));
	const defaultRoles = defaults.find((entry) => entry.name === "octocode")?.config.roles;
	return { options, write, defaults, defaultRoles, global: join(options.agentDir, "mcp.json") };
}

const octocodeOf = (servers: ReturnType<typeof loadMcpConfig>["servers"]) =>
	servers.find((entry) => entry.name === "octocode");

describe("roles of a replaced default entry", () => {
	it("keeps the default's roles when a user entry with its name sets none, so research stays named", () => {
		const { options, write, defaults, defaultRoles, global } = setup();
		expect(defaultRoles?.reader).toEqual(["localFetch"]);
		write(global, { octocode: { command: "node", args: ["/x/octocode-mcp/dist/index.js"] } });
		const { servers } = loadMcpConfig({ ...options, defaults });
		expect(octocodeOf(servers)).toMatchObject({ scope: "global", config: { command: "node", roles: defaultRoles } });
		expect(resolveToolRoles(servers).research).toMatchObject({
			server: "octocode",
			reader: "mcp__octocode__localFetch",
		});
	});

	it("clears them with an explicit empty roles object, and uses an entry's own roles as they are", () => {
		const { options, write, defaults, global } = setup();
		write(global, { octocode: { command: "node", roles: {} } });
		const cleared = loadMcpConfig({ ...options, defaults }).servers;
		expect(octocodeOf(cleared)?.config.roles).toEqual({});
		expect(resolveToolRoles(cleared).research).toBeUndefined();
		write(global, { octocode: { command: "node", roles: { readOnly: ["status"] } } });
		expect(octocodeOf(loadMcpConfig({ ...options, defaults }).servers)?.config.roles).toEqual({
			readOnly: ["status"],
		});
	});

	it("passes the replaced entry's roles down a user-then-project chain, cleared ones included", () => {
		const { options, write, defaults, defaultRoles, global } = setup();
		write(global, { octocode: { command: "node" } });
		write(join(options.cwd, ".octocode", "mcp.json"), { octocode: { command: "project-server" } });
		expect(octocodeOf(loadMcpConfig({ ...options, defaults }).servers)).toMatchObject({
			scope: "project",
			config: { command: "project-server", roles: defaultRoles },
		});
		write(global, { octocode: { command: "node", roles: {} } });
		expect(octocodeOf(loadMcpConfig({ ...options, defaults }).servers)?.config.roles).toEqual({});
	});

	it("keeps the project trust rule: inherited roles of a project entry count only in a trusted project", () => {
		const { options, write, defaults } = setup();
		write(join(options.cwd, ".octocode", "mcp.json"), { octocode: { command: "project-server" } });
		const entries = loadMcpConfig({ ...options, defaults }).servers;
		expect(resolveToolRoles(entries.map((entry) => ({ ...entry, trusted: false }))).research).toBeUndefined();
		expect(resolveToolRoles(entries.map((entry) => ({ ...entry, trusted: true }))).research?.server).toBe("octocode");
	});

	it("gives no roles to a replacement of a name that has no default entry", () => {
		const { options, write, defaults, global } = setup();
		write(global, { docs: { command: "docs", roles: { reader: ["read"], search: ["find"] } } });
		write(join(options.cwd, ".octocode", "mcp.json"), { docs: { command: "other" } });
		const docs = loadMcpConfig({ ...options, defaults }).servers.find((entry) => entry.name === "docs");
		expect(docs?.config.roles).toBeUndefined();
	});
});

describe("launch env of a replaced default entry", () => {
	const envOf = (servers: ReturnType<typeof loadMcpConfig>["servers"]) =>
		(octocodeOf(servers)?.config as { env?: Record<string, string> } | undefined)?.env;

	it("keeps the default's research roots under each key a local replacement leaves unset; its own values win", () => {
		const { options, write, defaults, global } = setup();
		write(global, { octocode: { command: "node", env: { WORKSPACE_ROOT: "/w", EXTRA: "1" } } });
		expect(envOf(loadMcpConfig({ ...options, defaults }).servers)).toEqual({
			WORKSPACE_ROOT: "/w",
			ALLOWED_PATHS: "${researchRoots}",
			OCTOCODE_TRUST_PROJECT_LSP_CONFIG: "${untrusted:false}",
			OCTOCODE_ENABLE_LOCAL: "true",
			OCTOCODE_ENABLE_CLONE: "true",
			EXTRA: "1",
		});
		// An explicit ALLOWED_PATHS is the one policy that replaces the roots.
		write(global, { octocode: { command: "node", env: { ALLOWED_PATHS: "/only" } } });
		expect(envOf(loadMcpConfig({ ...options, defaults }).servers)?.ALLOWED_PATHS).toBe("/only");
	});

	it("passes only the default's values down a chain, never a user entry's env into a project entry", () => {
		const { options, write, defaults, global } = setup();
		write(global, { octocode: { command: "node", env: { USER_TOKEN: "secret" } } });
		write(join(options.cwd, ".octocode", "mcp.json"), { octocode: { command: "project-server" } });
		const env = envOf(loadMcpConfig({ ...options, defaults }).servers);
		expect(env).not.toHaveProperty("USER_TOKEN");
		expect(env?.ALLOWED_PATHS).toBe("${researchRoots}");
	});

	it("gives a remote replacement no env", () => {
		const { options, write, defaults, global } = setup();
		write(global, { octocode: { url: "https://example.com/mcp" } });
		expect(envOf(loadMcpConfig({ ...options, defaults }).servers)).toBeUndefined();
	});
});
