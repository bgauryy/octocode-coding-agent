import assert from "node:assert";
import { describe, it } from "node:test";
import type { Terminal } from "../src/terminal.ts";
import { ENABLE_ANY_MOTION_MOUSE } from "../src/tui-alt-screen/constants.ts";
import { AltScreenTerminalModes } from "../src/tui-alt-screen/terminal-modes.ts";

function setup() {
	const writes: string[] = [];
	const terminal = { write: (data: string) => writes.push(data) } as unknown as Terminal;
	const modes = new AltScreenTerminalModes({ terminal: () => terminal, isActive: () => true, mouse: true });
	return { modes, writes };
}

describe("hover tracking while a button is down", () => {
	it("defers the mode switch until release", () => {
		const { modes, writes } = setup();
		modes.noteButton(true);
		modes.setHoverTracking(true);
		assert.deepStrictEqual(writes, []);
		modes.noteButton(false);
		assert.deepStrictEqual(writes, [ENABLE_ANY_MOTION_MOUSE]);
		assert.strictEqual(modes.tracksHover, true);
	});

	it("applies only the last request made during the press", () => {
		const { modes, writes } = setup();
		modes.noteButton(true);
		modes.setHoverTracking(true);
		modes.setHoverTracking(false);
		modes.noteButton(false);
		assert.deepStrictEqual(writes, []);
	});

	it("switches at once with no button down", () => {
		const { modes, writes } = setup();
		modes.setHoverTracking(true);
		assert.deepStrictEqual(writes, [ENABLE_ANY_MOTION_MOUSE]);
	});
});
