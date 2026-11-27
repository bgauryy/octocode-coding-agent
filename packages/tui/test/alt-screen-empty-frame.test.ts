import assert from "node:assert/strict";
import { it } from "node:test";
import { encodeKitty } from "../src/terminal-image.ts";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image/capabilities.ts";
import { Text } from "../src/components/text.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class FrameTerminal extends VirtualTerminal {
	readonly frames: string[] = [];
	override write(data: string, kind?: "frame" | "essential"): void {
		if (kind === "frame") this.frames.push(data);
		super.write(data);
	}
	get synchronizedOutput(): boolean {
		return true;
	}
}

it("writes nothing for a frame that changes no row and leaves the cursor where it was", async () => {
	const terminal = new FrameTerminal(30, 4);
	const tui = new TuiAltScreen(terminal);
	const text = new Text("alpha", 0, 0);
	tui.addChild(text);
	tui.start();
	await terminal.waitForRender();
	const painted = terminal.frames.length;
	assert.ok(painted > 0);

	tui.renderNow();
	tui.renderNow();
	assert.equal(terminal.frames.length, painted, "unchanged frames: no synchronized-output wrapper, no cursor bytes");

	text.setText("beta");
	tui.renderNow();
	assert.equal(terminal.frames.length, painted + 1);
	assert.match(terminal.frames.at(-1) ?? "", /beta/);

	// A forced repaint writes the whole screen even when nothing changed.
	tui.renderNow(true);
	assert.equal(terminal.frames.length, painted + 2);
	tui.stop();
});

it("counts painted and written frames: a frame that changes nothing paints but writes none", async () => {
	const terminal = new FrameTerminal(30, 4);
	const tui = new TuiAltScreen(terminal);
	const text = new Text("alpha", 0, 0);
	tui.addChild(text);
	tui.start();
	await terminal.waitForRender();
	const start = { ...tui.renderCounters };
	assert.equal(start.written, terminal.frames.length, "each frame write counts once");

	tui.renderNow();
	const quiet = tui.renderCounters;
	assert.equal(quiet.painted - start.painted, 1);
	assert.equal(quiet.written - start.written, 0, "an unchanged frame writes nothing");

	text.setText("beta");
	tui.renderNow();
	assert.equal(tui.renderCounters.written - start.written, 1);
	tui.stop();
});

it("budgets multiple encoded screenshots before the first frame and a forced recovery", async () => {
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	const terminal = new (class extends FrameTerminal {
		readonly frameOutputCap = 64 * 1024;
	})(50, 8);
	const tui = new TuiAltScreen(terminal);
	const image = encodeKitty("A".repeat(40 * 1024), { columns: 2, rows: 1 });
	tui.addChild({ render: () => [image, image, "Screenshot: browser-2.png"], invalidate() {} });
	try {
		tui.start();
		await terminal.waitForRender();
		tui.renderNow(true);
		assert.ok(terminal.frames.length >= 2);
		for (const frame of terminal.frames) {
			assert.ok(Buffer.byteLength(frame) <= terminal.frameOutputCap);
			assert.match(frame, /browser-2.png/);
			assert.ok(frame.includes("A".repeat(512)), "one of the two uploads still fits");
		}
		const writes = terminal.frames.length;
		tui.renderNow();
		assert.equal(terminal.frames.length, writes);
	} finally {
		tui.stop();
		resetCapabilitiesCache();
	}
});
