import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import { renderAltScreenOutput } from "../src/tui-alt-screen/frame.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Records each write; `synchronizedOutput` stands for the DECRQM answer. */
class WriteLog extends VirtualTerminal {
	readonly writes: string[] = [];
	synchronizedOutput = false;
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function transcript(terminal: WriteLog) {
	const tui = new TuiAltScreen(terminal);
	tui.addChild(new Text(Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n"), 0, 0));
	tui.start();
	return tui;
}

describe("alternate-screen frames on a terminal without synchronized output", () => {
	it("writes a frame without begin/end markers unless the terminal confirmed mode 2026", async () => {
		for (const synchronized of [false, true]) {
			const terminal = new WriteLog(40, 10);
			terminal.synchronizedOutput = synchronized;
			const tui = transcript(terminal);
			await terminal.waitForRender();
			terminal.writes.length = 0;
			terminal.sendInput("\x1b[<64;1;1M");
			await wait(40);
			const frames = terminal.writes.filter((write) => write.includes("\x1b[") && write.includes("H"));
			assert.strictEqual(frames.length, 1, "one wheel frame is one write");
			assert.strictEqual(frames[0].includes("\x1b[?2026h"), synchronized);
			assert.strictEqual(frames[0].includes("\x1b[?2026l"), synchronized);
			tui.stop();
		}
	});

	it("moves the lines of every wheel event of one frame in one scroll", async () => {
		const terminal = new WriteLog(40, 10);
		const tui = transcript(terminal);
		await terminal.waitForRender();
		const before = (await terminal.flushAndGetViewport()).map((row) => row.trimEnd());
		terminal.writes.length = 0;
		for (let event = 0; event < 4; event++) terminal.sendInput("\x1b[<64;1;1M");
		await wait(40);
		assert.strictEqual(terminal.writes.length, 1, "four events, one frame");
		assert.match(terminal.writes[0], /\x1b\[4T/, "one region scroll of four lines");
		assert.strictEqual(terminal.writes[0].match(/\x1b\[\d+[ST]/g)?.length, 1);
		const after = (await terminal.flushAndGetViewport()).map((row) => row.trimEnd());
		assert.deepStrictEqual(after.slice(4), before.slice(0, 6));
		tui.stop();
	});

	it("corrects the rows the scroll moved right after the scroll, before it fills the new rows", async () => {
		const height = 12;
		const cell = (row: number, thumb: boolean) => `${`row ${row}`.padEnd(39)}${thumb ? "┃" : "│"}`;
		// The thumb is fixed on screen (rows 4 and 5) while the text under it moves down by one row (wheel up).
		const page = (first: number) =>
			Array.from({ length: height }, (_, row) => cell(first + row, row === 4 || row === 5));
		const common = {
			previousScreenWidth: 40,
			previousScreenHeight: height,
			width: 40,
			height,
			imageProtocol: null,
			uploadedKittyImages: new Map(),
			cursorPos: null,
			showHardwareCursor: false,
		} as const;
		const first = page(1);
		const second = page(0);
		const scrolled = renderAltScreenOutput({ ...common, screen: second, previousScreen: first }).buffer;
		const scroll = scrolled.indexOf("\x1b[1T");
		assert.ok(scroll >= 0, "the frame scrolls a region");
		const rewritten = [...scrolled.slice(scroll).matchAll(/\x1b\[(\d+);1H/g)].map((match) => Number(match[1]) - 1);
		// The scroll leaves the thumb one row late: row 4 lost it and row 6 shows it. Those corrections come first,
		// then the row the scroll left blank at the top.
		assert.deepStrictEqual(rewritten, [4, 6, 0]);

		const incremental = new VirtualTerminal(40, height);
		incremental.write(renderAltScreenOutput({ ...common, screen: first, previousScreen: [] }).buffer);
		incremental.write(scrolled);
		const reference = new VirtualTerminal(40, height);
		reference.write(renderAltScreenOutput({ ...common, screen: second, previousScreen: [] }).buffer);
		assert.deepStrictEqual(await incremental.flushAndGetViewport(), await reference.flushAndGetViewport());
	});

	it("keeps a wheel spin to one frame per 60 Hz refresh", async () => {
		const terminal = new WriteLog(40, 10);
		const tui = transcript(terminal);
		await terminal.waitForRender();
		const frameTimes: number[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = (data) => {
			frameTimes.push(performance.now());
			write(data);
		};
		// 24 events about 4 ms apart: at 8 ms frames this painted every other event.
		for (let event = 0; event < 24; event++) {
			terminal.sendInput("\x1b[<64;1;1M");
			await wait(4);
		}
		await wait(40);
		assert.ok(frameTimes.length > 1 && frameTimes.length < 24, `${frameTimes.length} frames for 24 events`);
		const gaps = frameTimes.slice(1).map((time, index) => time - frameTimes[index]);
		// Timers fire a little early or late; no two frames come closer than most of a 60 Hz refresh.
		assert.ok(Math.min(...gaps) >= 14, `frames ${gaps.map((gap) => gap.toFixed(1)).join(", ")} ms apart`);
		tui.stop();
	});
});
