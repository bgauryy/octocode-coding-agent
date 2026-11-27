import assert from "node:assert";
import { describe, it } from "node:test";
import { isNativeModifierPressed } from "../src/native-modifiers.ts";
import { normalizeNativeShiftEnterInput, ProcessTerminal } from "../src/terminal.ts";

// This file runs in its own process, so the native helper is cold until the terminal starts.
describe("native Shift check on Terminal.app", () => {
	it("is loaded while the terminal starts, so the first Enter does not pay for it", async () => {
		const previousProgram = process.env.TERM_PROGRAM;
		const previousWrite = process.stdout.write;
		process.env.TERM_PROGRAM = "Apple_Terminal";
		process.stdout.write = () => true;
		const terminal = new ProcessTerminal();
		try {
			terminal.start(
				() => {},
				() => {},
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
			const start = performance.now();
			isNativeModifierPressed("shift");
			const firstEnterMs = performance.now() - start;
			// Cold, the first query loads the module and the event source: about 30 ms on macOS.
			assert.ok(firstEnterMs < 5, `first Shift check after start took ${firstEnterMs.toFixed(1)} ms`);
		} finally {
			terminal.stop();
			process.stdout.write = previousWrite;
			if (previousProgram === undefined) delete process.env.TERM_PROGRAM;
			else process.env.TERM_PROGRAM = previousProgram;
		}
	});

	it("still decides Shift+Enter from the Return key and the Shift state alone", () => {
		assert.strictEqual(normalizeNativeShiftEnterInput("\r", true, true), "\x1b[13;2u");
		assert.strictEqual(normalizeNativeShiftEnterInput("\r", true, false), "\r");
		assert.strictEqual(normalizeNativeShiftEnterInput("\n", true, true), "\n");
	});
});
