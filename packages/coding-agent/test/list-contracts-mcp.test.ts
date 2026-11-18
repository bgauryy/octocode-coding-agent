import "./mcp-host.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setKeybindings, type TUI, type TuiMouseEvent, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../db/src/api.ts";
import type { McpServerToolStates } from "../../mcp/src/api.ts";
import { McpManagerView } from "../../mcp/src/ui.ts";
import type { AskView } from "../src/core/features/types/ui.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { DialogSelectorComponent } from "../src/modes/interactive/components/dialog-selector.ts";
import { showBoard } from "../src/octocode/backlog/board.ts";
import { BacklogStore } from "../src/octocode/backlog/store.ts";
import { registerCheckpoints } from "../src/octocode/files/checkpoint-command.ts";
import type { Checkpoints } from "../src/octocode/files/checkpoint.ts";
import type { InventoryItem } from "../src/octocode/harness/inventory.ts";
import { HarnessPicker } from "../src/octocode/harness/picker.ts";
import { Subcommands } from "../src/octocode/shared/commands.ts";
import { sharedAgentDb } from "../src/storage/database.ts";
import { registeredWorkspace } from "../src/storage/workspace-database.ts";
import { initTheme, theme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { asSetup, fakeCtx } from "./octocode/fake-host.ts";
import { runToolsPage } from "./octocode/mcp-tools-page-driver.ts";

const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const tui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 80 } } as unknown as TUI;
const text = (component: { render(width: number): string[] }, width = 80) =>
	component.render(width).map((line) => stripAnsi(line));
const mouse = (type: TuiMouseEvent["type"], y: number, wheelDelta?: number): TuiMouseEvent => ({
	type,
	button: type === "wheel" ? "none" : "left",
	x: 4,
	y,
	screenX: 4,
	screenY: y,
	width: 80,
	height: 60,
	shift: false,
	alt: false,
	ctrl: false,
	...(wheelDelta ? { wheelDelta } : {}),
});
/** Press then release on line `y`: the TUI sends both for one click. */
const clickAt = (target: { handleMouse?(event: TuiMouseEvent): unknown }, y: number) => {
	target.handleMouse?.(mouse("press", y));
	target.handleMouse?.(mouse("click", y));
};
const lineOf = (lines: string[], pattern: RegExp) => lines.findIndex((line) => pattern.test(line));
const expectFits = (lines: string[], width: number) => {
	for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
};

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

describe("/mcp forms contract", () => {
	it("one field, `enter submit · esc cancel`, no `next` or `•`, Esc cancels", async () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		const answer = view.input("Server URL", "https://mcp.example", "Where the server listens");
		const lines = text(view);
		const shown = lines.join("\n");
		expect(shown).toContain("enter submit · esc/ctrl+c cancel");
		expect(shown).not.toMatch(/•|\bnext\b/);
		expectFits(lines, 80);
		view.handleInput(ESC);
		expect(await answer).toBeUndefined();
	});
});

describe("/mcp tools page contract", () => {
	let root: string;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-contract-mcp-"));
		vi.stubEnv("HOME", path.join(root, "user"));
		vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
		fs.mkdirSync(path.join(root, "agent"), { recursive: true });
		fs.mkdirSync(path.join(root, "work", ".octocode"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "agent", "mcp.json"),
			JSON.stringify({ mcpServers: { docs: { command: "docs-server", toolExposure: { search: "deferred" } } } }),
		);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		fs.rmSync(root, { recursive: true, force: true });
	});
	const live = (): McpServerToolStates[] => [
		{
			server: "docs",
			connected: true,
			saved: true,
			tools: [
				{ name: "read", state: "direct", decidedBy: "default" },
				{ name: "search", state: "deferred", decidedBy: "pin" },
			],
		},
	];

	it("server rows then one row per tool with its exposure; a tool opens a choice page with its state selected", async () => {
		const place = { cwd: path.join(root, "work"), agentDir: path.join(root, "agent"), live };
		const menus = await runToolsPage(place, ["search", undefined, undefined]);
		const [list, choice] = menus;
		expect(list.items.map((item) => [item.value, item.badge])).toEqual([
			["@available", "every agent"],
			["@default", "direct"],
			["read", "direct"],
			["search", "deferred"],
		]);
		expect([list.confirmLabel, list.cancelLabel]).toEqual(["open", "back"]);
		expect(choice.selected).toBe("deferred");
		expect([choice.confirmLabel, choice.cancelLabel]).toEqual(["select", "back"]);

		// Drawn by the /mcp view: the list contract's cursor, one hint line, nothing wider than the terminal.
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		void view.menu(() => list);
		const lines = text(view);
		expect(lines.some((line) => /^ *› /.test(line))).toBe(true);
		expect(lines.join("\n")).not.toMatch(/(^|\n) *> /);
		expect(lines.join("\n")).toMatch(/enter open · .*esc\/ctrl\+c back/);
		expectFits(lines, 80);
		view.dispose();
	});
});

describe("harness picker MCP row contract", () => {
	const item: InventoryItem = {
		id: "mcp:docs",
		kind: "mcp",
		host: "mcp",
		depth: 0,
		label: "docs",
		on: true,
		detail: "2 tools",
	};

	it("draws the › cursor, offers `open`, and Enter opens the /mcp tools page instead of switching", () => {
		const openTools = vi.fn();
		const apply = vi.fn(() => "Saved");
		const picker = new HarnessPicker(
			{
				items: [item],
				apply,
				paths: { global: "~/settings.json", project: ".octocode/settings.json" },
				height: 20,
				section: "mcp",
				openTools,
				done: vi.fn(),
				requestRender: vi.fn(),
			},
			theme,
			new KeybindingsManager(),
		);
		const lines = text(picker);
		// The row cursor is `›`; `>` is only the filter field's prompt.
		expect(lines.some((line) => /› .*docs/.test(line))).toBe(true);
		expect(lines.some((line) => /^ *> .*docs/.test(line))).toBe(false);
		expect(lines.join("\n")).toMatch(/enter open/);
		expectFits(lines, 80);
		picker.handleInput("\r");
		expect(openTools).toHaveBeenCalledWith("docs", "global");
		expect(apply).not.toHaveBeenCalled();
	});
});

describe("/backlog board contract", () => {
	let tmp: string;
	let savedDb: string | undefined;
	beforeEach(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-board-contract-")));
		savedDb = process.env.OCTOCODE_AGENT_DB;
		process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
		fs.mkdirSync(path.join(tmp, "repo"), { recursive: true });
	});
	afterEach(() => {
		closeSharedAgentDb();
		if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
		else process.env.OCTOCODE_AGENT_DB = savedDb;
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	/** Opens the board over two items and hands back the component and the choice it settles with. */
	const open = () => {
		const cwd = path.join(tmp, "repo");
		const store = new BacklogStore(() => sharedAgentDb(), registeredWorkspace(cwd).id);
		for (const title of ["alpha", "beta"])
			store.add({ goal: "Expected result", why: "Required work", title, state: "todo", createdBy: "user" });
		let board!: { render(width: number): string[]; handleInput(data: string): void } & {
			handleMouse?(event: TuiMouseEvent): unknown;
		};
		const ctx = fakeCtx({
			cwd,
			ui: {
				custom: (factory) =>
					new Promise((resolve) => {
						board = factory(tui, theme, new KeybindingsManager(), resolve) as typeof board;
					}),
			},
		});
		const choice = showBoard(ctx, {
			title: "Backlog",
			self: "session-test",
			load: () => store.list().items,
			move: () => undefined,
		});
		const selected = () => text(board, 100).find((line) => line.startsWith(" › "));
		return { board, choice, selected };
	};

	it("↑↓ and the wheel stop at the ends, a press selects, a click on the selected row opens it", async () => {
		const { board, choice, selected } = open();
		const first = selected()!;
		const ref = (line: string | undefined) => /\b(B\d+)\b/.exec(line ?? "")?.[1];
		board.handleInput(UP);
		expect(selected()).toBe(first);
		board.handleInput(DOWN);
		const second = selected()!;
		expect(ref(second)).not.toBe(ref(first));
		board.handleInput(DOWN);
		expect(selected()).toBe(second);
		board.handleMouse?.(mouse("wheel", 0, -1));
		board.handleMouse?.(mouse("wheel", 0, -1));
		expect(selected()).toBe(first);
		const other = (lines: string[]) => lines.findIndex((line) => ref(line) === ref(second));
		clickAt(board, other(text(board, 100)));
		expect(ref(selected())).toBe(ref(second));
		clickAt(board, other(text(board, 100)));
		expect(await choice).toEqual({ action: "open", ref: ref(second) });
	});

	it("Esc closes, and `q` stays its alias", async () => {
		for (const key of [ESC, "q"]) {
			const { board, choice } = open();
			expect(text(board, 100).join("\n")).toMatch(/esc\/ctrl\+c\/q close/);
			board.handleInput(key);
			expect(await choice).toBeUndefined();
			closeSharedAgentDb();
			fs.rmSync(path.join(tmp, "home"), { recursive: true, force: true });
		}
	});
});

describe("ask card contract", () => {
	const ask = (labels: string[], extra: Partial<AskView> = {}): AskView => ({
		question: "Which scope?",
		options: labels.map((label) => ({ label })),
		...extra,
	});
	const card = (labels: string[], extra: Partial<AskView> = {}, destructive = false) => {
		const onSelect = vi.fn();
		const dialog = new DialogSelectorComponent("Which scope?", labels, onSelect, vi.fn(), {
			ask: ask(labels, extra),
			destructive,
		});
		const row = (label: string) => lineOf(text(dialog), new RegExp(`\\d\\. ${label}`));
		const cursor = () => text(dialog).find((line) => /› \d\./.test(line));
		return { dialog, onSelect, row, cursor };
	};

	it("hint names `pick` and `confirm`, never `choose`", () => {
		const { dialog } = card(["Small", "Large"]);
		const shown = text(dialog).join("\n");
		expect(shown).toContain("1-2 pick · enter confirm · esc/ctrl+c cancel");
		expect(shown).not.toContain("choose");
	});

	it("the wheel moves one answer without wrapping; a press selects; a click on the selected answer confirms", () => {
		const { dialog, onSelect, row, cursor } = card(["Small", "Medium", "Large"]);
		dialog.handleMouse(mouse("wheel", 0, -1));
		expect(cursor()).toMatch(/1\. Small/);
		for (let i = 0; i < 4; i++) dialog.handleMouse(mouse("wheel", 0, 1));
		expect(cursor()).toMatch(/3\. Large/);
		clickAt(dialog, row("Medium"));
		expect(cursor()).toMatch(/2\. Medium/);
		expect(onSelect).not.toHaveBeenCalled();
		clickAt(dialog, row("Medium"));
		expect(onSelect).toHaveBeenCalledWith("Medium");
	});

	it("a click never confirms a confirmation (safe answer first) or a destructive dialog", () => {
		for (const [labels, destructive] of [
			[["No", "Yes"], false],
			[["Keep", "Delete"], true],
		] as const) {
			const { dialog, onSelect, row, cursor } = card([...labels], {}, destructive);
			clickAt(dialog, row(labels[1]));
			clickAt(dialog, row(labels[1]));
			expect(cursor()).toMatch(new RegExp(`2\\. ${labels[1]}`));
			expect(onSelect).not.toHaveBeenCalled();
			dialog.handleInput("\r");
			expect(onSelect).toHaveBeenCalledWith(labels[1]);
		}
	});
});

describe("/rewind contract", () => {
	/** Runs /rewind with one turn of changes; `answer` drives the dialog the terminal shows for its question. */
	const rewind = async (answer: (dialog: DialogSelectorComponent) => void) => {
		const commands = new Subcommands();
		const rewound = vi.fn(async () => ({ restored: [], partly: [], skipped: [] }));
		const checkpoints = {
			turnsOn: () => [1],
			list: () => [],
			rewind: rewound,
			filesByAnchor: () => new Map(),
		} as unknown as Checkpoints;
		registerCheckpoints(asSetup({ on: () => undefined, sendMessage: vi.fn() }), checkpoints, vi.fn(), commands);
		const notices: string[] = [];
		let shown: string[] = [];
		const ctx = {
			cwd: os.tmpdir(),
			hasUI: true,
			sessionManager: { getBranch: () => [], getEntry: () => undefined, getLabel: () => undefined },
			ui: {
				notify: (message: string) => notices.push(message),
				select: (title: string, options: string[]) =>
					new Promise<string | undefined>((resolve) => {
						const dialog = new DialogSelectorComponent(title, options, resolve, () => resolve(undefined));
						shown = text(dialog);
						answer(dialog);
					}),
			},
		};
		await commands.get("rewind")!.handler("", ctx as never);
		return { shown, notices, rewound };
	};

	it("asks with named actions, Cancel first and selected; a click does not rewind, Esc cancels", async () => {
		const { shown, notices, rewound } = await rewind((dialog) => {
			const at = lineOf(text(dialog), /2\. Rewind/);
			clickAt(dialog, at);
			clickAt(dialog, at);
			dialog.handleInput(ESC);
		});
		expect(shown.join("\n")).toMatch(/› 1\. Cancel\s*\n\s*2\. Rewind/);
		expect(shown.join("\n")).not.toMatch(/\b(Yes|No)\b/);
		expect(rewound).not.toHaveBeenCalled();
		expect(notices.at(-1)).toMatch(/rewound/i);
	});

	it("rewinds only on the keyboard's answer", async () => {
		const { rewound } = await rewind((dialog) => {
			dialog.handleInput("2");
			dialog.handleInput("\r");
		});
		expect(rewound).toHaveBeenCalledWith([1]);
	});
});

it("draws the forms and pages at 40 columns without a wider line", () => {
	const view = new McpManagerView(tui, theme, new KeybindingsManager());
	void view.input("Server URL", "https://mcp.example/a/very/long/path", "Where the server listens");
	expectFits(text(view, 40), 40);
	view.dispose();
});
