import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { animationClock } from "../src/tokens/clock.ts";
import { MOTION } from "../src/tokens/design.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => animationClock.setFocused(true));

describe("TUI focus reports and fence replies", () => {
	it("observes focus reports for the clock without consuming them, and restores focus on stop", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const seen: string[] = [];
		tui.addInputListener((data) => {
			seen.push(data);
			return undefined;
		});
		tui.start();
		const ticks: number[] = [];
		const stop = animationClock.subscribe(() => ticks.push(Date.now()), { everyMs: 20, kind: "decor" });
		try {
			terminal.sendInput("\x1b[O");
			assert.deepStrictEqual(seen, ["\x1b[O"], "listeners still see focus out");
			ticks.length = 0;
			await wait(MOTION.backgroundSpinnerMs * 3 + 50);
			assert.ok(ticks.length <= 4, `slowed: ${ticks.length} ticks`);
			terminal.sendInput("\x1b[I");
			assert.deepStrictEqual(seen, ["\x1b[O", "\x1b[I"]);
			terminal.sendInput("\x1b[O");
			tui.stop();
			ticks.length = 0;
			await wait(100);
			assert.ok(ticks.length >= 3, `stop restored the cadence: ${ticks.length} ticks`);
		} finally {
			stop();
		}
	});

	it("takes a keystroke as proof of focus when a terminal never sends focus-in", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		tui.start();
		const ticks: number[] = [];
		const stop = animationClock.subscribe(() => ticks.push(Date.now()), { everyMs: 20, kind: "decor" });
		try {
			terminal.sendInput("\x1b[O");
			terminal.sendInput("\x1b[<35;5;5M"); // mouse motion can reach an unfocused window: not proof
			ticks.length = 0;
			await wait(150);
			assert.ok(ticks.length <= 2, `still slowed after mouse motion: ${ticks.length} ticks`);
			terminal.sendInput("a");
			ticks.length = 0;
			await wait(150);
			assert.ok(ticks.length >= 4, `a keystroke restored the cadence: ${ticks.length} ticks`);
		} finally {
			stop();
			tui.stop();
		}
	});

	it("passes focus reports to every input listener in fullscreen, never to the focused component", () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiAltScreen(terminal);
		const seen: string[] = [];
		const typed: string[] = [];
		tui.addInputListener((data) => {
			seen.push(data);
			return undefined;
		});
		tui.setFocus({ render: () => [], invalidate() {}, handleInput: (data: string) => void typed.push(data) });
		tui.start();
		try {
			terminal.sendInput("\x1b[O");
			terminal.sendInput("\x1b[I");
			assert.deepStrictEqual(seen, ["\x1b[O", "\x1b[I"], "notifications hear focus in fullscreen");
			assert.deepStrictEqual(typed, [], "focus reports are not typed text");
		} finally {
			tui.stop();
		}
	});

	it("does not deliver a fence reply to input listeners or the editor", () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const seen: string[] = [];
		tui.addInputListener((data) => {
			seen.push(data);
			return undefined;
		});
		tui.start();
		terminal.sendInput("\x1b[0n");
		tui.stop();
		terminal.sendInput("\x1b[0n");
		assert.deepStrictEqual(seen, []);
	});
});
