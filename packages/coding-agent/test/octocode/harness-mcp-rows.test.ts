import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/octocode/mcp-host/core-install.ts";
import { loadMcpServers } from "../../src/configuration/adapters/mcp.ts";
import { formatStatus } from "../../../mcp/src/report.ts";
import { mcpServerState, mcpServerToolCount } from "../../../mcp/src/row.ts";
import { exposureOf } from "../../../mcp/src/exposure.ts";
import { projectMcpConfigPath } from "../../../mcp/src/paths.ts";
import type { McpServer } from "../../../mcp/src/server.ts";
import type { McpExtensionState } from "../../../mcp/src/state.ts";
import type { McpServerStatus } from "../../../mcp/src/api.ts";
import { mcpItems } from "../../src/octocode/harness/mcp-items.ts";
import { createMcpToolsSource } from "../../src/octocode/harness/mcp-tools.ts";
import { HarnessPicker } from "../../src/octocode/harness/picker.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { initTheme, theme } from "../../src/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { type Sandbox, createSandbox, write } from "../discovery/fixtures.ts";
import { configuration } from "../configuration/helpers.ts";
import { trustFolder } from "./helpers.ts";

beforeAll(() => initTheme("dark"));

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

const globalFile = () => path.join(sandbox.home, ".octocode", "mcp.json");
const projectFile = () => projectMcpConfigPath(sandbox.cwd);
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

describe("one row formatter for /mcp list, /harness and /configuration list mcp", () => {
	it("shows the same facts on the three surfaces for global, project, override, disabled and unconnected servers", async () => {
		trustFolder(sandbox.cwd);
		write(
			globalFile(),
			JSON.stringify({
				mcpServers: {
					docs: { command: "docs-server" },
					off: { command: "off-server", enabled: false },
					base: { command: "base-server", exposure: "hidden" },
					idle: { command: "idle-server", defaultActive: false },
				},
			}),
		);
		write(
			projectFile(),
			JSON.stringify({
				mcpServers: { tracker: { command: "tracker-server", exposure: "deferred" }, base: { enabled: false } },
			}),
		);
		const entries = loadMcpServers({ agentDir: sandbox.agentDir, cwd: sandbox.cwd, projectTrusted: true }).servers;
		const connected = { state: "connected", tools: [{ name: "a" }, { name: "b" }] } as never;
		const servers = entries
			.filter((entry) => ["docs", "off", "base", "idle", "tracker"].includes(entry.name))
			.map((entry): McpServer => {
				if (entry.name === "idle") return { entry, unselected: true };
				return { entry, ...(entry.name === "off" ? {} : { connection: connected }) };
			});
		expect(servers.map((server) => server.entry.name).sort()).toEqual(["base", "docs", "idle", "off", "tracker"]);
		const status: McpServerStatus[] = servers.map((server) => ({
			name: server.entry.name,
			enabled: server.entry.config.enabled !== false,
			state: mcpServerState(server),
			exposure: exposureOf(server.entry),
			defaultActive: server.entry.config.defaultActive !== false,
			toolCount: mcpServerToolCount(server),
			source: server.entry.source,
			...(server.entry.scope ? { scope: server.entry.scope } : {}),
		}));

		const harness = new Map(mcpItems(status, sandbox.home).map((item) => [item.name, item]));
		const config = new Map(
			(await configuration(sandbox, { live: { mcpStatus: () => status } }).list({ kind: "mcp" } as never)).map(
				(entry) => [entry.label, entry],
			),
		);
		const listed = new Map(
			formatStatus({ servers, configErrors: [], overridden: [] } as unknown as McpExtensionState)
				.split("\n")
				.map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)] as const),
		);
		// The facts, order aside: group, state, tool count, exposure, who gets it, source.
		const tokens = (text: string) =>
			text
				.replace(/^enabled · /, "")
				.replace(/ — .*$/, "")
				.split(" · ")
				.sort();
		for (const name of ["docs", "off", "base", "idle", "tracker"]) {
			const item = harness.get(name)!;
			expect(tokens(config.get(name)!.detail ?? "")).toEqual(tokens(item.detail ?? ""));
			expect(tokens(listed.get(name)!)).toEqual(tokens(item.detail ?? ""));
			expect(config.get(name)!.value).toBe(item.on);
			expect(listed.get(name)!.startsWith("enabled · ")).toBe(item.on);
		}
		expect(harness.get("docs")?.detail).toMatch(/^Global · connected · 2 tools · direct · every agent · .*mcp\.json$/);
		expect(harness.get("tracker")?.detail).toMatch(
			/^Workspace · not checked · 2 tools · deferred · every agent · .*mcp\.json$/,
		);
		expect(harness.get("idle")?.detail).toContain("not selected · 0 tools · direct · only agents that name it");
		expect(harness.get("off")?.detail).toContain("disabled · 0 tools");
		// A project override that only switches a server keeps the group of the file that defines it.
		expect(harness.get("base")).toMatchObject({ on: false });
		expect(harness.get("base")?.detail).toMatch(/^Global · disabled · 0 tools · hidden · every agent/);
	});

	it("words a server with no session state as not connected", async () => {
		write(globalFile(), JSON.stringify({ mcpServers: { docs: { command: "docs-server" } } }));
		const entries = await configuration(sandbox).list({ kind: "mcp" } as never);
		expect(entries.find((entry) => entry.label === "docs")?.detail).toMatch(
			/^Global · not connected · 0 tools · direct · every agent · .*mcp\.json$/,
		);
	});
});

describe("the server's exposure row in the MCP tools view", () => {
	const ENTER = "\r";
	const DOWN = "\x1b[B";
	const TAB = "\t";

	function open(options: { trusted?: boolean; scope?: "project" } = {}) {
		const projectTrusted = options.trusted ?? true;
		const picker = new HarnessPicker(
			{
				items: [
					{ id: "mcp:docs", name: "docs", kind: "mcp", host: "mcp", depth: 0, label: "docs", on: true, detail: "" },
				],
				section: "mcp",
				apply: vi.fn(() => "Saved"),
				paths: { global: "g", project: "p" },
				height: 24,
				done: vi.fn(),
				requestRender: vi.fn(),
				mcpTools: createMcpToolsSource({
					ctx: () => ({
						cwd: sandbox.cwd,
						agentDir: sandbox.agentDir,
						home: sandbox.home,
						settings: SettingsManager.create(sandbox.cwd, sandbox.agentDir, { projectTrusted }),
						projectTrusted,
					}),
					live: () => undefined,
				}),
			},
			theme,
			new KeybindingsManager(),
		);
		if (options.scope === "project") picker.handleInput(TAB);
		picker.handleInput(ENTER);
		return {
			keys: (...data: string[]) => data.forEach((key) => picker.handleInput(key)),
			text: () => stripAnsi(picker.render(100).join("\n")),
		};
	}
	const docs = (file = globalFile()) => readJson(file).mcpServers.docs;
	beforeEach(() => write(globalFile(), JSON.stringify({ mcpServers: { docs: { command: "docs-server" } } })));

	it("shows Default for tools and Tab cycles direct, deferred, hidden, direct, writing exposure each time", () => {
		const { keys, text } = open();
		expect(text()).toContain("Default for tools: direct");
		keys(DOWN, TAB);
		expect(text()).toContain("Default for tools: deferred");
		expect(docs()).toEqual({ command: "docs-server", exposure: "deferred" });
		keys(TAB);
		expect(docs().exposure).toBe("hidden");
		keys(TAB);
		// The default is not written.
		expect(docs()).toEqual({ command: "docs-server" });
		expect(text()).toContain("Default for tools: direct");
	});

	it("writes a project override when project scope is chosen in a trusted folder", () => {
		trustFolder(sandbox.cwd);
		const { keys } = open({ scope: "project" });
		keys(DOWN, TAB);
		expect(docs(projectFile())).toEqual({ exposure: "deferred" });
		expect(docs()).toEqual({ command: "docs-server" });
	});

	it("refuses project scope in an untrusted folder and writes nothing", () => {
		const { keys, text } = open({ trusted: false, scope: "project" });
		keys(DOWN, TAB);
		expect(text()).toContain("not trusted");
		expect(fs.existsSync(projectFile())).toBe(false);
		expect(docs()).toEqual({ command: "docs-server" });
	});
});
