import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { SYNC_RENEW_INTERVAL_CHARS } from "../src/tui-main-screen/render-output.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

class RecordingTerminal extends VirtualTerminal {
	written: string[] = [];

	override write(data: string): void {
		this.written.push(data);
		super.write(data);
	}
}

class Lines implements Component {
	private readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

async function firstRender(rows: number, env: { TMUX?: string }): Promise<string> {
	const saved = process.env.TMUX;
	if (env.TMUX === undefined) delete process.env.TMUX;
	else process.env.TMUX = env.TMUX;
	try {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TuiMainScreen(terminal);
		tui.addChild(new Lines(Array.from({ length: rows }, (_, i) => `\x1b[3${1 + (i % 6)}mhistory ${i}\x1b[0m`)));
		tui.start();
		await terminal.waitForRender();
		const output = terminal.written.join("");
		tui.stop();
		return output;
	} finally {
		if (saved === undefined) delete process.env.TMUX;
		else process.env.TMUX = saved;
	}
}

describe("main-screen full render under tmux", () => {
	let savedTmux: string | undefined;
	beforeEach(() => {
		savedTmux = process.env.TMUX;
	});
	afterEach(() => {
		if (savedTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = savedTmux;
	});

	it("renews synchronized output between rows of a large replay and ends it once, last", async () => {
		const output = await firstRender(5000, { TMUX: "/tmp/tmux-1/default,1,0" });
		const segments = output.split(SYNC_BEGIN);
		assert.ok(segments.length > 5, `expected renewals, got ${segments.length - 1} begins`);
		for (const segment of segments.slice(1)) {
			assert.ok(segment.length < SYNC_RENEW_INTERVAL_CHARS + 200, `segment of ${segment.length} chars`);
		}
		// Every renewal lands on a row boundary, never inside an escape sequence.
		for (const segment of segments.slice(0, -1).slice(1)) {
			assert.ok(segment.endsWith("\r\n"), "renewal must follow a complete row");
		}
		assert.strictEqual(output.split(SYNC_END).length, 2);
		assert.ok(output.lastIndexOf(SYNC_END) > output.lastIndexOf(SYNC_BEGIN));
	});

	it("begins synchronized output once when not inside tmux", async () => {
		const output = await firstRender(5000, {});
		assert.strictEqual(output.split(SYNC_BEGIN).length, 2);
		assert.strictEqual(output.split(SYNC_END).length, 2);
	});

	it("begins synchronized output once for a small render under tmux", async () => {
		const output = await firstRender(10, { TMUX: "/tmp/tmux-1/default,1,0" });
		assert.strictEqual(output.split(SYNC_BEGIN).length, 2);
		assert.strictEqual(output.split(SYNC_END).length, 2);
	});
});
