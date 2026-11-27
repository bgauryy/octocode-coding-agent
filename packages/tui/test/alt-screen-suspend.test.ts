import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingTerminal extends VirtualTerminal {
	written: string[] = [];
	override write(data: string): void {
		this.written.push(data);
		super.write(data);
	}
}

class Transcript implements Component {
	renders = 0;
	render(): string[] {
		this.renders++;
		return Array.from({ length: 2000 }, (_, i) => `transcript row ${i}`);
	}
	invalidate(): void {}
}

describe("alternate screen suspend", () => {
	it("stopping with preserveScreen writes no transcript and renders no extra document, and start enters again", () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new TuiAltScreen(terminal);
		const transcript = new Transcript();
		tui.addChild(transcript);
		tui.start();
		tui.renderNow();
		const rendersBeforeStop = transcript.renders;
		terminal.written.length = 0;

		tui.stop({ preserveScreen: true });
		const stopOutput = terminal.written.join("");
		assert.ok(stopOutput.includes("\x1b[?1049l"));
		assert.ok(!stopOutput.includes("transcript row"), "the transcript was written into the normal screen");
		assert.strictEqual(transcript.renders, rendersBeforeStop);

		terminal.written.length = 0;
		tui.start();
		tui.renderNow();
		assert.ok(terminal.written.join("").includes("\x1b[?1049h"));
		tui.stop({ preserveScreen: true });
	});

	it("a plain stop still prints the transcript for fullscreenExitOutput: transcript", () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Transcript());
		tui.start();
		tui.renderNow();
		terminal.written.length = 0;

		tui.stop();

		assert.ok(terminal.written.join("").includes("transcript row 1999"));
	});
});
