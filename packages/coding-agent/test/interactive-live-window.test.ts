import { type Component, Container, type TUI, TuiMainScreen } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { foldScrolledTranscript, hasLiveFold } from "../src/modes/interactive/interactive-mode/live-window.ts";
import { loadEarlierFromKey } from "../src/modes/interactive/interactive-mode/session-window.ts";
import { initTheme } from "../src/theme/theme.ts";

class ClearCounter extends VirtualTerminal {
	clears = 0;
	override write(data: string): void {
		if (data.includes("\x1b[3J")) this.clears += 1;
		super.write(data);
	}
}

class Rows implements Component {
	disposed = false;
	readonly label: string;
	readonly rows: number;
	constructor(label: string, rows = 1) {
		this.label = label;
		this.rows = rows;
	}
	render(width: number): string[] {
		// The width shows in the row, so a redraw at a new width is visible.
		return Array.from({ length: this.rows }, (_, row) => `${this.label}.${row} w${width}`);
	}
	invalidate(): void {}
	dispose(): void {
		this.disposed = true;
	}
}

const KEEP = 40;
const BATCH = 20;
const started: TUI[] = [];

function session(columns = 60, height = 10) {
	const terminal = new ClearCounter(columns, height);
	const ui = new TuiMainScreen(terminal);
	const chatContainer = new Container();
	ui.addChild(chatContainer);
	ui.addChild(new Rows("editor", 2));
	ui.start();
	ui.renderNow();
	started.push(ui);
	const host = {
		chatContainer,
		pendingTools: new Map<string, Component>(),
		streamingComponent: undefined as Component | undefined,
		ui,
	};
	const added: Rows[] = [];
	/** One turn: a user row and a three-row reply, then the next turn's start folds. */
	const turn = (index: number) => {
		for (const row of [new Rows(`user ${index}`), new Rows(`reply ${index}`, 3)]) {
			added.push(row);
			chatContainer.addChild(row);
		}
		ui.renderNow();
		foldScrolledTranscript(host as never, KEEP, BATCH);
		ui.renderNow();
	};
	return { terminal, ui, host, added, turn };
}

const retainedRows = (ui: TuiMainScreen) => ui.captureRenderState().previousLines.length;

async function screen(terminal: VirtualTerminal): Promise<string[]> {
	const rows = (await terminal.flushAndGetViewport()).map((row) => row.trimEnd());
	while (rows.at(-1) === "") rows.pop();
	return rows;
}

const lastRows = (ui: TuiMainScreen, width: number, count: number) =>
	ui
		.render(width)
		.map((row) => row.trimEnd())
		.slice(-count);

beforeAll(() => {
	initTheme("dark");
});

afterEach(() => {
	for (const ui of started.splice(0)) ui.stop();
});

describe("live transcript window (main screen)", () => {
	it("keeps mounted rows and the renderer's rows bounded as turns grow, without clearing scrollback", async () => {
		const { terminal, ui, host, added, turn } = session();
		const bound = { children: KEEP + BATCH + 1, rows: 4 * (KEEP + BATCH) + 1 + 2 };
		const samples: number[] = [];
		for (let index = 0; index < 1000; index++) {
			turn(index);
			if (index === 99 || index === 999) samples.push(retainedRows(ui));
			expect(host.chatContainer.children.length).toBeLessThanOrEqual(bound.children);
		}
		for (const rows of samples) expect(rows).toBeLessThanOrEqual(bound.rows);
		expect(hasLiveFold(host.chatContainer)).toBe(true);
		const mounted = new Set(host.chatContainer.children);
		for (const row of added) expect(row.disposed).toBe(!mounted.has(row));
		// Each fold only moved the renderer's row numbers: no replay, scrollback never cleared.
		expect(ui.fullRedraws).toBe(1);
		expect(terminal.clears).toBe(0);
		const shown = await screen(terminal);
		expect(shown).toEqual(lastRows(ui, 60, shown.length));
		// The newest folded row is still in the terminal's scrollback (the emulator keeps its last 1,000 rows).
		const newestFolded = added.filter((row) => row.disposed).at(-1);
		expect(newestFolded).toBeDefined();
		const label = `${newestFolded?.label}.0 w60`;
		expect(terminal.getScrollBuffer().some((row) => row.startsWith(label))).toBe(true);
	});

	it("redraws the folded transcript at a new width: the fold row, then the rows still mounted", async () => {
		const { terminal, ui, host, turn } = session();
		for (let index = 0; index < 200; index++) turn(index);
		terminal.resize(50, 10);
		ui.renderNow();
		const shown = await screen(terminal);
		expect(shown).toEqual(lastRows(ui, 50, shown.length));
		const replayed = terminal.getScrollBuffer().map((row) => row.trimEnd());
		const first = replayed.findIndex((row) => row.length > 0);
		expect(replayed[first]).toMatch(/↑ \d+ earlier rows left in terminal scrollback/);
		expect(replayed.some((row) => row.endsWith("w60"))).toBe(false);
		expect(replayed.filter((row) => row.length > 0).length).toBe(ui.render(50).length);
		expect(host.chatContainer.children.length).toBeLessThanOrEqual(KEEP + BATCH + 1);
	});

	it("stops at a row still streaming, and leaves it with every row after it", () => {
		const { ui, host, turn } = session();
		for (let index = 0; index < 20; index++) turn(index);
		const live = new Container();
		const running = new Rows("running tool");
		live.addChild(running);
		host.chatContainer.addChild(live);
		host.pendingTools.set("call-1", running);
		for (let index = 20; index < 200; index++) turn(index);
		const children = host.chatContainer.children;
		expect(children).toContain(live);
		expect(children.indexOf(live)).toBeLessThanOrEqual(1);
		expect(running.disposed).toBe(false);
		ui.renderNow();
	});

	it("leaves a renderer without scrollback (fullscreen) alone", () => {
		const chatContainer = new Container();
		for (let index = 0; index < 200; index++) chatContainer.addChild(new Rows(`row ${index}`));
		const ui = { requestRender: vi.fn() };
		const host = { chatContainer, pendingTools: new Map(), streamingComponent: undefined, ui };
		expect(foldScrolledTranscript(host as never, KEEP, BATCH)).toBe(0);
		expect(chatContainer.children.length).toBe(200);
	});

	it("the load-earlier key rebuilds a folded transcript from the session", () => {
		const { ui, host, turn } = session();
		for (let index = 0; index < 100; index++) turn(index);
		const rebuildChatFromMessages = vi.fn(() => host.chatContainer.clear());
		const showStatus = vi.fn();
		loadEarlierFromKey({ ...host, ui, rebuildChatFromMessages, showStatus } as never);
		expect(rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(showStatus).not.toHaveBeenCalled();
		loadEarlierFromKey({ ...host, ui, rebuildChatFromMessages, showStatus } as never);
		expect(rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith("No earlier messages to load");
	});
});
