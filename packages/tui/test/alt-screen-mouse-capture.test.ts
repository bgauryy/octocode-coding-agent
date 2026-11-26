import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { DISABLE_MOUSE, ENABLE_MOUSE } from "../src/tui-alt-screen/constants.ts";
import {
	mouseCaptureMessage,
	nativeSelectionModifier,
	terminalSelectionHint,
} from "../src/tui-alt-screen/mouse-capture.ts";
import { formatKeyText } from "../src/keys/display.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

const ALT_M = "\x1bm";

function screen(options: ConstructorParameters<typeof TuiAltScreen>[3] = {}) {
	const terminal = new RecordingTerminal(60, 6);
	const flashes: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, options);
	const flash = tui.flash.bind(tui);
	tui.flash = (message, durationMs) => {
		flashes.push(message);
		flash(message, durationMs);
	};
	return { terminal, tui, flashes };
}

describe("fullscreen mouse capture", () => {
	it("hands the mouse to the terminal and takes it back with the toggle key", async () => {
		const { terminal, tui, flashes } = screen();
		tui.addChild(new Text("alpha\nbeta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		terminal.writes.length = 0;

		terminal.sendInput(ALT_M);
		await terminal.waitForRender();
		assert.ok(terminal.writes.includes(DISABLE_MOUSE), JSON.stringify(terminal.writes));
		assert.equal(flashes.at(-1), mouseCaptureMessage(false));
		assert.ok(flashes.at(-1)?.includes(`${formatKeyText("alt+m")} turns it back on`));

		// A focus-in writes the screen's modes again: a released mouse stays released.
		terminal.writes.length = 0;
		terminal.sendInput("\x1b[I");
		await terminal.waitForRender();
		assert.ok(!terminal.writes.some((data) => data.includes("\x1b[?1000h")), JSON.stringify(terminal.writes));

		terminal.sendInput(ALT_M);
		await terminal.waitForRender();
		assert.ok(terminal.writes.includes(ENABLE_MOUSE), JSON.stringify(terminal.writes));
		assert.match(flashes.at(-1) ?? "", /^Mouse on/);
		tui.stop();
	});

	it("has nothing to toggle on a screen without mouse tracking", async () => {
		const { terminal, tui, flashes } = screen({ mouse: false });
		tui.addChild(new Text("alpha", 0, 0));
		tui.start();
		await terminal.waitForRender();
		terminal.writes.length = 0;
		tui.setMouseCapture(false);
		assert.deepEqual(terminal.writes, []);
		assert.deepEqual(flashes, []);
		tui.stop();
	});

	it("says how much was copied, and names the terminal's own selection on the first copy only", async () => {
		const copied: string[] = [];
		const { terminal, tui, flashes } = screen({
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Text("alpha\nbeta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		for (let copy = 0; copy < 2; copy++) {
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;4;2M");
			terminal.sendInput("\x1b[<0;4;2m");
			await terminal.waitForRender();
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		assert.deepEqual(copied, ["alpha\nbeta", "alpha\nbeta"]);
		assert.deepEqual(flashes, [
			"Copied 2 lines · 10 chars",
			terminalSelectionHint(),
			"Copied 2 lines · 10 chars",
		]);
		tui.stop();
	});
});

describe("the terminal-selection modifier", () => {
	it("is Shift in most terminals, Option in iTerm2 and VS Code on macOS, Fn in Terminal.app", () => {
		assert.equal(nativeSelectionModifier({ TERM_PROGRAM: "ghostty" }, "darwin"), "shift");
		assert.equal(nativeSelectionModifier({}, "darwin"), "shift");
		assert.equal(nativeSelectionModifier({ TERM_PROGRAM: "iTerm.app" }, "darwin"), "option");
		assert.equal(nativeSelectionModifier({ TERM_PROGRAM: "vscode" }, "darwin"), "option");
		assert.equal(nativeSelectionModifier({ TERM_PROGRAM: "Apple_Terminal" }, "darwin"), "fn");
		assert.equal(nativeSelectionModifier({ TERM_PROGRAM: "vscode" }, "linux"), "shift");
		const vscodeMac = terminalSelectionHint({ TERM_PROGRAM: "vscode" }, "darwin");
		assert.match(vscodeMac, /macOptionClickForcesSelection/);
		assert.ok(vscodeMac.startsWith(formatKeyText("alt+m")));
		assert.doesNotMatch(terminalSelectionHint({ TERM_PROGRAM: "iTerm.app" }, "darwin"), /macOption/);
		assert.doesNotMatch(terminalSelectionHint({ TERM_PROGRAM: "vscode" }, "linux"), /macOption/);
		assert.equal(nativeSelectionModifier({ TERM_PROGRAM: "tmux" }, "darwin"), "shift");
		assert.match(
			mouseCaptureMessage(true, { TERM_PROGRAM: "vscode" }, "darwin"),
			/option\+drag \(needs macOptionClickForcesSelection\)/,
		);
		assert.doesNotMatch(mouseCaptureMessage(true, { TERM_PROGRAM: "iTerm.app" }, "darwin"), /macOption/);
	});
});

describe("mouse key names", () => {
	it("write the toggle key by the one display rule: option for alt on macOS, alt elsewhere", () => {
		assert.equal(formatKeyText("alt+m", "darwin"), "option+m");
		assert.equal(formatKeyText("alt+m", "linux"), "alt+m");
		assert.equal(formatKeyText("Escape/ctrl+c", "win32"), "esc/ctrl+c");
		assert.equal(
			mouseCaptureMessage(false),
			`Mouse off: select, copy and scroll with your terminal · ${formatKeyText("alt+m")} turns it back on`,
		);
	});
});

describe("jump-to-latest label", () => {
	it("counts output that arrives below while the reader is scrolled up, and resets at the end", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const calls: Array<{ rowsBelow: number; newRows: number }> = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			scrollToEndIndicator: (rowsBelow, _percent, newRows) => {
				calls.push({ rowsBelow, newRows });
				return newRows > 0 ? ` ↓ new output ` : " ↓ latest ";
			},
		});
		const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
		const body = new Text(lines.join("\n"), 0, 0);
		const transcript = new ScrollView(body, { follow: "end", primary: true });
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: new Text("editor", 0, 0), basis: "auto", minSize: 1 },
			]),
		);
		tui.start();
		await terminal.waitForRender();
		tui.scrollBy(-5);
		await terminal.waitForRender();
		assert.deepEqual(calls.at(-1), { rowsBelow: 5, newRows: 0 });

		lines.push("line 21", "line 22", "line 23");
		body.setText(lines.join("\n"));
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepEqual(calls.at(-1), { rowsBelow: 8, newRows: 3 });
		assert.ok(terminal.getViewport().some((line) => line.includes("new output")));

		// Reading further down passes some of the new rows; the count never exceeds the rows still below.
		tui.scrollBy(6);
		await terminal.waitForRender();
		assert.deepEqual(calls.at(-1), { rowsBelow: 2, newRows: 2 });

		tui.scrollToBottom();
		await terminal.waitForRender();
		tui.scrollBy(-1);
		await terminal.waitForRender();
		assert.deepEqual(calls.at(-1), { rowsBelow: 1, newRows: 0 });
		tui.stop();
	});
});
