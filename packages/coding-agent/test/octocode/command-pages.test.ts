import fs from "node:fs";
import path from "node:path";
import { setKeybindings, type TUI } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { McpManagerView } from "../../../mcp/src/ui.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { ExtensionCommandContext } from "../../src/core/features/index.ts";
import { installMcpUiPort } from "../../src/modes/interactive/mcp-ui.ts";
import { memoryDetailPage, memoryListPage } from "../../src/octocode/memory/page.ts";
import type { Memory } from "../../src/octocode/memory/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { registerTrustCommand } from "../../src/octocode/trust/command.ts";
import { grantFolder, listFolderGrants } from "../../src/octocode/trust/grants.ts";
import type { TrustOptions } from "../../src/octocode/trust/resolve.ts";
import { initTheme, theme } from "../../src/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { tmp } from "./helpers.ts";

const KEY = { enter: "\r", escape: "\x1b", down: "\x1b[B" };

/** A `ui.custom` that shows each page, records its text at width 80 and presses the scripted keys on it. */
function pages(scripts: string[][]) {
	const screens: string[] = [];
	const selects: string[][] = [];
	const answers: string[] = [];
	const notes: string[] = [];
	const ui = {
		notify: (text: string) => void notes.push(text),
		select: async (title: string, options: string[]) => (selects.push([title, ...options]), answers.shift()),
		custom: (factory: (...args: unknown[]) => { render(width: number): string[]; handleInput(data: string): void }) =>
			new Promise((resolve) => {
				const page = factory(
					{ requestRender: () => undefined, terminal: { rows: 40 } },
					theme,
					new KeybindingsManager(),
					resolve,
				);
				screens.push(stripAnsi(page.render(80).join("\n")));
				for (const key of scripts.shift() ?? [KEY.escape]) page.handleInput(key);
			}),
	};
	return { ui, screens, selects, answers, notes };
}

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));

describe("/trust page", () => {
	let root: string;
	let options: TrustOptions;
	beforeEach(() => {
		root = fs.realpathSync(tmp("octocode-trust-page-"));
		fs.mkdirSync(path.join(root, "home"), { recursive: true });
		options = {
			home: path.join(root, "home"),
			env: { ...process.env, OCTOCODE_AGENT_DB: path.join(root, "agent.db") },
		};
	});
	afterEach(() => closeSharedAgentDb());

	it("lists decisions, opens one, confirms with Cancel first and removes it with a notice", async () => {
		const app = path.join(root, "code", "app");
		fs.mkdirSync(app, { recursive: true });
		const other = path.join(root, "other");
		fs.mkdirSync(other);
		grantFolder(other, "folder", { source: "command", surface: "cli" }, options);
		const t = pages([[KEY.enter], [KEY.enter], [KEY.escape]]);
		t.answers.push("Remove");
		const ctx = {
			cwd: app,
			hasUI: true,
			mode: "tui",
			ui: t.ui,
			shutdown: vi.fn(),
		} as unknown as ExtensionCommandContext;
		const commands = new Subcommands();
		registerTrustCommand(commands, options);
		await commands.get("trust")!.handler("", ctx);
		expect(t.screens[0]).toContain("Folder trust —");
		expect(t.screens[0]).toMatch(/Decisions[\s\S]*trusted/);
		expect(t.screens[0]).toContain("Trust a wider folder");
		expect(t.screens[0]).toMatch(/enter open · \S+ close/);
		expect(t.screens[1]).toMatch(/Decision +#\d+ trusted/);
		expect(t.screens[1]).toContain("Remove decision");
		expect(t.selects[0].slice(1)).toEqual(["Cancel", "Remove"]);
		expect(t.notes.join("\n")).toContain("Removed #1 trusted");
		expect(t.notes.join("\n")).toContain("Other decisions are unchanged.");
		expect(listFolderGrants(options).filter((row) => row.revokedAt === undefined)).toEqual([]);
	});
});

const memory = (id: number, title: string, extra: Partial<Memory> = {}): Memory => ({
	id,
	scope: "workspace",
	repoKey: null,
	kind: "fact",
	title,
	body: "body",
	keywords: "k",
	pinned: false,
	author: "user",
	sourceSession: null,
	createdAt: 0,
	updatedAt: Date.now(),
	lastUsed: null,
	useCount: 2,
	...extra,
});

describe("/memory pages", () => {
	it("groups memories by section with an Add row and opens one on Enter", async () => {
		const t = pages([[KEY.enter]]);
		const ctx = { ui: t.ui } as unknown as ExtensionCommandContext;
		const id = await memoryListPage(
			ctx,
			[memory(1, "Pinned one", { pinned: true }), memory(2, "Second")],
			"Memories (auto on)",
		);
		expect(id).toBe("1");
		expect(t.screens[0]).toMatch(/Pinned[\s\S]*M1 +Pinned one[\s\S]*Workspace[\s\S]*M2 +Second[\s\S]*\+ Add a memory/);
		expect(t.screens[0]).toMatch(/enter open · \S+ close/);
	});

	it("shows facts above the actions and returns the chosen action", async () => {
		const t = pages([[KEY.down, KEY.enter]]);
		const ctx = { ui: t.ui } as unknown as ExtensionCommandContext;
		const action = await memoryDetailPage(ctx, memory(3, "Gadgets"), ["Edit", "Pin", "Delete"]);
		expect(action).toBe("Pin");
		expect(t.screens[0]).toMatch(/Scope +workspace[\s\S]*Used +2 times[\s\S]*Actions[\s\S]*Edit/);
		expect(t.screens[0]).toMatch(/enter run · \S+ back/);
	});
});

describe("/mcp manager page", () => {
	it("draws servers with state badges, the shared hints, and opens the highlighted one", async () => {
		installMcpUiPort();
		const view = new McpManagerView(
			{ requestRender: () => undefined, terminal: { rows: 40 } } as unknown as TUI,
			theme,
			new KeybindingsManager(),
		);
		const chosen = view.menu(() => ({
			title: "MCP servers — connect, enable or disable, manage tools",
			heading: "Servers",
			items: [
				{ value: "a", label: "alpha", description: "direct · global", badge: "connected · 2 tools", tone: "success" },
				{ value: "b", label: "beta", description: "hidden · project", badge: "failed", tone: "error" },
			],
			confirmLabel: "open",
			cancelLabel: "close",
		}));
		const text = stripAnsi(view.render(80).join("\n"));
		expect(text).toContain("Servers");
		expect(text).toMatch(/alpha +direct · global +connected · 2 tools/);
		expect(text).toMatch(/enter open · \S+ close/);
		view.handleInput(KEY.down);
		view.handleInput(KEY.enter);
		expect(await chosen).toBe("b");
	});
});
