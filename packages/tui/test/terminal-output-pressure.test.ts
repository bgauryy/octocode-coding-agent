import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

it("keeps health timers running on an undrained POSIX terminal and preserves write order", (t) => {
	if (process.platform === "win32") return t.skip("POSIX PTY regression");
	if (spawnSync("python3", ["--version"]).error) return t.skip("python3 is needed to own a PTY");
	const driver = fileURLToPath(new URL("./helpers/output-pressure.py", import.meta.url));
	const child = fileURLToPath(new URL("./fixtures/output-pressure-child.ts", import.meta.url));
	const result = spawnSync("python3", [driver, process.execPath, child], { encoding: "utf8", timeout: 20000 });
	assert.equal(result.status, 0, result.stderr || String(result.error));
	assert.equal(JSON.parse(result.stdout).ordered_bytes, 1024 * 1024 + 3);
});

it("stays nonblocking after a child that inherited stdout hands the terminal back", (t) => {
	if (process.platform === "win32") return t.skip("POSIX PTY regression");
	if (spawnSync("python3", ["--version"]).error) return t.skip("python3 is needed to own a PTY");
	const driver = fileURLToPath(new URL("./helpers/output-pressure.py", import.meta.url));
	const child = fileURLToPath(new URL("./fixtures/child-handoff-child.ts", import.meta.url));
	const result = spawnSync("python3", [driver, process.execPath, child, "prefixed"], {
		encoding: "utf8",
		timeout: 20000,
	});
	assert.equal(result.status, 0, result.stderr || String(result.error));
	assert.equal(JSON.parse(result.stdout).ordered_bytes, 1024 * 1024 + 3);
});

it("exits within the restore budget when the terminal never reads again", (t) => {
	if (process.platform === "win32") return t.skip("POSIX PTY regression");
	if (spawnSync("python3", ["--version"]).error) return t.skip("python3 is needed to own a PTY");
	const driver = fileURLToPath(new URL("./helpers/exit-pressure.py", import.meta.url));
	const child = fileURLToPath(new URL("./fixtures/exit-pressure-child.ts", import.meta.url));
	const result = spawnSync("python3", [driver, process.execPath, child, "paused"], {
		encoding: "utf8",
		timeout: 20000,
	});
	assert.equal(result.status, 0, result.stderr || String(result.error));
	assert.equal(JSON.parse(result.stdout).exited, true);
});

for (const mode of ["running", "stopped", "drained"])
	it(`restores terminal modes on exit with output queued while ${mode}`, (t) => {
		if (process.platform === "win32") return t.skip("POSIX PTY regression");
		if (spawnSync("python3", ["--version"]).error) return t.skip("python3 is needed to own a PTY");
		const driver = fileURLToPath(new URL("./helpers/exit-pressure.py", import.meta.url));
		const child = fileURLToPath(new URL("./fixtures/exit-pressure-child.ts", import.meta.url));
		const result = spawnSync("python3", [driver, process.execPath, child, mode], { encoding: "utf8", timeout: 20000 });
		assert.equal(result.status, 0, result.stderr || String(result.error));
		assert.equal(JSON.parse(result.stdout).restored, true);
	});
