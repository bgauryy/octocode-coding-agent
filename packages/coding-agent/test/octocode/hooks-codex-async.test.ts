import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as runner from "../../src/octocode/hooks/runner.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { commandsFor, parseHooks } from "../../src/octocode/hooks/config.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
async function fixture(count = 1, event = "PreToolUse") {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	fs.mkdirSync(path.join(home, ".codex"));
	fs.writeFileSync(
		path.join(home, ".codex/hooks.json"),
		JSON.stringify({
			hooks: {
				[event]: [
					{
						hooks: Array.from({ length: count }, (_, index) => ({
							type: "command",
							command: `fixture-${index}`,
							async: true,
						})),
					},
				],
			},
		}),
	);
	const fake = fakePi();
	const hooks = registerHooks(
		fake.pi,
		{ OCTOCODE_HOOKS: "1", OCTOCODE_HOOKS_COMPAT: "1" },
		home,
	);
	const notify = vi.fn();
	const ctx = fakeCtx({ cwd: tmp(), hasUI: true });
	ctx.ui.notify = notify;
	await fake.fire("session_start", { reason: "startup" }, ctx);
	return { ...fake, hooks, ctx, notify };
}
const call = {
	toolName: "bash",
	toolCallId: "background",
	input: { command: "true" },
};
const success = { code: 0, stdout: "", stderr: "", timedOut: false };

it("runs at most eight Codex jobs and discards queued invocations at shutdown", async () => {
	const completions: Array<(result: typeof success) => void> = [];
	const run = vi.spyOn(runner, "runHook").mockImplementation(
		(_hook, _input, _cwd, _env, signal) =>
			new Promise((resolve) => {
				completions.push(resolve);
				signal!.addEventListener(
					"abort",
					() => resolve({ ...success, code: 1 }),
					{ once: true },
				);
			}),
	);
	const f = await fixture(10);
	try {
		expect(await f.hooks.preToolUse(call as never, f.ctx)).toBeUndefined();
		expect(run).toHaveBeenCalledTimes(8);
		completions[0]!(success);
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(9), {
			timeout: 1000,
		});
	} finally {
		await f.fire("session_shutdown", {}, f.ctx);
	}
	expect(run).toHaveBeenCalledTimes(9);
});

it("delivers valid informational output while ignoring controls and keeping UI warnings out of model context", async () => {
	vi.spyOn(runner, "runHook").mockResolvedValue({
		...success,
		stdout: JSON.stringify({
			decision: "block",
			reason: "ignored decision",
			systemMessage: "UI warning only",
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				additionalContext: "Codex background context",
			},
		}),
	});
	const f = await fixture();
	try {
		expect(await f.hooks.preToolUse(call as never, f.ctx)).toBeUndefined();
		const result = JSON.stringify(
			await f.emit("before_agent_start", {}, f.ctx),
		);
		expect(result).toContain("Codex background context");
		expect(result).not.toContain("UI warning only");
		expect(result).not.toContain("ignored decision");
		expect(f.notify).toHaveBeenCalledWith(
			expect.stringContaining("UI warning only"),
			"warning",
		);
		expect(f.sent).toEqual([]);
	} finally {
		await f.fire("session_shutdown", {}, f.ctx);
	}
});

it("rejects invalid background output instead of admitting it as model context", async () => {
	vi.spyOn(runner, "runHook").mockResolvedValue({
		...success,
		stdout:
			'{"unknown":"must not reach the model","hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"also rejected"}}',
	});
	const f = await fixture();
	try {
		await f.hooks.preToolUse(call as never, f.ctx);
		expect(
			JSON.stringify(await f.emit("before_agent_start", {}, f.ctx)),
		).not.toContain("also rejected");
		expect(f.notify).toHaveBeenCalledWith(
			expect.stringContaining("unknown fields"),
			"warning",
		);
	} finally {
		await f.fire("session_shutdown", {}, f.ctx);
	}
});

it("keeps Codex timeouts and runs SessionEnd synchronously despite async", async () => {
	const parsed = parseHooks(
		{
			hooks: {
				PreToolUse: [
					{
						hooks: [
							{
								type: "command",
								command: `${JSON.stringify(process.execPath)} -e 'setInterval(()=>{},1000)'`,
								timeout: 0.01,
								async: true,
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
		"codex",
	);
	const selected = commandsFor(parsed, "PreToolUse", ["Bash"])[0];
	expect(selected).toBeDefined();
	expect((await runner.runHook(selected!, {}, tmp())).timedOut).toBe(true);
	const run = vi.spyOn(runner, "runHook").mockResolvedValue(success);
	const f = await fixture(1, "SessionEnd");
	await f.fire("session_shutdown", { reason: "quit" }, f.ctx);
	expect(run).toHaveBeenCalledTimes(1);
});
