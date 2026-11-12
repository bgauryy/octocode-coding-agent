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

it("drops frames past the cap on an undrained PTY, keeps every essential write and repaints after the drain", (t) => {
	if (process.platform === "win32") return t.skip("POSIX PTY regression");
	if (spawnSync("python3", ["--version"]).error) return t.skip("python3 is needed to own a PTY");
	const driver = fileURLToPath(new URL("./helpers/frame-cap.py", import.meta.url));
	const child = fileURLToPath(new URL("./fixtures/frame-cap-child.ts", import.meta.url));
	const result = spawnSync("python3", [driver, process.execPath, child], { encoding: "utf8", timeout: 30000 });
	assert.equal(result.status, 0, result.stderr || String(result.error));
	const report = JSON.parse(result.stdout);
	assert.equal(report.exit, 0, report.stderr);
	// A 50 ms timer kept ticking for the 2.5 s the terminal read nothing.
	assert.ok(report.ticks_unread >= 30, `${report.ticks_unread} ticks`);
	// The queue never passed the cap by more than one essential write.
	assert.ok(report.max <= report.cap + "<END>".length, `queue peaked at ${report.max} bytes`);
	assert.ok(report.dropped > 0, "frames were dropped");
	// Mode, restore and status bytes are never dropped, and keep their order.
	assert.deepEqual(
		report.markers,
		Array.from({ length: report.essentials }, (_, index) => index + 1),
	);
	assert.ok(report.recovered && report.repaint_after_end, "one whole repaint after the drain");
});
