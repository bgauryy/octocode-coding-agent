import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	configuredTimeout,
	countElapsedBounds,
	countFile,
	countShortPolls,
	countSleeps,
	regressions,
	shrunk,
} from "./test-trust.mjs";

test("counts only awaited sleeps of 100 ms or more", () => {
	const text = [
		"await new Promise((r) => setTimeout(r, 500));",
		"await new Promise((resolve) => setTimeout(resolve, 99));",
		"await sleep(200);",
		"await delay(50);",
		"const p = new Promise((r) => setTimeout(r, 1000));",
	].join("\n");
	assert.equal(countSleeps(text), 2);
	assert.equal(countSleeps('import { setTimeout } from "node:timers/promises";\nawait setTimeout(300);'), 1);
});

test("counts elapsed-time upper bounds, direct and through a variable", () => {
	const text = [
		"const t0 = Date.now();",
		"const elapsed = Date.now() - t0;",
		"expect(elapsed).toBeLessThan(50);",
		"expect(performance.now() - t0).toBeLessThanOrEqual(10);",
		"expect(items.length).toBeLessThan(3);",
	].join("\n");
	assert.equal(countElapsedBounds(text), 2);
});

test("counts polls whose literal timeout is below the suite default", () => {
	const text = [
		"await vi.waitFor(() => ok(), { timeout: 200 });",
		"await expect.poll(() => n, {\n timeout: 20_000,\n}).toBe(1);",
		"await expect.poll(() => n, { timeout: 1000 }).toBe(1);",
		"await expect.poll(() => n).toBe(1);",
	].join("\n");
	assert.equal(countShortPolls(text, 5000), 2);
	assert.equal(configuredTimeout(["export default { test: { testTimeout: 30000 } }"]), 30000);
	assert.equal(configuredTimeout([]), 5000);
	assert.equal(countFile("await sleep(100);", 5000), 1);
});

test("a rise or a new file fails; a drop passes and --update keeps only shrinking counts", () => {
	const baseline = { "a.test.ts": 2, "b.test.ts": 1 };
	assert.deepEqual(regressions({ "a.test.ts": 3, "b.test.ts": 1 }, baseline), ["a.test.ts: 3 (baseline 2)"]);
	assert.deepEqual(regressions({ "c.test.ts": 1 }, baseline), ["c.test.ts: 1 (baseline 0)"]);
	assert.deepEqual(regressions({ "a.test.ts": 1 }, baseline), []);
	assert.deepEqual(shrunk({ "a.test.ts": 1 }, baseline), { "a.test.ts": 1 });
	assert.deepEqual(shrunk({ "a.test.ts": 5, "c.test.ts": 1 }, baseline), {});
});

test("counts multi-line sleep promises", () => {
	const text =
		"await new Promise((r) => {\n\tsetTimeout(r, 500);\n});\nawait new Promise<void>((r) => {\n\tsetTimeout(r, 20);\n});";
	assert.equal(countSleeps(text), 1);
});

test("counts elapsed bounds through derived variables", () => {
	const a =
		"const start = performance.now();\nconst elapsed = performance.now() - start;\nexpect(elapsed).toBeLessThan(50);";
	const b =
		"const start = Date.now();\nrun();\nconst end = Date.now();\nconst elapsed = end - start;\nexpect(elapsed).toBeLessThanOrEqual(9);\nexpect(end - start).toBeLessThan(9);";
	assert.equal(countElapsedBounds(a), 1);
	assert.equal(countElapsedBounds(b), 2);
});

const script = fileURLToPath(new URL("./test-trust.mjs", import.meta.url));
test("the script refuses --update without a baseline and --init over one", () => {
	const dir = mkdtempSync(join(tmpdir(), "test-trust-"));
	const baselineFile = join(dir, "baseline.json");
	const run = (flag) =>
		spawnSync(process.execPath, [script, flag], { env: { ...process.env, TEST_TRUST_BASELINE: baselineFile } }).status;
	try {
		assert.equal(run("--update"), 1);
		assert.equal(existsSync(baselineFile), false);
		assert.equal(run("--init"), 0);
		assert.equal(run("--init"), 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
