import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { renderAltScreenOutput } from "../src/tui-alt-screen/frame.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { trimTrailingBlanks } from "../src/tui/trailing-blanks.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Records every write so frames and bytes can be counted. */
class RecordingTerminal extends VirtualTerminal {
	readonly chunks: string[] = [];
	override write(data: string): void {
		this.chunks.push(data);
		super.write(data);
	}
	get frames(): number {
		return this.chunks.filter((chunk) => chunk.includes("\x1b[?2026h")).length;
	}
	get output(): string {
		return this.chunks.join("");
	}
}

class Lines implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
	handleInput(data: string): void {
		this.lines = [...this.lines.slice(0, -1), `typed:${data}`];
	}
}

/** Streams `count` updates 5 ms apart, each extending the last line. */
async function stream(tui: TuiMainScreen, body: Lines, count: number, prefix = "") {
	for (let i = 1; i <= count; i++) {
		body.lines = [`${prefix}header`, `${prefix}token ${i}`.padEnd(30)];
		tui.requestRender();
		await pause(5);
	}
}

describe("streaming repaint cost", () => {
	it("coalesces a burst of stream updates into few frames", async () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const body = new Lines();
		tui.addChild(body);
		tui.start();
		await terminal.waitForRender();
		const before = terminal.frames;
		const started = Date.now();
		await stream(tui, body, 100);
		const elapsed = Date.now() - started;
		await terminal.waitForRender();
		const frames = terminal.frames - before;
		// One frame per 40 ms plus the trailing frame; the old 16 ms floor painted about 3x as many.
		assert.ok(frames <= Math.ceil(elapsed / 40) + 2, `${frames} frames in ${elapsed} ms`);
		assert.ok(frames < 60, `${frames} frames for 100 updates`);
		tui.stop();
	});

	it("always flushes the final frame of a stream", async () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const body = new Lines();
		tui.addChild(body);
		tui.start();
		await terminal.waitForRender();
		await stream(tui, body, 37);
		await terminal.waitForRender();
		assert.ok((await terminal.flushAndGetViewport())[1]?.startsWith("token 37"));
		tui.stop();
	});

	it("echoes a key at once while a stream is being throttled", async () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const body = new Lines();
		tui.addChild(body);
		tui.setFocus(body);
		tui.start();
		await terminal.waitForRender();
		await stream(tui, body, 3);
		// A throttled frame is pending right now.
		body.lines = ["header", "streaming"];
		tui.requestRender();
		const keyAt = Date.now();
		terminal.sendInput("k");
		await new Promise<void>((resolve) => process.nextTick(resolve));
		await terminal.flush();
		assert.ok(Date.now() - keyAt < 30, "echo waited for the throttle");
		assert.ok((await terminal.flushAndGetViewport())[1]?.includes("typed:k"));
		tui.stop();
	});

	it("scrolls in regular mode without a full redraw", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const tui = new TuiMainScreen(terminal);
		const body = new Lines();
		tui.addChild(body);
		tui.start();
		await terminal.waitForRender();
		body.lines = ["line 0"];
		tui.requestRender();
		await terminal.waitForRender();
		const redrawsAtStart = tui.fullRedraws;
		const before = terminal.chunks.length;
		for (let i = 1; i <= 40; i++) {
			body.lines = Array.from({ length: i }, (_, row) => `line ${row}`);
			tui.requestRender();
			await pause(8);
		}
		await terminal.waitForRender();
		assert.strictEqual(tui.fullRedraws, redrawsAtStart);
		assert.doesNotMatch(terminal.chunks.slice(before).join(""), /\x1b\[[23]J/);
		const viewport = await terminal.flushAndGetViewport();
		assert.strictEqual(viewport[7]?.trimEnd(), "line 39");
		tui.stop();
	});

	it("writes no trailing padding and keeps the screen", async () => {
		const terminal = new RecordingTerminal(30, 6);
		const tui = new TuiMainScreen(terminal);
		const body = new Lines();
		tui.addChild(body);
		tui.start();
		await terminal.waitForRender();
		body.lines = ["one", "two", "three", "four"];
		tui.requestRender();
		await terminal.waitForRender();
		const before = terminal.chunks.length;
		body.lines = [
			"alpha".padEnd(30),
			"\x1b[44mbar\x1b[0m".padEnd(40),
			"gamma ".padEnd(30),
			"\x1b[44m   \x1b[0m".padEnd(30),
		];
		tui.requestRender();
		await terminal.waitForRender();
		const bytes = terminal.chunks.slice(before).join("");
		assert.doesNotMatch(bytes, / {2,}(?:\x1b\[0m)?(?:\x1b\]8;;\x07)?(?:\r|\x1b\[\?2026l|$)/);
		assert.ok(bytes.includes("\x1b[44m   \x1b[0m"), "background cells must be written");
		const viewport = await terminal.flushAndGetViewport();
		assert.deepStrictEqual(
			viewport.slice(0, 3).map((row) => row.trimEnd()),
			["alpha", "bar", "gamma"],
		);
		tui.stop();
	});
});

describe("trimTrailingBlanks", () => {
	it("drops plain trailing spaces and keeps visible ones", () => {
		assert.strictEqual(trimTrailingBlanks("abc   "), "abc");
		assert.strictEqual(trimTrailingBlanks("abc  \x1b[0m"), "abc\x1b[0m");
		assert.strictEqual(trimTrailingBlanks("abc\x1b[44m   \x1b[0m"), "abc\x1b[44m   \x1b[0m");
		assert.strictEqual(trimTrailingBlanks("abc\x1b[7m  \x1b[0m  "), "abc\x1b[7m  \x1b[0m");
		assert.strictEqual(trimTrailingBlanks("abc\x1b[4m  \x1b[24m  "), "abc\x1b[4m  \x1b[24m");
		assert.strictEqual(trimTrailingBlanks("\x1b[48;5;12m  x\x1b[0m  "), "\x1b[48;5;12m  x\x1b[0m");
		assert.strictEqual(trimTrailingBlanks("日本  "), "日本");
		assert.strictEqual(trimTrailingBlanks("a b"), "a b");
		assert.strictEqual(trimTrailingBlanks("ab  \x1b[0m\x1b]8;;\x07"), "ab\x1b[0m\x1b]8;;\x07");
	});

	it("reads hyperlink, empty SGR and look-alike endings like the tail they are", () => {
		assert.strictEqual(trimTrailingBlanks("ab \x1b]8;;https://x.y/a b\x1b\\  "), "ab\x1b]8;;https://x.y/a b\x1b\\");
		assert.strictEqual(trimTrailingBlanks("ab  \x1b[m  "), "ab\x1b[m");
		assert.strictEqual(trimTrailingBlanks("program  "), "program");
		assert.strictEqual(trimTrailingBlanks("a [1m  "), "a [1m");
		assert.strictEqual(trimTrailingBlanks("a\x1b[1xm  "), "a\x1b[1xm");
		assert.strictEqual(trimTrailingBlanks("a ]8;x\x07 "), "a ]8;x\x07");
		assert.strictEqual(trimTrailingBlanks("\x1b]8;;u\x07\x1b]8;;\x07   "), "\x1b]8;;u\x07\x1b]8;;\x07");
		assert.strictEqual(trimTrailingBlanks("   "), "");
		assert.strictEqual(trimTrailingBlanks(""), "");
	});

	it("matches the leftmost-tail definition on generated rows", () => {
		// The definition the scan replaces: the longest suffix made only of spaces, SGR codes and OSC 8 codes.
		const token = " |\\x1b\\[[0-9;:]*m|\\x1b\\]8;[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)";
		const tail = new RegExp(`(?:${token})+$`);
		const pieces = [" ", "  ", "x", "m", "[", "1", ";", "\x1b", "\x1b[0m", "\x1b[44m", "\x1b[7m", "\x1b[27m"];
		pieces.push("\x1b[4:3m", "\x1b[m", "\x1b]8;;u\x07", "\x1b]8;;\x07", "\x1b]8;;u\x1b\\", "\x07", "\\", "日");
		let seed = 7;
		const next = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed;
		};
		for (let n = 0; n < 3000; n++) {
			const row = Array.from({ length: next() % 12 }, () => pieces[next() % pieces.length]).join("");
			const match = tail.exec(row);
			const trimmed = trimTrailingBlanks(row);
			if (!match) assert.strictEqual(trimmed, row, JSON.stringify(row));
			else assert.strictEqual(trimmed.slice(0, match.index), row.slice(0, match.index), JSON.stringify(row));
			assert.ok(row.startsWith(trimmed.slice(0, match?.index ?? row.length)));
		}
	});
});

describe("alternate-screen scroll", () => {
	const rows = 20;
	const text = (n: number) => `row ${n} ${"x".repeat(30)}`.padEnd(60);
	const page = (start: number) => Array.from({ length: rows }, (_, i) => text(start + i));

	it("scrolls a region in place instead of rewriting every row, and keeps the screen", async () => {
		const options = { width: 60, height: rows, imageProtocol: null, uploadedKittyImages: new Map() } as const;
		const first = page(0);
		const second = page(1);
		const common = {
			previousScreenWidth: 60,
			previousScreenHeight: rows,
			cursorPos: null,
			showHardwareCursor: false,
			...options,
		};
		const initial = renderAltScreenOutput({ ...common, screen: first, previousScreen: [] });
		const scrolled = renderAltScreenOutput({ ...common, screen: second, previousScreen: first });
		assert.strictEqual(scrolled.fullRedraw, false);
		assert.ok(scrolled.buffer.length < 600, `${scrolled.buffer.length} bytes for a one-row scroll`);
		assert.match(scrolled.buffer, /\x1b\[1S/);

		const incremental = new VirtualTerminal(60, rows);
		incremental.write(initial.buffer);
		incremental.write(scrolled.buffer);
		const reference = new VirtualTerminal(60, rows);
		reference.write(renderAltScreenOutput({ ...common, screen: second, previousScreen: [] }).buffer);
		assert.deepStrictEqual(await incremental.flushAndGetViewport(), await reference.flushAndGetViewport());
	});

	it("keeps pinned rows outside the scrolled region", async () => {
		const pinned = (screen: string[]) => [...screen.slice(0, rows - 2), "STATUS".padEnd(60), "EDITOR".padEnd(60)];
		const common = {
			previousScreenWidth: 60,
			previousScreenHeight: rows,
			width: 60,
			height: rows,
			imageProtocol: null,
			uploadedKittyImages: new Map(),
			cursorPos: null,
			showHardwareCursor: false,
		} as const;
		const first = pinned(page(0));
		const second = pinned(page(3));
		const initial = renderAltScreenOutput({ ...common, screen: first, previousScreen: [] });
		const scrolled = renderAltScreenOutput({ ...common, screen: second, previousScreen: first });
		const incremental = new VirtualTerminal(60, rows);
		incremental.write(initial.buffer);
		incremental.write(scrolled.buffer);
		const reference = new VirtualTerminal(60, rows);
		reference.write(renderAltScreenOutput({ ...common, screen: second, previousScreen: [] }).buffer);
		assert.deepStrictEqual(await incremental.flushAndGetViewport(), await reference.flushAndGetViewport());
		assert.ok(scrolled.buffer.length < 700, `${scrolled.buffer.length} bytes`);
	});

	it("streams through TuiAltScreen with the same final screen", async () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new TuiAltScreen(terminal);
		const body = new Lines();
		tui.addChild(body);
		tui.start();
		try {
			await terminal.waitForRender();
			for (let i = 1; i <= 30; i++) {
				body.lines = Array.from({ length: i }, (_, row) => `line ${row}`);
				tui.requestRender();
				await pause(6);
			}
			await terminal.waitForRender();
			const viewport = (await terminal.flushAndGetViewport()).map((row) => row.trimEnd());
			assert.ok(viewport.includes("line 29"), viewport.join("|"));
		} finally {
			tui.stop();
		}
	});
});
