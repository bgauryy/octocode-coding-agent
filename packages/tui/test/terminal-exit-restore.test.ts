import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fsModule from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { TerminalOutput } from "../src/terminal/output.ts";

const CHILD = fileURLToPath(new URL("./fixtures/exit-restore-child.ts", import.meta.url));

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const PUSH_TITLE = "\x1b[22;0t";
const POP_TITLE = "\x1b[23;0t";

function run(how: string, env: NodeJS.ProcessEnv = {}): { output: string; status: number | null } {
	const result = spawnSync(process.execPath, [CHILD, how], {
		encoding: "utf8",
		timeout: 15000,
		env: { ...process.env, ...env },
	});
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
	assert.strictEqual(count(output, PUSH_TITLE), 1, "the shell's window title saved once");
	assert.ok(output.lastIndexOf(POP_TITLE) > output.lastIndexOf(PUSH_TITLE), "and restored");
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

	it("never throws from the exit event: a hung-up terminal's failed write still runs the other hooks and later listeners", () => {
		const { output, status } = run("dead-terminal");
		assert.strictEqual(status, 0);
		assertRestored(output);
		assert.ok(output.includes("later exit listener ran"), "the exit listeners after the restore still ran");
	});

	it("drops the restore bytes a hung-up terminal refuses instead of throwing", () => {
		const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		const writeSync = fsModule.writeSync;
		let tries = 0;
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		fsModule.writeSync = () => {
			tries++;
			throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
		};
		syncBuiltinESMExports();
		try {
			assert.doesNotThrow(() => new TerminalOutput().writeOnExit("\x1b[?1049l"));
			assert.strictEqual(tries, 1, "one refused write, no retry");
		} finally {
			fsModule.writeSync = writeSync;
			syncBuiltinESMExports();
			if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
			else Reflect.deleteProperty(process.stdout, "isTTY");
		}
	});

	it("writes the restore once: stopping the UI removes the exit hook", () => {
		const { output, status } = run("stop-then-exit");
		assert.strictEqual(status, 0);
		assert.strictEqual(count(output, EXIT_ALT_SCREEN), 1);
		assert.strictEqual(count(output, "\x1b[?2004l"), 1);
		assert.strictEqual(count(output, POP_TITLE), 1, "the title is restored once, by stop()");
	});

	it("drops a title written after stop(): the title is the shell's again", () => {
		const { output, status } = run("title-after-stop");
		assert.strictEqual(status, 0);
		assert.ok(output.includes("\x1b]0;before stop\x07"));
		assert.ok(!output.includes("late title"), "no title write after the terminal stopped");
		assert.ok(output.lastIndexOf(POP_TITLE) > output.lastIndexOf("before stop"));
	});

	it("clears a reported program status before the key and paste resets when the process exits without stop()", () => {
		const clear = "\x1b]7501;state=clear\x1b\\";
		const supported = run("status-exit", { OCTOCODE_PROGRAM_STATUS: "1" });
		assert.strictEqual(supported.status, 0);
		assert.ok(supported.output.includes("\x1b]7501;state=working"), "the status was reported");
		assert.strictEqual(count(supported.output, clear), 1, "and cleared once");
		assert.ok(supported.output.lastIndexOf(clear) < supported.output.lastIndexOf("\x1b[<u"), "before the key reset");
		assert.ok(
			supported.output.lastIndexOf(clear) < supported.output.lastIndexOf("\x1b[?2004l"),
			"before the paste reset",
		);
		assertRestored(supported.output);

		const unsupported = run("status-exit", { OCTOCODE_PROGRAM_STATUS: "0" });
		assert.strictEqual(unsupported.status, 0);
		assert.ok(!unsupported.output.includes("\x1b]7501;"), "a terminal without support gets no status bytes");
	});
});
