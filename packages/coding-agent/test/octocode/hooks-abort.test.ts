import type * as importedModule1 from "node:child_process";
import { spawn } from "node:child_process";
import { beforeEach, expect, it, vi } from "vitest";
import { interpret, runHook } from "../../src/octocode/hooks/runner.ts";
import { tmp } from "./helpers.ts";

vi.mock("node:child_process", async (original) => {
	const module = await original<typeof importedModule1>();
	return { ...module, spawn: vi.fn(module.spawn) };
});

// Each test counts its own spawns, whatever order the file runs in.
beforeEach(() => {
	vi.mocked(spawn).mockClear();
});

it("does not spawn a hook for an already aborted request", async () => {
	// The same hook spawns once when its request is live, so the count below is not zero by construction. Only spawns of
	// the hook's own command count: a live hook also starts the watcher that ends its group with the session.
	const hook = { command: "echo should-not-run", timeoutMs: 1000, source: "test" };
	const hookSpawns = () =>
		vi.mocked(spawn).mock.calls.filter((call) => JSON.stringify(call).includes("should-not-run")).length;
	expect(await runHook(hook, {}, tmp())).toMatchObject({ code: 0, stdout: expect.stringContaining("should-not-run") });
	expect(hookSpawns()).toBe(1);
	vi.mocked(spawn).mockClear();
	const signal = AbortSignal.abort();
	const run = await runHook(hook, {}, tmp(), {}, signal);
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
