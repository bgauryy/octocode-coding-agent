import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripTerminalSequences, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { type AgentDb, closeSharedAgentDb } from "../../../db/src/api.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { openAgentDb, sharedAgentDb } from "../../src/storage/database.ts";
import { showBoard } from "../../src/octocode/backlog/board.ts";
import { countsText } from "../../src/octocode/backlog/format.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { styleBacklogLines } from "../../src/octocode/backlog/tool-style.ts";
import { THEME_TOKENS } from "../../src/theme/theme-tokens.ts";
import { fakeCtx } from "./fake-host.ts";

const READY = { goal: "Expected result", why: "Required work" };
const KEY = { escape: "\x1b", down: "\x1b[B" };
const USER = { id: "user", kind: "human" as const };
const SESSION = "session-test";
const WIDTHS = [60, 100, 160];

let tmp: string;
let savedDb: string | undefined;
let cwd: string;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-board-render-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
	cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
});

/** Every board a test opened: each is disposed afterwards so no subscription to the shared clock outlives its test. */
const opened: Array<{ dispose?(): void }> = [];

afterEach(() => {
	for (const board of opened.splice(0)) board.dispose?.();
	for (const db of second.splice(0)) db.close();
	vi.useRealTimers();
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

const store = () => new BacklogStore(() => sharedAgentDb(), registeredWorkspace(cwd).id);

/** The same database file through a second connection: what another session or process writing while the board is open looks like. */
const second: AgentDb[] = [];
const otherWriter = () => {
	second[0] ??= openAgentDb(path.join(tmp, "home", "octocode.db"));
	return new BacklogStore(() => second[0], registeredWorkspace(cwd, second[0]).id);
};

/** Paints every colour as a zero-width escape that names its token, so a test reads which token painted what. */
const tokens = new Set<string>();
const paint = (color: string, text: string) => {
	tokens.add(color);
	return `\x1b[38;5;${100 + [...tokens].indexOf(color)}m${text}\x1b[39m`;
};
const tagging = { fg: paint, bg: paint, bold: (text: string) => text } as never;
/** `text` as `tagging` paints it in `color` (the same code as long as the token was seen before). */
const tagged = (color: string, text: string) => paint(color, text);
const plainTheme = {
	fg: (_c: string, text: string) => text,
	bg: (_c: string, text: string) => text,
	bold: (t: string) => t,
} as never;
const unmarked = (text: string) => stripTerminalSequences(text);

const completion = (ref: string) => ({
	summary: `${ref} shipped`,
	files: [],
	verification: { status: "not_run" as const, summary: "scripted" },
	operationKey: `done-${ref}`,
});

/** An epic with two items, a blocked item, a stale claim, a CJK title, a done item, steps and a session task. */
function seed(s: BacklogStore) {
	s.add({
		...READY,
		title: "Offline installer for air-gapped teams",
		type: "epic",
		state: "todo",
		tags: ["release"],
		createdBy: "user",
	});
	s.add(
		{
			...READY,
			title: "Bundle the model catalog into the installer",
			state: "ongoing",
			priority: 1,
			parentId: "B1",
			createdBy: "user",
		},
		{ id: SESSION },
	);
	s.add({
		...READY,
		title: "Verify checksum of every bundled asset",
		state: "todo",
		priority: 0,
		parentId: "B1",
		createdBy: "user",
	});
	s.add({
		...READY,
		title: "修复登录页面在中文环境下的超时问题 login timeout under zh-CN",
		state: "todo",
		createdBy: "user",
	});
	s.add({
		...READY,
		title: "Decide the token store for the web session",
		state: "backlog",
		priority: 1,
		createdBy: "user",
	});
	s.add({
		...READY,
		title: "Wire session refresh after the token decision",
		state: "todo",
		dependsOn: ["B5"],
		createdBy: "user",
	});
	s.add({ ...READY, title: "Rewrite the release checklist", state: "ongoing", createdBy: "user" }, { id: "main-1a2b" });
	s.add({ ...READY, title: "Ship the 1.0 notes", state: "todo", createdBy: "user" });
	s.update("B8", { state: "done", completion: completion("B8") }, USER);
	s.tasks.add({ goal: "write the parser", item: "B2" }, USER);
	s.tasks.add({ goal: "cover edge cases", item: "B2" }, USER);
	s.tasks.add({ goal: "check the footer", session: SESSION }, USER);
	return s;
}

/** How often the board read the items (`count`) and told its host the backlog changed (`changed`). */
interface Loads {
	count: number;
	changed: number;
}

function source(s: BacklogStore, loads: Loads = { count: 0, changed: 0 }) {
	return {
		title: "Backlog — proj",
		self: SESSION,
		load: () => (loads.count++, s.list().items),
		move: () => undefined,
		marks: (items: Parameters<BacklogStore["marks"]>[0]) => s.marks(items, SESSION),
		revision: () => s.revision,
		changed: () => void loads.changed++,
		tasks: { load: () => s.tasks.list({ states: ["todo", "ongoing"] }), move: () => undefined },
	};
}

interface Open {
	board: { render(width: number): string[]; handleInput(key: string): void; dispose?(): void };
	requestRender: ReturnType<typeof vi.fn>;
	choice: Promise<unknown>;
}

/** Opens the real board component over `s`; `rows` is the terminal height. */
function open(s: BacklogStore, theme: unknown = plainTheme, loads?: Loads, rows = 60): Open {
	const requestRender = vi.fn();
	let board: Open["board"] | undefined;
	const ctx = fakeCtx({
		cwd,
		ui: {
			custom: (factory) =>
				new Promise((resolve) => {
					board = factory(
						{ requestRender, terminal: { rows, columns: 100 } },
						theme,
						new KeybindingsManager(),
						resolve,
					);
				}),
		},
	});
	const choice = showBoard(ctx, source(s, loads));
	opened.push(board!);
	return { board: board!, requestRender, choice };
}

/** Presses down until the selected row is `ref`'s. */
function selectItem(board: Open["board"], ref: string): void {
	for (let i = 0; i < 20; i++) {
		if (board.render(100).some((line) => line.includes(" › ") && line.includes(` ${ref} `))) return;
		board.handleInput(KEY.down);
	}
	throw new Error(`${ref} is not on the board`);
}

const lineWith = (lines: string[], text: string) => lines.find((line) => line.includes(text)) ?? "";

describe.each(WIDTHS)("the board at %i columns", (width) => {
	it("never overflows and keeps one line of help", () => {
		const lines = open(seed(store())).board.render(width);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		const help = lines.at(-2)!;
		expect(help).toContain("close");
		expect(lines.filter((line) => line.includes(" close"))).toHaveLength(1);
	});

	it("keeps what blocks or holds an item and the epic's progress, whatever the width", () => {
		const text = open(seed(store())).board.render(width).join("\n");
		expect(lineWith(text.split("\n"), "B6")).toContain("⊘ blocked by B5");
		expect(lineWith(text.split("\n"), "B7")).toContain("⚠ stale");
		expect(lineWith(text.split("\n"), "B1 ")).toMatch(/ongoing 0\/2/);
	});

	it("aligns the columns of every item row", () => {
		const lines = open(seed(store())).board.render(width);
		const at = (ref: string, title: string) => lineWith(lines, ref).indexOf(title);
		expect(at("B6", "Wire")).toBe(at("B7", "Rewrite"));
		expect(at("B6", "Wire")).toBe(at("B5", "Decide"));
		// The priority column is the same distance from the ref on every row.
		const prio = (ref: string) => lineWith(lines, ref).search(/ p[0-3] /);
		expect(prio("B6")).toBe(prio("B7"));
	});

	it("cuts a wide-character title by cells and never splits it", () => {
		const line = lineWith(open(seed(store())).board.render(width), "B4");
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(line).not.toContain("\ufffd");
		if (width < 160) expect(line).toContain("…");
		else expect(line).toContain("login timeout under zh-CN");
	});

	it("opens the selected item's tasks and details under it", () => {
		const { board } = open(seed(store()));
		selectItem(board, "B2");
		const lines = board.render(width);
		expect(lines.some((line) => line.includes("› ") && line.includes("B2"))).toBe(true);
		expect(lineWith(lines, "T1")).toContain("write the parser");
		expect(lineWith(lines, "T2")).toContain("cover edge cases");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});
});

describe("the board's header", () => {
	it("spells the counts out while they fit and shortens them to glyphs when they do not", () => {
		const s = seed(store());
		const wide = open(s).board.render(160)[1];
		expect(wide).toContain("▶ 2 ongoing");
		expect(wide).toContain("☐ 3 todo");
		expect(wide).toContain("⧗ 1 backlog");
		expect(wide).toContain("◆ 1 epic");
		const narrow = open(s).board.render(40)[1];
		expect(narrow).toContain("▶2");
		expect(visibleWidth(narrow)).toBeLessThanOrEqual(40);
	});

	it("counts an epic once, by its derived state, exactly as the footer does", () => {
		const s = seed(store());
		const header = open(s).board.render(160)[1];
		const footer = countsText(s.counts());
		// B1 is stored todo and its items say ongoing: it is one epic, not a todo item and not a backlog item.
		expect(s.counts().items).toEqual({ backlog: 1, todo: 3, ongoing: 2, done: 1 });
		expect(s.counts().epics).toEqual({ backlog: 0, todo: 0, ongoing: 1, done: 0 });
		for (const [state, label] of [
			["ongoing", "ongoing"],
			["todo", "todo"],
			["backlog", "to triage"],
		] as const) {
			const n = s.counts().items[state];
			expect(header).toContain(`${n} ${state}`);
			expect(footer).toContain(`${n} ${label}`);
		}
		expect(header).toContain("1 epic");
		expect(footer).toContain("1 epic");
	});

	it("follows the epic's state when its items finish", () => {
		const s = seed(store());
		for (const task of ["T1", "T2"]) s.tasks.update(task, { state: "done" }, USER);
		s.update("B2", { state: "done", completion: completion("B2") }, USER);
		s.update("B3", { state: "done", completion: completion("B3") }, USER);
		expect(s.counts().epics).toEqual({ backlog: 0, todo: 0, ongoing: 0, done: 1 });
		expect(countsText(s.counts())).not.toContain("epic");
		expect(open(s).board.render(160)[1]).not.toContain("epic");
	});
});

describe("the board's colours", () => {
	it("come only from theme tokens, paint priority, blockers and state, and leave the text as it is", () => {
		tokens.clear();
		const s = seed(store());
		const coloured = open(s, tagging).board.render(100).join("\n");
		const plain = open(s).board.render(100).join("\n");
		expect(unmarked(coloured)).toBe(unmarked(plain));
		for (const token of tokens) expect(Object.keys(THEME_TOKENS)).toContain(token);
		expect(coloured).toContain(tagged("error", "p0"));
		expect(coloured).toContain(tagged("warning", "p1"));
		expect(coloured).toContain(tagged("warning", "⊘ blocked by B5"));
		expect(coloured).toContain(tagged("success", "✓"));
		expect(coloured).toContain(tagged("accent", "▶"));
		expect(coloured).toContain(tagged("selectedBg", "\0").split("\0")[0]);
	});
});

describe("the board while it is open", () => {
	it("repaints after a second writer adds an item, and stops watching when it closes", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const s = seed(store());
		const loads = { count: 0, changed: 0 };
		const { board, requestRender, choice } = open(s, plainTheme, loads);
		expect(board.render(100).join("\n")).not.toContain("Added by another process");
		expect(loads.count).toBe(1);
		// Nothing changed: ticks neither re-read nor repaint.
		await vi.advanceTimersByTimeAsync(3_000);
		expect(loads.count).toBe(1);
		expect(requestRender).not.toHaveBeenCalled();

		// Another process (a second store on the same database file) adds an item.
		otherWriter().add({ ...READY, title: "Added by another process", state: "todo", priority: 0, createdBy: "user" });
		await vi.advanceTimersByTimeAsync(1_100);
		expect(loads.count).toBe(2);
		// The host is told too, so the footer counts follow the board.
		expect(loads.changed).toBe(1);
		expect(requestRender).toHaveBeenCalled();
		const after = board.render(100).join("\n");
		expect(after).toContain("Added by another process");
		expect(after).toContain("☐ 4 todo");

		board.handleInput(KEY.escape);
		await choice;
		expect(vi.getTimerCount()).toBe(0);
		otherWriter().add({ ...READY, title: "Late", state: "todo", createdBy: "user" });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(loads.count).toBe(2);
	});

	it("stops watching when the host disposes the board", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const loads = { count: 0, changed: 0 };
		const { board } = open(seed(store()), plainTheme, loads);
		expect(vi.getTimerCount()).toBe(1);
		board.dispose?.();
		expect(vi.getTimerCount()).toBe(0);
		otherWriter().add({ ...READY, title: "After dispose", state: "todo", createdBy: "user" });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(loads.count).toBe(1);
	});

	it("keeps the selection on its item when rows appear above it", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const s = seed(store());
		const { board } = open(s);
		selectItem(board, "B2");
		otherWriter().add({ ...READY, title: "Urgent newcomer", state: "todo", priority: 0, createdBy: "user" });
		await vi.advanceTimersByTimeAsync(1_100);
		const selected = board.render(100).filter((line) => line.includes(" › "));
		expect(selected).toHaveLength(1);
		expect(selected[0]).toContain("B2");
	});
});

describe("backlog results in the transcript", () => {
	it("colours item and task lines without changing their text", () => {
		const text = [
			"B14 [ongoing p1 bug] Title #tag ⊂B3 (from B12) (blocked by B5) (2 open steps) (you)",
			"- B2 [todo p0] 修复登录 (stale: holder ended)",
			"  T3 [done] write it — shipped",
			"Notes and changes:",
			"plain line",
		].join("\n");
		const lines = styleBacklogLines(tagging, text);
		expect(lines.map((line) => stripTerminalSequences(line)).join("\n")).toBe(text);
		expect(lines[0]).toContain(tagged("accent", "ongoing"));
		expect(lines[0]).toContain(tagged("warning", "(blocked by B5)"));
		expect(lines[0]).toContain(tagged("accent", "(you)"));
		expect(lines[1]).toContain(tagged("error", "p0"));
		expect(lines[1]).toContain(tagged("warning", "(stale: holder ended)"));
		expect(lines[2]).toContain(tagged("success", "done"));
		expect(lines[3]).toContain(tagged("muted", "Notes and changes:"));
	});
});
