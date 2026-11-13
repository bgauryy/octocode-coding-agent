import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { typedAheadInput } from "../src/terminal/typeahead.ts";

describe("input typed before the terminal UI started", () => {
	it("sends lines typed in line mode as one Enter, keeps a line still being typed, and leaves raw line feeds alone", (t) => {
		if (process.platform === "win32") return t.skip("POSIX PTY regression");
		if (spawnSync("python3", ["--version"]).error) return t.skip("python3 is needed to own a PTY");
		const driver = fileURLToPath(new URL("./helpers/typeahead.py", import.meta.url));
		const child = fileURLToPath(new URL("./fixtures/typeahead-child.ts", import.meta.url));
		const result = spawnSync("python3", [driver, process.execPath, child], { encoding: "utf8", timeout: 30000 });
		assert.equal(result.status, 0, result.stderr || String(result.error));
		// Two typed lines: one prompt of two lines and one Enter; then the unfinished line, then a raw Ctrl+J.
		assert.deepEqual(JSON.parse(result.stdout), { inputs: "hello\ntwo\rpartial\n" });
	});

	it("turns the line feeds ending typed lines into one Enter, and drops Enters without text", () => {
		assert.equal(typedAheadInput("hello\n"), "hello\r");
		assert.equal(typedAheadInput("hello\n\n\n"), "hello\r");
		assert.equal(typedAheadInput("a\n\nb\n"), "a\n\nb\r");
		assert.equal(typedAheadInput("\n\n"), "");
		assert.equal(typedAheadInput(""), "");
	});
});
