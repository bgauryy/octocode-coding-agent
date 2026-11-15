import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as hookRunner from "../../src/octocode/hooks/runner.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { parseHooks } from "../../src/octocode/hooks/config/parse.ts";
import { commandsFor } from "../../src/octocode/hooks/config/calls.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { HOOK_SETTINGS, tmp } from "./helpers.ts";
import { approveFixtureHooks } from "./guard-helpers.ts";
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

async function fixture() {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	fs.mkdirSync(path.join(home, ".claude"));
	const started = path.join(home, "started");
	const release = path.join(home, "release");
	const script = path.join(home, "async.cjs");
	fs.writeFileSync(
		script,
		`const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},String(process.pid));const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(release)}))return;clearInterval(timer);console.log('log before JSON');console.log(JSON.stringify({decision:'block',reason:'ignored',continue:false,systemMessage:'background message',hookSpecificOutput:{hookEventName:'PreToolUse',additionalContext:'background context'}}));},5);`,
	);
	fs.writeFileSync(
		path.join(home, ".claude/settings.json"),
		JSON.stringify({
			hooks: {
				PreToolUse: [
					{
						hooks: [
							{
								type: "command",
								command: process.execPath,
								args: [script],
								async: true,
								onFailure: "block",
								timeout: 0.01,
							},
						],
					},
				],
			},
		}),
	);
	const fake = fakeHost(HOOK_SETTINGS);
	const hooks = registerHooks(fake.api, { env: {}, home });
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	approveFixtureHooks(ctx.cwd, home);
	await fake.fire("session_start", { reason: "startup" }, ctx);
	return { ...fake, hooks, ctx, started, release, script };
}
it("runs Claude async gates without blocking and delivers only context once on the next prompt", async () => {
	const f = await fixture();
	try {
		const result = await Promise.race([
			f.hooks.preToolUse(
				{
					toolName: "bash",
					toolCallId: "async",
					input: { command: "true" },
				} as never,
				f.ctx,
			),
			new Promise((_, reject) => setTimeout(() => reject(new Error("async hook blocked the tool")), 500)),
		]);
		expect(result).toBeUndefined();
		await vi.waitFor(() => expect(fs.existsSync(f.started)).toBe(true));
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(f.sent).toEqual([]);
		fs.writeFileSync(f.release, "ready");
		await vi.waitFor(async () => {
			const result = JSON.stringify(await f.emit("before_agent_start", {}, f.ctx));
			expect(result).toContain("background context");
			expect(result).toContain("background message");
			expect(result).not.toContain("ignored");
		});
		expect(JSON.stringify(await f.emit("before_agent_start", {}, f.ctx))).not.toContain("background context");
		expect(f.sent).toEqual([]);
	} finally {
		await f.fire("session_shutdown", {}, f.ctx);
	}
});
it("cancels async processes on shutdown and drops results from the previous session", async () => {
	const f = await fixture();
	await f.hooks.preToolUse(
		{
			toolName: "bash",
			toolCallId: "cancel",
			input: { command: "true" },
		} as never,
		f.ctx,
	);
	try {
		await vi.waitFor(() => expect(fs.existsSync(f.started)).toBe(true));
	} finally {
		await f.fire("session_shutdown", {}, f.ctx);
	}
	const pid = Number(fs.readFileSync(f.started, "utf8"));
	if (process.platform !== "win32") expect(() => process.kill(pid, 0)).toThrow();
	fs.writeFileSync(f.release, "late");
	approveFixtureHooks(f.ctx.cwd, path.dirname(f.script));
	await f.fire("session_start", { reason: "new" }, f.ctx);
	expect(JSON.stringify(await f.emit("before_agent_start", {}, f.ctx))).not.toContain("background context");
	await f.fire("session_shutdown", {}, f.ctx);
});
it("keeps upstream async distinct from synchronous invocation identity and disabled for native hooks", () => {
	const value = {
		hooks: {
			PreToolUse: [
				{
					hooks: [false, true].map((async) => ({
						type: "command",
						command: "true",
						async,
					})),
				},
			],
		},
	};
	for (const protocol of ["claude", "codex"] as const) {
		expect(
			commandsFor(parseHooks(value, "fixture", undefined, [], undefined, protocol), "PreToolUse", []),
		).toHaveLength(2);
	}
	expect(commandsFor(parseHooks(value, "fixture", undefined, [], undefined, "octocode"), "PreToolUse", [])).toEqual([]);
});

it("does not start a background process for an already-cancelled invocation", async () => {
	const f = await fixture();
	const abort = new AbortController();
	abort.abort();
	const run = vi.spyOn(hookRunner, "runHook");
	try {
		await f.hooks.preToolUse(
			{
				toolName: "bash",
				toolCallId: "cancelled",
				input: { command: "true" },
			} as never,
			{ ...f.ctx, signal: abort.signal },
		);
		expect(run).not.toHaveBeenCalled();
	} finally {
		await f.fire("session_shutdown", {}, f.ctx);
	}
});

it("delivers ready background context at a naturally continuing tool boundary without requesting continuation", async () => {
	const f = await fixture();
	fs.writeFileSync(
		f.script,
		'console.log(JSON.stringify({systemMessage:"ready for next request",hookSpecificOutput:{additionalContext:42}}));',
	);
	try {
		await f.hooks.preToolUse(
			{
				toolName: "bash",
				toolCallId: "boundary",
				input: { command: "true" },
			} as never,
			f.ctx,
		);
		await vi.waitFor(async () => {
			const results = await f.emit(
				"turn_end",
				{
					entries: [],
					message: { role: "assistant", stopReason: "toolUse", content: [] },
					toolResults: [{ toolCallId: "boundary", content: [] }],
				},
				f.ctx,
			);
			expect(JSON.stringify(results)).toContain("ready for next request");
			expect(JSON.stringify(results)).not.toContain('"continue":true');
			expect(JSON.stringify(results)).not.toContain("42");
		});
		expect(JSON.stringify(await f.emit("before_agent_start", {}, f.ctx))).not.toContain("ready for next request");
		expect(f.sent).toEqual([]);
	} finally {
		await f.fire("session_shutdown", {}, f.ctx);
	}
});

it("keeps notification observers independent of the foreground but cancels them on session shutdown", async () => {
	const f = await fixture();
	const settings = path.join(path.dirname(f.script), ".claude/settings.json");
	fs.writeFileSync(
		settings,
		JSON.stringify({
			hooks: {
				Notification: [{ hooks: [{ type: "command", command: "fixture" }] }],
			},
		}),
	);
	approveFixtureHooks(f.ctx.cwd, path.dirname(f.script));
	await f.fire("session_start", { reason: "new" }, f.ctx);
	let received!: AbortSignal;
	vi.spyOn(hookRunner, "runHook").mockImplementation(
		(_hook, _input, _cwd, _env, signal) =>
			new Promise((resolve) => {
				received = signal!;
				signal!.addEventListener("abort", () => resolve({ code: null, stdout: "", stderr: "", timedOut: false }), {
					once: true,
				});
			}),
	);
	f.hooks.notification({ type: "permission_prompt", message: "Review" }, { ...f.ctx, signal: AbortSignal.abort() });
	expect(received.aborted).toBe(false);
	await f.fire("session_shutdown", {}, f.ctx);
	expect(received.aborted).toBe(true);
});

it.each(["stderr", "stdout", "empty"])("wakes the session on asyncRewake exit 2 using %s", async (stream) => {
	const f = await fixture();
	fs.writeFileSync(
		path.join(path.dirname(f.script), ".claude/settings.json"),
		JSON.stringify({
			hooks: {
				PreToolUse: [
					{
						hooks: [
							{
								type: "command",
								command: process.execPath,
								args: [f.script],
								asyncRewake: true,
							},
						],
					},
				],
			},
		}),
	);
	fs.writeFileSync(
		f.script,
		stream === "empty"
			? "process.exitCode=2;"
			: `process.${stream}.write('background check failed');process.exitCode=2;`,
	);
	approveFixtureHooks(f.ctx.cwd, path.dirname(f.script));
	await f.fire("session_start", { reason: "new" }, f.ctx);
	try {
		expect(
			await f.hooks.preToolUse(
				{
					toolName: "bash",
					toolCallId: "rewake",
					input: { command: "true" },
				} as never,
				f.ctx,
			),
		).toBeUndefined();
		await vi.waitFor(
			() =>
				expect(JSON.stringify(f.sent)).toContain(
					stream === "empty" ? "Background hook feedback" : "background check failed",
				),
			{ timeout: 1000 },
		);
		expect(f.sent).toHaveLength(1);
		expect(JSON.stringify(f.sent)).toContain('"triggerTurn":true');
	} finally {
		await f.fire("session_shutdown", {}, f.ctx);
	}
});

it("enforces the timeout for asyncRewake even when async is also true", async () => {
	const config = parseHooks(
		{
			hooks: {
				PreToolUse: [
					{
						hooks: [
							{
								type: "command",
								command: process.execPath,
								args: ["-e", "setInterval(()=>{},1000)"],
								async: true,
								asyncRewake: true,
								timeout: 0.01,
							},
						],
					},
				],
			},
		},
		"fixture",
		undefined,
		[],
		undefined,
		"claude",
	);
	const selected = commandsFor(config, "PreToolUse", ["Bash"])[0];
	expect(selected).toBeDefined();
	const result = await hookRunner.runHook(selected, {}, tmp());
	expect(result.timedOut).toBe(true);
});

it("retains completed context when the next prompt has already been cancelled", async () => {
	const f = await fixture();
	vi.spyOn(hookRunner, "runHook").mockResolvedValue({
		code: 0,
		stdout: '{"systemMessage":"keep this context"}',
		stderr: "",
		timedOut: false,
	});
	try {
		await f.hooks.preToolUse(
			{
				toolName: "bash",
				toolCallId: "retain",
				input: { command: "true" },
			} as never,
			f.ctx,
		);
		expect(
			JSON.stringify(await f.emit("before_agent_start", {}, { ...f.ctx, signal: AbortSignal.abort() })),
		).not.toContain("keep this context");
		expect(JSON.stringify(await f.emit("before_agent_start", {}, f.ctx))).toContain("keep this context");
	} finally {
		await f.fire("session_shutdown", {}, f.ctx);
	}
});
