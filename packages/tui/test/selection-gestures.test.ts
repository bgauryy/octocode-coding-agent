import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import type { Component } from "../src/tui/component.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { AUTO_SCROLL_INTERVAL_MS } from "../src/tui-alt-screen/selection-auto-scroll.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Fake the animation clock's interval and `Date`, and move them in cadence-sized steps (a callback reads the clock at the end of its tick). */
function fakeClock(t: TestContext): (ms: number) => void {
	t.mock.timers.enable({ apis: ["setInterval", "Date"] });
	return (ms) => {
		for (let elapsed = 0; elapsed < ms; elapsed += AUTO_SCROLL_INTERVAL_MS) t.mock.timers.tick(AUTO_SCROLL_INTERVAL_MS);
	};
}

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

/** A screen whose copies are recorded; `add` fills it before it starts. */
async function screen(width: number, height: number, add: (tui: TuiAltScreen) => void) {
	const terminal = new RecordingTerminal(width, height);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	tui.flash = () => {};
	add(tui);
	tui.start();
	await terminal.waitForRender();
	const settle = async () => {
		await terminal.waitForRender();
		await new Promise<void>((resolve) => setImmediate(resolve));
	};
	/** Press and release at a 0-based cell; `button` 4 holds Shift. */
	const click = (col: number, row: number, button = 0) => {
		terminal.sendInput(`\x1b[<${button};${col + 1};${row + 1}M`);
		terminal.sendInput(`\x1b[<${button};${col + 1};${row + 1}m`);
	};
	const drag = (from: [number, number], to: [number, number]) => {
		terminal.sendInput(`\x1b[<0;${from[0] + 1};${from[1] + 1}M`);
		terminal.sendInput(`\x1b[<32;${to[0] + 1};${to[1] + 1}M`);
		terminal.sendInput(`\x1b[<0;${to[0] + 1};${to[1] + 1}m`);
	};
	return { terminal, tui, copied, settle, click, drag };
}

const PROSE = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";

describe("copying boxed rows", () => {
	const BOX = "│ hello world  │\n│   indented   │\n│ third        │";

	it("leaves out the border and its padding on rows the selection covers whole", async () => {
		const s = await screen(16, 4, (tui) => tui.addChild(new Text(BOX, 0, 0)));
		s.drag([0, 0], [15, 2]);
		await s.settle();
		assert.deepEqual(s.copied, ["hello world\n  indented\nthird"]);
		s.tui.stop();
	});

	it("keeps text a selection starts inside, border or not", async () => {
		const s = await screen(16, 4, (tui) => tui.addChild(new Text(BOX, 0, 0)));
		s.drag([2, 0], [15, 0]);
		await s.settle();
		assert.deepEqual(s.copied, ["hello world"]);
		s.tui.stop();
	});
});

describe("selection across a resize", () => {
	it("is dropped when the width changes, as the rows wrap anew", async () => {
		const s = await screen(24, 8, (tui) => tui.addChild(new Markdown(PROSE, 1, 0, defaultMarkdownTheme)));
		s.drag([1, 0], [7, 0]);
		await s.settle();
		assert.equal(s.tui.hasActiveSelection(), true);
		s.terminal.resize(60, 8);
		await s.settle();
		await s.settle();
		assert.equal(s.tui.hasActiveSelection(), false);
		s.tui.stop();
	});

	it("stays when only the height changes", async () => {
		const s = await screen(24, 8, (tui) => tui.addChild(new Markdown(PROSE, 1, 0, defaultMarkdownTheme)));
		s.drag([1, 0], [7, 0]);
		await s.settle();
		s.terminal.resize(24, 10);
		await s.settle();
		await s.settle();
		assert.equal(s.tui.hasActiveSelection(), true);
		s.tui.stop();
	});
});

describe("multi-click selection", () => {
	it("triple-click selects the whole soft-wrapped line, not only the clicked row", async () => {
		const s = await screen(24, 8, (tui) => tui.addChild(new Markdown(PROSE, 1, 0, defaultMarkdownTheme)));
		for (let count = 0; count < 3; count++) s.click(3, 2);
		await s.settle();
		assert.equal(s.copied.at(-1), PROSE);
		s.tui.stop();
	});

	it("triple-click at column 0 of an indented line selects the logical line", async () => {
		const s = await screen(30, 4, (tui) => tui.addChild(new Text("    indented words", 0, 0)));
		for (let count = 0; count < 3; count++) s.click(0, 0);
		await s.settle();
		assert.match(s.copied.at(-1) ?? "", /^\s*indented words$/);
		s.tui.stop();
	});

	it("triple-click on an empty row selects that row, and a double-click there selects nothing", async () => {
		const s = await screen(30, 4, (tui) => tui.addChild(new Text("first\n\nthird", 0, 0)));
		s.click(2, 1);
		s.click(2, 1);
		await s.settle();
		assert.deepEqual(s.copied, []);
		// The third press holds; dragging to the next row extends by whole lines from the empty row.
		s.terminal.sendInput("\x1b[<0;3;2M");
		s.terminal.sendInput("\x1b[<32;3;3M");
		s.terminal.sendInput("\x1b[<0;3;3m");
		await s.settle();
		assert.equal(s.copied.at(-1), "\nthird");
		s.tui.stop();
	});

	it("a triple-click on an empty row selects that line at once and copies it with its line break", async () => {
		const s = await screen(30, 4, (tui) => tui.addChild(new Text("first\n\nthird", 0, 0)));
		for (let count = 0; count < 3; count++) s.click(2, 1);
		await s.settle();
		assert.equal(s.tui.hasActiveSelection(), true);
		assert.deepEqual(s.copied, ["\n"]);
		s.tui.stop();
	});

	it("double-click selects a word the width cut across rows", async () => {
		const s = await screen(12, 6, (tui) => tui.addChild(new Text("abcdefghijklmnopqrstuvwxyz", 1, 0)));
		s.click(4, 1);
		s.click(4, 1);
		await s.settle();
		assert.deepEqual(s.copied, ["abcdefghijklmnopqrstuvwxyz"]);
		s.tui.stop();
	});

	it("double-click selects a word of wide characters by whole cells", async () => {
		const s = await screen(30, 2, (tui) => tui.addChild(new Text("안녕하세요 세계", 0, 0)));
		// Column 3 is the second cell of the second syllable.
		s.click(3, 0);
		s.click(3, 0);
		await s.settle();
		assert.deepEqual(s.copied, ["안녕하세요"]);
		s.tui.stop();
	});

	it("copies a triple-clicked wrapped line of wide characters joined and intact", async () => {
		const line = "안녕하세요 세계 안녕하세요 세계 😀😀 끝";
		const s = await screen(12, 8, (tui) => tui.addChild(new Markdown(line, 0, 0, defaultMarkdownTheme)));
		for (let count = 0; count < 3; count++) s.click(0, 1);
		await s.settle();
		assert.equal(s.copied.at(-1), line);
		s.tui.stop();
	});

	it("dragging after a triple-click extends by whole lines", async () => {
		const s = await screen(20, 4, (tui) => tui.addChild(new Text("one two\nthree four\nfive six", 0, 0)));
		s.click(1, 0);
		s.click(1, 0);
		s.terminal.sendInput("\x1b[<0;2;1M");
		s.terminal.sendInput("\x1b[<32;2;3M");
		s.terminal.sendInput("\x1b[<0;2;3m");
		await s.settle();
		assert.equal(s.copied.at(-1), "one two\nthree four\nfive six");
		s.tui.stop();
	});
});

describe("shift-click", () => {
	it("extends a drag selection to the clicked cell", async () => {
		const s = await screen(30, 2, (tui) => tui.addChild(new Text("alpha beta gamma delta", 0, 0)));
		s.drag([0, 0], [4, 0]);
		s.click(17, 0, 4);
		await s.settle();
		assert.deepEqual(s.copied, ["alpha", "alpha beta gamma d"]);
		s.tui.stop();
	});

	it("extends a double-clicked word by whole words", async () => {
		const s = await screen(30, 2, (tui) => tui.addChild(new Text("alpha beta gamma delta", 0, 0)));
		s.click(7, 0);
		s.click(7, 0);
		s.click(18, 0, 4);
		await s.settle();
		assert.deepEqual(s.copied, ["beta", "beta gamma delta"]);
		s.tui.stop();
	});

	it("starts a plain selection when nothing is selected", async () => {
		const s = await screen(30, 2, (tui) => tui.addChild(new Text("alpha beta gamma delta", 0, 0)));
		s.click(7, 0, 4);
		await s.settle();
		assert.deepEqual(s.copied, []);
		assert.equal(s.tui.hasActiveSelection(), false);
		s.tui.stop();
	});
});

describe("clearing a selection", () => {
	function focusedInput(tui: TuiAltScreen): string[] {
		const received: string[] = [];
		const input: Component = { render: () => [], invalidate() {}, handleInput: (data) => received.push(data) };
		tui.setFocus(input);
		return received;
	}

	it("Escape drops a selection that shows; the next Escape reaches the focused component", async () => {
		const s = await screen(30, 3, (tui) => tui.addChild(new Text("alpha beta\ngamma delta", 0, 0)));
		const received = focusedInput(s.tui);
		s.drag([0, 0], [4, 1]);
		await s.settle();
		assert.equal(s.tui.hasActiveSelection(), true);
		s.terminal.writes.length = 0;
		s.terminal.sendInput("\x1b");
		await s.settle();
		assert.equal(s.tui.hasActiveSelection(), false);
		assert.deepEqual(received, [], "the first Escape only clears");
		assert.ok(
			s.terminal.writes.some((data) => data.includes("alpha beta") && !data.includes("\x1b[7m")),
			"the highlight is repainted away",
		);
		s.terminal.sendInput("\x1b");
		assert.deepEqual(received, ["\x1b"]);
		s.tui.stop();
	});

	it("a plain click elsewhere drops the selection", async () => {
		const s = await screen(30, 3, (tui) => tui.addChild(new Text("alpha beta\ngamma delta", 0, 0)));
		s.drag([0, 0], [4, 1]);
		await s.settle();
		assert.equal(s.tui.hasActiveSelection(), true);
		s.click(8, 1);
		await s.settle();
		assert.equal(s.tui.hasActiveSelection(), false);
		s.tui.stop();
	});
});

describe("dragging past the edge", () => {
	it("keeps scrolling while the pointer is held still outside the view, without more motion reports", async (t) => {
		const text = Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n");
		const s = await screen(30, 6, (tui) => tui.addChild(new Text(text, 0, 0)));
		const start = s.tui.viewportTop;
		const wait = fakeClock(t);
		s.terminal.sendInput("\x1b[<0;2;4M");
		s.terminal.sendInput("\x1b[<32;2;1M");
		wait(160);
		const early = s.tui.viewportTop;
		wait(240);
		const later = s.tui.viewportTop;
		assert.ok(early < start, `scrolled up from ${start} to ${early}`);
		assert.ok(later < early, `kept scrolling: ${early} then ${later}`);
		s.terminal.sendInput("\x1b[<0;2;1m");
		await s.settle();
		const stopped = s.tui.viewportTop;
		wait(120);
		assert.equal(s.tui.viewportTop, stopped, "release stops it");
		// The focus sits in column 1 of the top row: the copy starts there.
		assert.ok(s.copied.at(-1)?.startsWith(`ine ${stopped}\n`), s.copied.at(-1));
		s.tui.stop();
	});
});

describe("dragging below the transcript", () => {
	/** Lines scrolled in `ms` with the pointer held still `rowsPast` rows below a 6-row transcript (a footer below it). */
	async function scrolledIn(t: TestContext, ms: number, rowsPast: number): Promise<number> {
		const text = Array.from({ length: 2000 }, (_, index) => `line ${index}`).join("\n");
		const transcript = new ScrollView(new Text(text, 0, 0), { primary: true, follow: "none" });
		const footer = new Text(Array.from({ length: 8 }, (_, index) => `footer ${index}`).join("\n"), 0, 0);
		const s = await screen(30, 14, (tui) =>
			tui.setLayoutRoot(
				new VStack([
					{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
					{ component: footer, basis: "auto", grow: 0, shrink: 0, minSize: 8 },
				]),
			),
		);
		transcript.scrollTo(0);
		await s.settle();
		const wait = fakeClock(t);
		s.terminal.sendInput("\x1b[<0;2;3M");
		s.terminal.sendInput(`\x1b[<32;2;${6 + rowsPast}M`);
		wait(ms);
		const scrolled = transcript.scrollTop;
		s.terminal.sendInput(`\x1b[<0;2;${6 + rowsPast}m`);
		s.tui.stop();
		return scrolled;
	}

	it("scrolls faster the farther past the edge the pointer is held, like a web page", async (t) => {
		const near = await scrolledIn(t, 400, 1);
		t.mock.timers.reset();
		const far = await scrolledIn(t, 400, 8);
		assert.ok(near > 0, "one row past the edge scrolls");
		assert.ok(far >= near * 3, `8 rows past moved ${far} lines, 1 row past ${near}`);
	});
});

describe("selection highlight frames", () => {
	it("rewrites only the rows whose highlight changed on each pointer move", async () => {
		const text = Array.from({ length: 12 }, (_, index) => `row ${index} lorem ipsum dolor`).join("\n");
		const s = await screen(40, 12, (tui) => tui.addChild(new Text(text, 0, 0)));
		s.terminal.sendInput("\x1b[<0;3;2M");
		const rewritten: number[] = [];
		for (let y = 3; y <= 9; y++) {
			await s.settle();
			s.terminal.writes.length = 0;
			s.terminal.sendInput(`\x1b[<32;10;${y}M`);
			await s.settle();
			const frame = s.terminal.writes.join("");
			assert.ok(!frame.includes("\x1b[2J"), "no full clear");
			rewritten.push((frame.match(/\x1b\[\d+;1H\x1b\[2K/g) ?? []).length);
		}
		// Moving down a row changes the row the focus left (now highlighted to its end) and the row it entered.
		assert.deepEqual(rewritten, [2, 2, 2, 2, 2, 2, 2]);
		s.terminal.sendInput("\x1b[<0;10;9m");
		s.tui.stop();
	});
});
