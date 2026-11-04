import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CHILD = fileURLToPath(new URL("./fixtures/exit-restore-child.ts", import.meta.url));

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";

function run(how: string): { output: string; status: number | null } {
	const result = spawnSync(process.execPath, [CHILD, how], { encoding: "utf8", timeout: 15000 });
	return { output: result.stdout, status: result.status };
}

function count(text: string, part: string): number {
	return text.split(part).length - 1;
}

/** Everything the process left on: an unrestored terminal keeps the alternate screen, mouse, key and paste modes. */
function assertRestored(output: string): void {
	assert.strictEqual(count(output, ENTER_ALT_SCREEN), 1, "entered the alternate screen once");
	assert.ok(output.lastIndexOf(EXIT_ALT_SCREEN) > output.lastIndexOf(ENTER_ALT_SCREEN), "left the alternate screen");
	assert.ok(output.includes("\x1b[?1006l"), "mouse reporting off");
	assert.ok(output.includes("\x1b[?2004l"), "bracketed paste off");
	assert.ok(output.includes("\x1b[<u"), "Kitty keyboard flags popped");
	assert.ok(output.lastIndexOf("\x1b[?25h") > output.lastIndexOf(ENTER_ALT_SCREEN), "cursor shown");
	assert.ok(output.lastIndexOf("\x1b[?7h") > output.lastIndexOf("\x1b[?7l"), "autowrap back on");
	// The Kitty flags go before the alternate screen is left: each screen has its own flag stack.
	assert.ok(output.lastIndexOf("\x1b[<u") < output.lastIndexOf(EXIT_ALT_SCREEN), "flags popped before leaving");
}

describe("terminal restore on process exit", () => {
	it("restores the terminal when the process calls process.exit() without stopping the UI", () => {
		const { output, status } = run("exit");
		assert.strictEqual(status, 0);
		assertRestored(output);
	});

	it("restores the terminal when an uncaught exception ends the process", () => {
		const { output, status } = run("throw");
		assert.notStrictEqual(status, 0);
		assertRestored(output);
	});

	it("writes the restore once: stopping the UI removes the exit hook", () => {
		const { output, status } = run("stop-then-exit");
		assert.strictEqual(status, 0);
		assert.strictEqual(count(output, EXIT_ALT_SCREEN), 1);
		assert.strictEqual(count(output, "\x1b[?2004l"), 1);
	});
});
