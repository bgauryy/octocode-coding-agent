import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import type { OutputKind } from "../src/terminal.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** A terminal that stops reading: frames written meanwhile are dropped, as the output queue drops them past its cap. */
class StallingTerminal extends VirtualTerminal {
	stalled = false;
	dropped = 0;
	readonly essentials: string[] = [];
	private recover: (() => void) | undefined;

	setOutputRecovery(recover: (() => void) | undefined): void {
		this.recover = recover;
	}

	override write(data: string, kind: OutputKind = "essential"): void {
		if (this.stalled && kind === "frame") {
			this.dropped++;
			return;
		}
		if (kind === "essential") this.essentials.push(data);
		super.write(data);
	}

	/** The terminal reads again: everything queued arrived, and a drop asks for a repaint. */
	resume(): void {
		this.stalled = false;
		if (this.dropped > 0) this.recover?.();
	}
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const visible = async (terminal: VirtualTerminal) => (await terminal.flushAndGetViewport()).map((row) => row.trimEnd());

describe("fullscreen output recovery", () => {
	it("repaints the screen whole after frames were dropped, matching a fresh render", async () => {
		const terminal = new StallingTerminal(40, 8);
		const tui = new TuiAltScreen(terminal);
		const text = new Text(Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n"), 0, 0);
		tui.addChild(text);
		tui.start();
		await terminal.waitForRender();

		terminal.stalled = true;
		for (let event = 0; event < 6; event++) {
			terminal.sendInput("\x1b[<64;1;1M");
			await wait(20);
		}
		text.setText(Array.from({ length: 60 }, (_, index) => `row ${index}`).join("\n"));
		tui.requestRender();
		await wait(60);
		assert.ok(terminal.dropped > 0, "frames were dropped while stalled");

		const essentialsBefore = terminal.essentials.length;
		terminal.resume();
		await wait(60);
		// The recovery reasserts the frame's modes (autowrap off, mouse) before it repaints.
		assert.ok(terminal.essentials.slice(essentialsBefore).some((write) => write.includes("\x1b[?7l")));

		const fresh = new VirtualTerminal(40, 8);
		const reference = new TuiAltScreen(fresh);
		const copy = new Text(Array.from({ length: 60 }, (_, index) => `row ${index}`).join("\n"), 0, 0);
		reference.addChild(copy);
		reference.start();
		await fresh.waitForRender();
		reference.scrollBy(-6);
		await wait(40);
		assert.deepStrictEqual(await visible(terminal), await visible(fresh));
		tui.stop();
		reference.stop();
	});
});
