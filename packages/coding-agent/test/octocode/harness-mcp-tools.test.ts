import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerToolStates } from "../../../mcp/src/api.ts";
import { projectMcpConfigPath } from "../../../mcp/src/paths.ts";
import type { InventoryItem } from "../../src/octocode/harness/inventory.ts";
import { createMcpToolsSource } from "../../src/octocode/mcp-host/tools.ts";
import { HarnessPicker } from "../../src/octocode/harness/picker.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { pinTool } from "../../src/octocode/web-daemon/tool-exposure.ts";
import { initTheme, theme } from "../../src/theme/theme.ts";
import { trustFolder } from "./helpers.ts";
import { menuText, runToolsPage } from "./mcp-tools-page-driver.ts";

initTheme("dark");

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

/** The `/mcp` tools page of `docs`, answered with `choices`; resolves to every menu shown. */
const page = (choices: Array<string | undefined>, options: { trusted?: boolean; scope?: "global" | "project" } = {}) =>
	runToolsPage({ cwd, agentDir, live: () => live, ...options }, choices);
/** The text of the last tools list shown. */
const shown = async (
	choices: Array<string | undefined>,
	options?: { trusted?: boolean; scope?: "global" | "project" },
) => menuText((await page(choices, options)).filter((menu) => menu.title === "docs — tools").at(-1)!);

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

describe("the /mcp tools page", () => {
	it("lists each tool with its exposure under Available to and Default for tools", async () => {
		const [menu] = await page([]);
		expect(menu.items.map((item) => [item.value, item.badge])).toEqual([
			["@available", "every agent"],
			["@default", "direct"],
			["read", "direct"],
			["search", "direct"],
		]);
		expect(menu.confirmLabel).toBe("open");
		expect(menu.cancelLabel).toBe("back");
	});

	it("lists only pinned tools and says to connect when the server is not connected", async () => {
		writeJson(globalMcp(), {
			mcpServers: { docs: { command: "docs-server", toolExposure: { legacy: "hidden", "get_*": "hidden" } } },
		});
		live = undefined;
		const text = await shown([]);
		expect(text).toContain("not connected · 1 tool pinned");
		expect(text).toContain("Connect the server to list its tools.");
		expect(text).toContain("legacy  hidden  pinned");
		// A pattern is not a tool name.
		expect(text).not.toContain("get_*");
	});
});

describe("switching a tool", () => {
	it("hides a tool by writing toolExposure to the server's file, and brings it back by removing the pin", async () => {
		const text = await shown(["read", "hidden"]);
		expect(docs()).toEqual({ command: "docs-server", toolExposure: { read: "hidden" } });
		expect(text).toContain("read  hidden  pinned · from the next session");
		expect(text).toContain("running sessions keep what they declared");
		const back = await shown(["read", "@unpin"]);
		expect(docs()).toEqual({ command: "docs-server" });
		expect(back).toContain("read  direct");
	});

	it("opens the tool's choices with the current exposure selected and a server default row only when pinned", async () => {
		writeJson(globalMcp(), { mcpServers: { docs: { command: "docs-server", toolExposure: { read: "deferred" } } } });
		const menus = await page(["read"]);
		const choices = menus.find((menu) => menu.title === "read — tool")!;
		expect(choices.selected).toBe("deferred");
		expect(choices.items.map((item) => item.value)).toEqual(["direct", "deferred", "onDemand", "hidden", "@unpin"]);
		expect(choices.items.find((item) => item.value === "deferred")?.badge).toBe("current");
		const unpinned = (await page(["search"])).find((menu) => menu.title === "search — tool")!;
		expect(unpinned.items.map((item) => item.value)).not.toContain("@unpin");
	});

	it("writes each exposure as a pin", async () => {
		const pins = [];
		for (const exposure of ["deferred", "onDemand", "hidden", "direct"]) {
			await page(["read", exposure]);
			pins.push(docs().toolExposure?.read);
		}
		expect(pins).toEqual(["deferred", "onDemand", "hidden", "direct"]);
	});

	it("keeps the other pins and the rest of the file", async () => {
		writeJson(globalMcp(), {
			mcpServers: { docs: { command: "docs-server", env: { A: "1" }, toolExposure: { search: "deferred" } } },
			other: true,
		});
		await page(["read", "hidden"]);
		expect(readJson(globalMcp())).toEqual({
			mcpServers: {
				docs: { command: "docs-server", env: { A: "1" }, toolExposure: { read: "hidden", search: "deferred" } },
			},
			other: true,
		});
	});

	it("writes the web Tools panel's file content for the same pin", async () => {
		await page(["read", "onDemand"]);
		const fromPage = readJson(globalMcp());
		writeJson(globalMcp(), { mcpServers: { docs: { command: "docs-server" } } });
		await pinTool(
			{ kind: "mcp", server: "docs", tool: "read", pin: "onDemand", scope: "global" },
			{ agentDir, actor: "web:test" },
		);
		expect(readJson(globalMcp())).toEqual(fromPage);
	});
});

describe("Available to", () => {
	it("writes defaultActive false for 'only agents that name it' and clears it for 'every agent'", async () => {
		const text = await shown(["@available", "named"]);
		expect(docs()).toEqual({ command: "docs-server", defaultActive: false });
		expect(text).toContain("Available to  agents that name it");
		expect(text).toContain("profile tools: name mcp__docs__");
		const back = await shown(["@available", "every"]);
		expect(docs()).toEqual({ command: "docs-server" });
		expect(back).toContain("Available to  every agent");
	});

	it("reads the saved choice when the page opens", async () => {
		writeJson(globalMcp(), { mcpServers: { docs: { command: "docs-server", defaultActive: false } } });
		expect(await shown([])).toContain("Available to  agents that name it");
	});
});

describe("where a change is written", () => {
	it("writes a project override, leaving the global server as it is, when project scope is chosen in a trusted folder", async () => {
		trustFolder(cwd);
		await page(["read", "hidden"], { scope: "project" });
		expect(docs(projectMcpConfigPath(cwd))).toEqual({ toolExposure: { read: "hidden" } });
		expect(docs()).toEqual({ command: "docs-server" });
	});

	it("refuses project scope in an untrusted folder and writes nothing", async () => {
		const text = await shown(["read", "hidden"], { trusted: false, scope: "project" });
		expect(text).toContain("not trusted");
		expect(fs.existsSync(projectMcpConfigPath(cwd))).toBe(false);
		expect(docs()).toEqual({ command: "docs-server" });
	});

	it("writes a project server's own file when the global scope is chosen", async () => {
		trustFolder(cwd);
		writeJson(projectMcpConfigPath(cwd), { mcpServers: { docs: { command: "project-docs" } } });
		await page(["read", "hidden"], { scope: "global" });
		expect(docs(projectMcpConfigPath(cwd))).toEqual({ command: "project-docs", toolExposure: { read: "hidden" } });
	});

	it("does not offer a switch for a server no configuration file holds", async () => {
		live = [
			{
				server: "docs",
				connected: true,
				saved: false,
				tools: [{ name: "run", state: "direct", decidedBy: "default" }],
			},
		];
		writeJson(globalMcp(), { mcpServers: {} });
		const text = await shown(["run", "hidden"]);
		expect(text).toContain("not in a configuration file");
		expect(docs()).toBeUndefined();
	});
});

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

describe("the /harness MCP row", () => {
	const picker = (options: { openTools?: (server: string, scope: "global" | "project") => void }) => {
		const apply = vi.fn(() => "Saved");
		const view = new HarnessPicker(
			{
				items: [server],
				section: "mcp",
				apply,
				paths: { global: "g", project: "p" },
				height: 20,
				done: vi.fn(),
				requestRender: vi.fn(),
				...options,
			},
			theme,
			new KeybindingsManager(),
		);
		return { view, apply };
	};

	it("opens the /mcp tools page with the picker's scope on Enter or →", () => {
		const openTools = vi.fn();
		const { view, apply } = picker({ openTools });
		view.handleInput("\r");
		view.handleInput("\t");
		view.handleInput("\x1b[C");
		expect(openTools.mock.calls).toEqual([
			["docs", "global"],
			["docs", "project"],
		]);
		expect(apply).not.toHaveBeenCalled();
	});

	it("keeps switching the server on Enter without an MCP owner", () => {
		const { view, apply } = picker({});
		view.handleInput("\r");
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

	it("shows the rate, the last day used and the reason beside the exposure", async () => {
		live = audited();
		const text = await shown([]);
		expect(text).toContain("search  direct  12.5% of 8 sessions · 3 calls · last 2026-11-14 · promoted");
		expect(text).toContain("read  deferred  0.0% of 8 sessions · 0 calls · unused in 7 days · unused");
		expect(text).toMatch(/^plain {2}direct$/m);
	});
});
