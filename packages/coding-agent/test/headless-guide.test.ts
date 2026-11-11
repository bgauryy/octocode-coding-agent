import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runExample(task: string, fail = false) {
	const root = mkdtempSync(join(tmpdir(), "octocode-headless-guide-"));
	roots.push(root);
	const guide = readFileSync(new URL("../docs/external-agents.md", import.meta.url), "utf8");
	const example = guide.match(/```javascript\n([\s\S]*?)\n```/)?.[1];
	if (!example) throw new Error("External-agent guide is missing its JavaScript example");
	const script = join(root, "delegate.mjs");
	const preload = join(root, "child-process.cjs");
	writeFileSync(script, example);
	// Only the external process boundary is mocked; execute the published example unchanged.
	writeFileSync(
		preload,
		`const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
childProcess.execFileSync = (command, args, options) => {
  assert.equal(command, "octocode");
  assert.deepEqual(args, ["-p", "--no-session", "--permission-mode", "workspace", "--model", "test/model"]);
  assert.equal(options.cwd, ${JSON.stringify(root)});
  assert.equal(options.input, ${JSON.stringify(task)});
  assert.equal(options.encoding, "utf8");
  assert.deepEqual(options.stdio, ["pipe", "pipe", "inherit"]);
  assert.equal(options.timeout, 120_000);
  assert.equal(options.maxBuffer, 8 * 1024 * 1024);
  assert.notEqual(options.shell, true);
  if (${fail}) throw new Error("worker failed");
  return "verified answer\\n";
};
require("node:module").syncBuiltinESMExports();
`,
	);
	return spawnSync(process.execPath, ["--require", preload, script, root, "test/model", task], {
		encoding: "utf8",
		timeout: 10_000,
	});
}

describe("external-agent guide subprocess example", () => {
	it("passes untrusted task text as stdin, preserves output and bounds the worker", () => {
		const result = runExample("@not-a-file --dangerously-skip-permissions $(echo injected)\nsecond line");
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("verified answer\n");
		expect(result.stderr).toBe("");
	});

	it("reports subprocess failures without returning a success-shaped answer", () => {
		const result = runExample("Investigate the failure without editing files", true);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("worker failed");
	});
});
