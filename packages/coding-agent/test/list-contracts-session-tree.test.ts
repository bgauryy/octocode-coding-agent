import { setKeybindings, visibleWidth } from "@octocodeai/octocode-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo, SessionMessageEntry, SessionTreeNode } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ESC = "\x1b";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";
const HOME = "\x1b[H";
const END = "\x1b[F";
const ENTER = "\r";
const CTRL_D = "\x04";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const lines = (component: { render(width: number): string[] }, width = 80) =>
	component.render(width).map((line) => stripAnsi(line));
const cursorRow = (component: { render(width: number): string[] }) =>
	lines(component).find((line) => line.startsWith("› "));

function expectFits(component: { render(width: number): string[] }): void {
	for (const width of [20, 40, 80, 120]) {
		for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
}

function session(n: number): SessionInfo {
	const id = `s${String(n).padStart(3, "0")}`;
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/work/repo",
		created: new Date(0),
		modified: new Date(Date.now() - n * 60_000),
		messageCount: 2,
		firstMessage: `Task ${n} topic`,
		allMessagesText: `Task ${n} topic`,
	};
}

async function openPicker(count: number, options: { removeSessions?: () => Promise<never> } = {}) {
	const sessions = Array.from({ length: count }, (_, n) => session(n));
	const events: string[] = [];
	const picker = new SessionSelectorComponent(
		async () => sessions,
		async () => sessions,
		(path) => events.push(`select ${path}`),
		() => events.push("cancel"),
		() => events.push("exit"),
		() => {},
		{ keybindings: new KeybindingsManager(), viewportRows: () => 24, ...options },
	);
	await flush();
	const selected = () => picker.getSessionList().getSelectedSession()?.id;
	return { picker, events, selected };
}

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

describe("session picker (#14) on the list contract", () => {
	it("draws one ⌕ search line, a › cursor and an a–b/total foot, and keeps every line to the width", async () => {
		const { picker } = await openPicker(30);
		const screen = lines(picker);
		expect(screen.filter((line) => line.includes("⌕"))).toEqual([' ⌕ re:<regex> · "exact phrase"']);
		expect(screen.join("\n")).not.toMatch(/[╭╰]/);
		expect(cursorRow(picker)).toContain("Task 0 topic");
		// 24 rows leave 9 two-line rows and the position line.
		expect(screen).toContain("  1–9/30");
		expectFits(picker);
	});

	it("pages by the visible rows, stops at the ends and jumps with Home/End", async () => {
		const { picker, selected } = await openPicker(30);
		picker.handleInput(UP);
		expect(selected()).toBe("s000");
		picker.render(80);
		picker.handleInput(PAGE_DOWN);
		expect(selected()).toBe("s009");
		for (let i = 0; i < 5; i++) picker.handleInput(PAGE_DOWN);
		expect(selected()).toBe("s029");
		picker.handleInput(DOWN);
		expect(selected()).toBe("s029");
		expect(lines(picker)).toContain("  22–30/30");
		picker.handleInput(HOME);
		expect(selected()).toBe("s000");
		picker.handleInput(END);
		expect(selected()).toBe("s029");
		picker.handleInput(PAGE_UP);
		expect(selected()).toBe("s020");
	});

	it("keeps the re: and quoted searches, names the query when nothing matches, and Esc clears before it cancels", async () => {
		const { picker, events } = await openPicker(30);
		const list = picker.getSessionList();
		for (const ch of "re:Task 1\\d ") picker.handleInput(ch);
		expect(list.getCounts().shown).toBe(10);
		list.setQuery('"task 2 topic"');
		expect(list.getCounts().shown).toBe(1);
		expect(cursorRow(picker)).toContain("Task 2 topic");
		list.setQuery("zzz");
		expect(lines(picker)).toContain('  No sessions match "zzz" · esc clears');
		picker.handleInput(ESC);
		expect(events).toEqual([]);
		expect(list.getCounts().shown).toBe(30);
		picker.handleInput(ESC);
		expect(events).toEqual(["cancel"]);
	});

	it("keeps ctrl+d delete behind its confirmation", async () => {
		const removeSessions = vi.fn(async () => ({ removed: [], problems: [] }) as never);
		const { picker, events } = await openPicker(3, { removeSessions });
		picker.handleInput(DOWN);
		picker.handleInput(CTRL_D);
		expect(lines(picker).join("\n")).toContain("Delete session?");
		picker.handleInput(ESC);
		expect(lines(picker).join("\n")).not.toContain("Delete session?");
		expect(events).toEqual([]);
		picker.handleInput(CTRL_D);
		picker.handleInput(ENTER);
		await flush();
		expect(removeSessions).toHaveBeenCalledWith([expect.objectContaining({ id: "s001" })]);
	});

	it("ranks its hints on one line that keeps the move hint, above a closing rule", async () => {
		const { picker } = await openPicker(3);
		expect(lines(picker, 200).at(-2)).toMatch(/^ ↑\/↓ move · enter resume · .* · esc\/ctrl\+c close$/);
		// Narrower, the least needed hints drop first: Enter and Esc stay.
		expect(lines(picker).at(-2)).toMatch(/^ enter resume · .*esc\/ctrl\+c close$/);
		expect(lines(picker, 30).at(-2)).not.toContain("path");
		for (const width of [40, 80, 120]) {
			const screen = lines(picker, width);
			expect(screen[0]).toBe("─".repeat(width));
			expect(screen.at(-1)).toBe("─".repeat(width));
		}
	});

	it("titles the picker with scope and sort as one fact at the right edge, without radio glyphs or a count", async () => {
		const { picker } = await openPicker(30);
		expect(lines(picker, 40)[1]).toBe(" Resume session  this folder · threaded ");
		expect(lines(picker, 80)[1]).toBe(` Resume session${" ".repeat(42)}this folder · threaded `);
		expect(lines(picker, 120)[1]).toBe(` Resume session${" ".repeat(82)}this folder · threaded `);
		// Narrower than the fact, the fact is cut and the title stays.
		expect(lines(picker, 30)[1]).toBe(" Resume session  this folder… ");
		picker.handleInput("\t");
		await flush();
		picker.handleInput("\x13");
		picker.handleInput("\x18");
		expect(lines(picker, 80)[1]).toBe(` Resume session${" ".repeat(33)}all folders · 1 marked · recent `);
		expect(lines(picker, 80).join("\n")).not.toMatch(/[◉○]| of 30/);
	});

	it("moves one row per wheel step and stops at the ends, selects on a press and resumes on a second click", async () => {
		const { picker, events, selected } = await openPicker(30);
		const mouse = (type: "press" | "click" | "wheel", y: number, wheelDelta?: number) => {
			const height = picker.render(80).length;
			const base = { button: type === "wheel" ? "none" : "left", x: 4, screenX: 4, screenY: y, width: 80 } as const;
			return picker.handleMouse({ ...base, type, y, height, shift: false, alt: false, ctrl: false, wheelDelta });
		};
		const rowOf = (text: string) => lines(picker).findIndex((line) => line.includes(text));
		mouse("wheel", 5, -1);
		expect(selected()).toBe("s000");
		mouse("wheel", 5, 1);
		expect(selected()).toBe("s001");
		// The second line of a two-line row belongs to that session.
		const row = rowOf("Task 3 topic") + 1;
		expect(mouse("press", row)).toMatchObject({ handled: true, focus: true });
		mouse("click", row);
		expect(selected()).toBe("s003");
		expect(events).toEqual([]);
		mouse("press", row);
		mouse("click", row);
		expect(events).toEqual(["select /tmp/s003.jsonl"]);
	});

	it("clamps the wheel at the last session and ignores clicks while a delete question is open", async () => {
		const { picker, events, selected } = await openPicker(30);
		const event = { x: 4, screenX: 4, width: 80, shift: false, alt: false, ctrl: false } as const;
		picker.handleInput(END);
		picker.render(80);
		picker.handleMouse({ ...event, type: "wheel", button: "none", y: 5, screenY: 5, height: 24, wheelDelta: 1 });
		expect(selected()).toBe("s029");
		picker.handleInput(CTRL_D);
		const height = picker.render(80).length;
		const press = { ...event, button: "left", y: 3, screenY: 3, height } as const;
		expect(picker.handleMouse({ ...press, type: "press" })).toBeUndefined();
		expect(picker.handleMouse({ ...press, type: "click" })).toBeUndefined();
		expect(selected()).toBe("s029");
		expect(events).toEqual([]);
		expect(lines(picker).join("\n")).toContain("Delete session?");
	});
});

function entry(id: string, parentId: string | null, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: text, timestamp: Date.now() },
	};
}

/** A chain of `count` user messages, each the child of the one before. */
function chain(count: number): SessionTreeNode[] {
	let node: SessionTreeNode | undefined;
	for (let n = count - 1; n >= 0; n--) {
		node = { entry: entry(`e${n}`, n === 0 ? null : `e${n - 1}`, `step ${n} note`), children: node ? [node] : [] };
	}
	return node ? [node] : [];
}

function openTree(count: number) {
	const events: string[] = [];
	// 24 terminal rows give the tree 12 visible rows.
	const tree = new TreeSelectorComponent(
		chain(count),
		"e0",
		24,
		(id) => events.push(`select ${id}`),
		() => events.push("cancel"),
	);
	const selected = () => tree.getTreeList().getSelectedNode()?.entry.id;
	return { tree, events, selected };
}

describe("session tree (#15) on the list contract", () => {
	it("draws one ⌕ search line, a › cursor and an a–b/total foot, and keeps every line to the width", () => {
		const { tree } = openTree(40);
		const screen = lines(tree);
		expect(screen.filter((line) => line.includes("⌕"))).toEqual([" ⌕ type to search"]);
		expect(cursorRow(tree)).toContain("step 0 note");
		expect(screen).toContain("  1–12/40");
		expect(screen.at(-2)).toMatch(/^ ↑\/↓ move · enter select/);
		expectFits(tree);
	});

	it("pages with page keys and ←/→ by the visible rows, stops at the ends and jumps with Home/End", () => {
		const { tree, selected } = openTree(40);
		tree.handleInput(UP);
		expect(selected()).toBe("e0");
		tree.handleInput(PAGE_DOWN);
		expect(selected()).toBe("e12");
		tree.handleInput(RIGHT);
		expect(selected()).toBe("e24");
		tree.handleInput(LEFT);
		expect(selected()).toBe("e12");
		tree.handleInput(END);
		expect(selected()).toBe("e39");
		tree.handleInput(DOWN);
		tree.handleInput(RIGHT);
		expect(selected()).toBe("e39");
		tree.handleInput(HOME);
		expect(selected()).toBe("e0");
	});

	it("filters by every typed token, names the query when nothing matches, and Esc clears before it cancels", () => {
		const { tree, events, selected } = openTree(40);
		for (const ch of "note 17") tree.handleInput(ch);
		expect(selected()).toBe("e17");
		expect(lines(tree)).toContain(" ⌕ note 17");
		for (const ch of "x") tree.handleInput(ch);
		expect(lines(tree)).toContain('  No entries match "note 17x" · esc clears');
		tree.handleInput(ESC);
		expect(events).toEqual([]);
		expect(tree.getTreeList().getSearchQuery()).toBe("");
		tree.handleInput(ESC);
		expect(events).toEqual(["cancel"]);
	});
});
