import "../mcp-host.ts";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../../../mcp/src/config.ts";
import { configDiscovery, discoveryInput } from "../../src/core/discovery/service.ts";
import type { ConfigItem } from "../../src/core/discovery/types.ts";
import { installOctocodeDiscovery } from "../../src/octocode/discovery/index.ts";
import { hookFiles } from "../../src/octocode/hooks/config.ts";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";
import { createSandbox, type Sandbox, write } from "./fixtures.ts";

/** Pi files an Octocode session reads: set only HOME, because an explicit OCTOCODE_HOME turns the Pi roots off. */
let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
	installOctocodeDiscovery();
});
afterEach(() => sandbox.cleanup());

const servers = (names: Record<string, unknown>) => JSON.stringify({ mcpServers: names });
const cmd = (command: string) => ({ command });
const input = (options: { trusted?: boolean; untrusted?: boolean; plugins?: never } = {}) =>
	discoveryInput({
		cwd: sandbox.cwd,
		agentDir: sandbox.agentDir,
		projectTrusted: options.trusted ?? true,
		...(options.untrusted ? { includeUntrusted: true } : {}),
	});
const summary = (items: ConfigItem[]) =>
	items.map(
		(item) =>
			`${item.name}|${item.provenance.product}|${item.provenance.scope}|${item.provenance.origin}|${item.loaded ? "loaded" : (item.provenance.notLoaded ?? "shadowed")}`,
	);

describe("MCP servers through discovery", () => {
	function writeFiles() {
		write(join(sandbox.home, ".octocode", "mcp.json"), servers({ docs: cmd("octocode-docs"), mine: cmd("mine") }));
		write(join(sandbox.piAgentDir, "mcp.json"), servers({ docs: cmd("pi-docs"), legacy: cmd("legacy") }));
		write(join(sandbox.cwd, ".pi", "mcp.json"), servers({ "pi-project": cmd("pi-project") }));
		write(join(sandbox.cwd, ".octocode", "mcp.json"), servers({ docs: { enabled: false }, local: cmd("local") }));
	}

	it("lists Octocode and Pi files with provenance, Octocode first, and a control-only override apart from definitions", () => {
		writeFiles();
		const items = configDiscovery.discover("mcp", input());
		expect(summary(items).sort()).toEqual(
			[
				"docs|octocode|global|octocode|loaded",
				"docs|octocode|project|octocode|loaded",
				"docs|pi|global|pi|shadowed",
				"legacy|pi|global|pi|loaded",
				"local|octocode|project|octocode|loaded",
				"mine|octocode|global|octocode|loaded",
				"pi-project|pi|project|pi|loaded",
			].sort(),
		);
		const override = items.find((item) => item.role === "override");
		expect(override?.provenance.path).toBe(join(sandbox.cwd, ".octocode", "mcp.json"));
		expect(
			items.find((item) => item.name === "docs" && item.provenance.product === "pi")?.provenance.shadowedBy,
		).toMatchObject({
			product: "octocode",
			scope: "global",
		});
		// The loader reads the same files: the same server names with the same winners.
		const loaded = loadMcpConfig({ agentDir: sandbox.agentDir, cwd: sandbox.cwd, projectTrusted: true });
		expect(loaded.servers.map((server) => server.name).sort()).toEqual([
			"docs",
			"legacy",
			"local",
			"mine",
			"pi-project",
		]);
		expect(loaded.servers.find((server) => server.name === "docs")?.config).toMatchObject({
			command: "octocode-docs",
			enabled: false,
		});
	});

	it("keeps project files out of an untrusted folder, and lists them as not loaded for display", () => {
		writeFiles();
		expect(
			summary(configDiscovery.discover("mcp", input({ trusted: false }))).some((row) => row.includes("|project|")),
		).toBe(false);
		const shown = configDiscovery.discover("mcp", input({ trusted: false, untrusted: true }));
		expect(summary(shown).filter((row) => row.includes("|project|"))).toEqual(
			expect.arrayContaining(["pi-project|pi|project|pi|untrusted", "local|octocode|project|octocode|untrusted"]),
		);
	});

	it("reports a file that does not parse as one not loaded item and still lists the others", () => {
		write(join(sandbox.piAgentDir, "mcp.json"), "{ nope");
		write(join(sandbox.home, ".octocode", "mcp.json"), servers({ mine: cmd("mine") }));
		const items = configDiscovery.discover("mcp", input({ trusted: false }));
		expect(items.map((item) => [item.name === "mine", item.loaded])).toContainEqual([true, true]);
		expect(items.find((item) => !item.loaded)?.diagnostics[0]).toContain(join(sandbox.piAgentDir, "mcp.json"));
	});
});

describe("agents, hooks and plugins through discovery", () => {
	const profile = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\nYou are ${name}.\n`;

	it("lists profiles, a trusted project profile above a global one with the global copy shadowed", () => {
		write(join(sandbox.agentDir, "agents", "helper.md"), profile("helper"));
		write(join(sandbox.cwd, ".octocode", "agents", "helper.md"), profile("helper"));
		const rows = summary(configDiscovery.discover("agent", input()));
		expect(rows).toContain("helper|octocode|project|octocode|loaded");
		expect(rows).toContain("helper|octocode|global|octocode|shadowed");
		expect(rows.some((row) => row.includes("|builtin|bundled|loaded"))).toBe(true);
		expect(
			summary(configDiscovery.discover("agent", input({ trusted: false }))).some((row) => row.includes("|project|")),
		).toBe(false);
		// The loader reads the same list: the project profile replaces the global one and is reported.
		const shadows: string[] = [];
		const profiles = loadProfiles(sandbox.cwd, sandbox.home, true, process.env, undefined, (name) =>
			shadows.push(name),
		);
		expect(profiles.get("helper")?.name).toBe("helper");
		expect(shadows).toEqual(["helper"]);
	});

	it("lists hook files of every dialect, Pi hook code as not loaded, and hookFiles reads the same list", () => {
		write(join(sandbox.home, ".claude", "settings.json"), "{}");
		write(join(sandbox.agentDir, "hooks.json"), "{}");
		write(join(sandbox.cwd, ".octocode", "hooks.json"), "{}");
		write(join(sandbox.cwd, ".codex", "hooks.json"), "{}");
		write(join(sandbox.piAgentDir, "hooks", "mine.ts"), "export default () => {};\n");
		const items = configDiscovery.discover("hook", input());
		const rows = summary(items);
		expect(rows).toEqual(
			expect.arrayContaining([
				"settings.json|octocode|global|claude|switched-off",
				"hooks.json|octocode|global|octocode|loaded",
				"hooks.json|octocode|project|octocode|loaded",
				"hooks.json|octocode|project|codex|switched-off",
				"mine.ts|pi|global|pi|ignored-code",
			]),
		);
		const loaded = items
			.filter((item) => item.loaded || item.provenance.notLoaded === "switched-off")
			.map((item) => item.provenance.path);
		expect(hookFiles(sandbox.cwd, true, sandbox.home)).toEqual(loaded);
		expect(hookFiles(sandbox.cwd, false, sandbox.home).every((file) => !file.startsWith(sandbox.cwd))).toBe(true);
	});

	it("lists configured plugins with their manifest name and a switched-off plugin as not loaded", () => {
		const plugin = write(
			join(sandbox.home, "plugins", "review-kit", ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "review-kit" }),
		);
		const dir = join(plugin, "..", "..");
		const rows = summary(
			configDiscovery.discover("plugin", { ...input(), plugins: [{ path: dir, protocol: "claude" }] }),
		);
		expect(rows).toEqual(["review-kit|octocode|global|plugin|loaded"]);
		const off = configDiscovery.discover("plugin", {
			...input(),
			plugins: [{ path: dir, protocol: "claude", enabled: false }],
		});
		expect(off.map((item) => [item.loaded, item.diagnostics[0]])).toEqual([[false, "plugin is off"]]);
	});

	it("returns every owned kind from discoverAll", () => {
		write(join(sandbox.home, ".octocode", "mcp.json"), servers({ mine: cmd("mine") }));
		const all = configDiscovery.discoverAll(input());
		expect([...all.keys()]).toEqual(expect.arrayContaining(["agent", "hook", "plugin", "mcp", "model", "setting"]));
		expect(all.get("mcp")?.map((item) => item.name)).toEqual(["mine"]);
	});
});
