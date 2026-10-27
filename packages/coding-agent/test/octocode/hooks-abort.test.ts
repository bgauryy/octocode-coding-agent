import type * as importedModule1 from "node:child_process";
import { spawn } from "node:child_process";
import { expect, it, vi } from "vitest";
import { interpret, runHook } from "../../src/octocode/hooks/runner.ts";
import { tmp } from "./helpers.ts";

vi.mock("node:child_process", async (original) => {
	const module = await original<typeof importedModule1>();
	return { ...module, spawn: vi.fn(module.spawn) };
});

it("does not spawn a hook for an already aborted request", async () => {
	const signal = AbortSignal.abort();
	const run = await runHook({ command: "echo should-not-run", timeoutMs: 1000, source: "test" }, {}, tmp(), {}, signal);
	expect(vi.mocked(spawn).mock.calls.length).toBe(0);
	expect(interpret("PreToolUse", run)).toEqual({});
	expect(run).toMatchObject({ code: null, stdout: "", timedOut: false });
});

it("lets a hook's deny stand when a background child keeps its output pipes open", async () => {
	const started = Date.now();
	const run = await runHook(
		{ command: "sleep 20 & echo denied-by-policy >&2; exit 2", timeoutMs: 15_000, source: "test" },
		{},
		tmp(),
	);
	expect(Date.now() - started).toBeLessThan(5000);
	expect(run).toMatchObject({ code: 2, stderr: expect.stringContaining("denied-by-policy"), timedOut: false });
	expect(interpret("PreToolUse", run)).toEqual({ block: "denied-by-policy" });
});

it("still reports a timeout for a hook that does not exit", async () => {
	const run = await runHook({ command: "sleep 20", timeoutMs: 300, source: "test" }, {}, tmp());
	expect(run.timedOut).toBe(true);
	expect(interpret("PreToolUse", run)).toEqual({});
});
