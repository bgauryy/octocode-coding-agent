import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerToolStates } from "../../../mcp/src/api.ts";
import { projectMcpConfigPath } from "../../../mcp/src/paths.ts";
import type { InventoryItem } from "../../src/octocode/harness/inventory.ts";
import { createMcpToolsSource } from "../../src/octocode/harness/mcp-tools.ts";
import { HarnessPicker } from "../../src/octocode/harness/picker.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { pinTool } from "../../src/octocode/web-daemon/tool-exposure.ts";
import { initTheme, theme } from "../../src/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { trustFolder } from "./helpers.ts";

beforeAll(() => initTheme("dark"));

const ENTER = "\r";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const ESC = "\x1b";
const TAB = "\t";
const SPACE = " ";

let root: string;
let agentDir: string;
let cwd: string;
let live: McpServerToolStates[] | undefined;

const writeJson = (file: string, value: unknown) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
};
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const globalMcp = () => path.join(agentDir, "mcp.json");
const docs = (file = globalMcp()) => readJson(file).mcpServers.docs;

const connected = (...tools: McpServerToolStates["tools"]): McpServerToolStates[] => [
	{ server: "docs", connected: true, saved: true, tools },
];
const session = () =>
	connected(
		{ name: "search", state: "direct", decidedBy: "default" },
		{ name: "read", state: "direct", decidedBy: "default" },
	);

const server: InventoryItem = {
	id: "mcp:docs",
	name: "docs",
	kind: "mcp",
	host: "mcp",
	depth: 0,
	label: "docs",
	on: true,
	detail: "Global · connected · 2 tools · direct",
};

/** The picker on its MCPs section, with the tool rows reading and writing the isolated folders. */
function open(options: { trusted?: boolean; scope?: "project" } = {}) {
	const projectTrusted = options.trusted ?? true;
	const done = vi.fn();
	const picker = new HarnessPicker(
		{
			items: [server],
			section: "mcp",
			apply: vi.fn(() => "Saved"),
			paths: { global: "~/settings.json", project: ".octocode/settings.json" },
			height: 24,
			done,
			requestRender: vi.fn(),
			mcpTools: createMcpToolsSource({
				ctx: () => ({
					cwd,
					agentDir,
					settings: SettingsManager.create(cwd, agentDir, { projectTrusted }),
					projectTrusted,
				}),
				live: () => live,
			}),
		},
		theme,
		new KeybindingsManager(),
	);
	if (options.scope === "project") picker.handleInput(TAB);
	picker.handleInput(ENTER);
	const keys = (...data: string[]) => data.forEach((key) => picker.handleInput(key));
	const text = () => stripAnsi(picker.render(100).join("\n"));
	return { picker, keys, text, done };
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-harness-mcp-tools-"));
	agentDir = path.join(root, "agent");
	cwd = path.join(root, "work");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(path.join(cwd, ".octocode"), { recursive: true });
	// Its own home and trust database: the suite's default one trusts the whole temp folder.
	vi.stubEnv("HOME", path.join(root, "user"));
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	writeJson(globalMcp(), { mcpServers: { docs: { command: "docs-server" } } });
	live = session();
});
afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("opening a server's tools", () => {
	it("lists each tool with its exposure and the Available to row, and leaves with ← or Esc", () => {
		const { keys, text, done } = open();
		expect(text()).toContain("Harness › MCPs › docs");
		expect(text()).toContain("Available to: every agent");
		expect(text()).toMatch(/\[x\] read\s+direct/);
		expect(text()).toMatch(/\[x\] search\s+direct/);
		keys(LEFT);
		expect(text()).not.toContain("Available to");
		expect(text()).toContain("[x] docs");
		keys(ENTER, ESC);
		expect(text()).not.toContain("Available to");
		// Esc went back one level; it did not close the picker.
		expect(done).not.toHaveBeenCalled();
	});

	it("lists only pinned tools and says to connect when the server is not connected", () => {
		writeJson(globalMcp(), {
			mcpServers: { docs: { command: "docs-server", toolExposure: { legacy: "hidden", "get_*": "hidden" } } },
		});
		live = undefined;
		const { text } = open();
		expect(text()).toContain("not connected");
		expect(text()).toContain("Connect to list tools");
		expect(text()).toMatch(/\[ \] legacy\s+hidden · pinned/);
		// A pattern is not a tool name.
		expect(text()).not.toContain("get_*");
	});
});

describe("switching a tool", () => {
	it("Space hides a tool by writing toolExposure to the server's file, and brings it back by removing the pin", () => {
		const { keys, text } = open();
		// Rows: Available to, read, search.
		keys(DOWN, DOWN, SPACE);
		expect(docs()).toEqual({ command: "docs-server", toolExposure: { read: "hidden" } });
		expect(text()).toMatch(/\[ \] read\s+hidden · pinned · from the next session/);
		expect(text()).toContain("running sessions keep what they declared");
		keys(SPACE);
		expect(docs()).toEqual({ command: "docs-server" });
		expect(text()).toMatch(/\[x\] read\s+direct/);
	});

	it("Space pins direct when the tool is hidden by something that is not a pin", () => {
		writeJson(globalMcp(), { mcpServers: { docs: { command: "docs-server", exposure: "hidden" } } });
		live = connected({ name: "read", state: "hidden", decidedBy: "server" });
		const { keys } = open();
		keys(DOWN, DOWN, SPACE);
		expect(docs().toolExposure).toEqual({ read: "direct" });
		// The server's default is hidden too, so removing the pin would change nothing: Space keeps pinning direct.
		keys(SPACE);
		expect(docs().toolExposure).toEqual({ read: "hidden" });
		keys(SPACE);
		expect(docs().toolExposure).toEqual({ read: "direct" });
	});

	it("Tab cycles direct, deferred, hidden and back, writing each pin", () => {
		const { keys, text } = open();
		const pins = [];
		keys(DOWN, DOWN);
		for (let step = 0; step < 4; step += 1) {
			keys(TAB);
			pins.push(docs().toolExposure?.read);
		}
		expect(pins).toEqual(["deferred", "hidden", "direct", "deferred"]);
		expect(text()).toMatch(/\[~\] read\s+deferred · pinned/);
	});

	it("keeps the other pins and the rest of the file", () => {
		writeJson(globalMcp(), {
			mcpServers: { docs: { command: "docs-server", env: { A: "1" }, toolExposure: { search: "deferred" } } },
			other: true,
		});
		const { keys } = open();
		keys(DOWN, DOWN, SPACE);
		expect(readJson(globalMcp())).toEqual({
			mcpServers: {
				docs: { command: "docs-server", env: { A: "1" }, toolExposure: { read: "hidden", search: "deferred" } },
			},
			other: true,
		});
	});

	it("writes the web Tools panel's file content for the same pin", async () => {
		const { keys } = open();
		keys(DOWN, DOWN, TAB, TAB);
		const fromPicker = readJson(globalMcp());
		writeJson(globalMcp(), { mcpServers: { docs: { command: "docs-server" } } });
		await pinTool(
			{ kind: "mcp", server: "docs", tool: "read", pin: "hidden", scope: "global" },
			{ agentDir, actor: "web:test" },
		);
		expect(readJson(globalMcp())).toEqual(fromPicker);
	});
});

describe("Available to", () => {
	it("writes defaultActive false for 'only agents that name it' and clears it for 'every agent'", () => {
		const { keys, text } = open();
		keys(SPACE);
		expect(docs()).toEqual({ command: "docs-server", defaultActive: false });
		expect(text()).toContain("Available to: only agents that name it");
		expect(text()).toContain("profile tools: name mcp__docs__");
		keys(SPACE);
		expect(docs()).toEqual({ command: "docs-server" });
		expect(text()).toContain("Available to: every agent");
	});

	it("reads the saved choice when the view opens", () => {
		writeJson(globalMcp(), { mcpServers: { docs: { command: "docs-server", defaultActive: false } } });
		expect(open().text()).toContain("Available to: only agents that name it");
	});
});

describe("where a change is written", () => {
	it("writes a project override, leaving the global server as it is, when project scope is chosen in a trusted folder", () => {
		trustFolder(cwd);
		const { keys } = open({ scope: "project" });
		keys(DOWN, DOWN, SPACE);
		expect(docs(projectMcpConfigPath(cwd))).toEqual({ toolExposure: { read: "hidden" } });
		expect(docs()).toEqual({ command: "docs-server" });
	});

	it("refuses project scope in an untrusted folder and writes nothing", () => {
		const { keys, text } = open({ trusted: false, scope: "project" });
		keys(DOWN, DOWN, SPACE);
		expect(text()).toContain("not trusted");
		expect(fs.existsSync(projectMcpConfigPath(cwd))).toBe(false);
		expect(docs()).toEqual({ command: "docs-server" });
	});

	it("writes a project server's own file when the global scope is chosen", () => {
		trustFolder(cwd);
		writeJson(projectMcpConfigPath(cwd), { mcpServers: { docs: { command: "project-docs" } } });
		const { keys } = open();
		keys(DOWN, DOWN, SPACE);
		expect(docs(projectMcpConfigPath(cwd))).toEqual({ command: "project-docs", toolExposure: { read: "hidden" } });
	});

	it("does not offer a switch for a server no configuration file holds", () => {
		live = [
			{
				server: "docs",
				connected: true,
				saved: false,
				tools: [{ name: "run", state: "direct", decidedBy: "default" }],
			},
		];
		writeJson(globalMcp(), { mcpServers: {} });
		const { keys, text } = open();
		keys(DOWN, DOWN, SPACE);
		expect(text()).toContain("not in a configuration file");
		expect(docs()).toBeUndefined();
	});
});

describe("Enter without the tools source", () => {
	it("keeps switching the server as before", () => {
		const apply = vi.fn(() => "Saved");
		const picker = new HarnessPicker(
			{
				items: [server],
				section: "mcp",
				apply,
				paths: { global: "g", project: "p" },
				height: 20,
				done: vi.fn(),
				requestRender: vi.fn(),
			},
			theme,
			new KeybindingsManager(),
		);
		picker.handleInput(ENTER);
		expect(apply).toHaveBeenCalledOnce();
	});
});

describe("usage audit of a server's tools", () => {
	const audited = () =>
		connected(
			{
				name: "search",
				state: "direct",
				decidedBy: "usage",
				audit: { declared: 8, called: 3, used: 1, refused: 0, rate: 0.125, lastUsed: "2026-11-14", reason: "promoted" },
			},
			{
				name: "read",
				state: "deferred",
				decidedBy: "usage",
				audit: { declared: 8, called: 0, used: 0, refused: 0, rate: 0, reason: "unused" },
			},
			{ name: "plain", state: "direct", decidedBy: "default" },
		);

	it("carries each tool's audit on its row", () => {
		live = audited();
		const source = createMcpToolsSource({
			ctx: () => ({
				cwd,
				agentDir,
				settings: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
				projectTrusted: true,
			}),
			live: () => live,
		});
		const rows = source.view("docs", "global").tools;
		expect(rows.find((row) => row.name === "search")?.audit).toMatchObject({ rate: 0.125, lastUsed: "2026-11-14" });
		expect(rows.find((row) => row.name === "read")?.audit).toMatchObject({ reason: "unused" });
		expect(rows.find((row) => row.name === "plain")?.audit).toBeUndefined();
	});

	it("shows the rate, the last day used and the reason beside the exposure", () => {
		live = audited();
		const { text } = open();
		expect(text()).toMatch(/\[x\] search\s+direct · 12\.5% of 8 sessions · 3 calls · last 2026-11-14 · promoted/);
		expect(text()).toMatch(/\[~\] read\s+deferred · 0\.0% of 8 sessions · 0 calls · unused in 7 days · unused/);
		expect(text()).toMatch(/\[x\] plain\s+direct$/m);
	});
});
