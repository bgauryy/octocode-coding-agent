import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { loadHooks } from "../../src/octocode/hooks/config.ts";
import { interpret } from "../../src/octocode/hooks/runner.ts";
import { tmp } from "./helpers.ts";
import { commandsFor } from "../../src/octocode/hooks/config/calls.ts";
it("normalizes Codex Interrupt timeout, ignores matcher, and retains async and MCP handlers", () => {
	const home = tmp();
	fs.mkdirSync(path.join(home, ".codex"));
	fs.writeFileSync(
		path.join(home, ".codex/hooks.json"),
		JSON.stringify({
			hooks: {
				Interrupt: [
					{
						matcher: "(",
						hooks: [
							{ type: "command", command: "true" },
							{ type: "command", command: "true", timeout: 600, async: true },
							{ type: "mcp_tool", server: "policy", tool: "observe" },
						],
					},
				],
			},
		}),
	);
	const loaded = loadHooks(tmp(), false, home, { sourceProfiles: true });
	expect(loaded.errors).toEqual([]);
	const hooks = commandsFor(loaded.config, "Interrupt", []);
	expect(hooks.map((hook) => hook.timeoutMs)).toEqual([1000, 3000, 1000]);
	expect(hooks[1]).toHaveProperty("async", true);
	expect(hooks[2]).toHaveProperty("type", "mcp_tool");
});
it("Interrupt accepts only optional systemMessage and cannot affect a turn", () => {
	const run = (stdout: string, code = 0) => ({
		stdout,
		code,
		stderr: "stderr",
		timedOut: false,
	});
	expect(interpret("Interrupt", run('{"systemMessage":"notice"}'), "codex")).toEqual({ systemMessage: "notice" });
	for (const output of ["plain", "[]", '{"continue":false}', '{"hookSpecificOutput":{"additionalContext":"inject"}}'])
		expect(interpret("Interrupt", run(output), "codex").error).toBeDefined();
	expect(interpret("Interrupt", run("", 2), "codex").error).toBeDefined();
	expect(interpret("Interrupt", run(""), "codex")).toEqual({});
});
it.each(["command", "mcp_tool"] as const)(
	"clamps %s Interrupt unsigned timeouts to one through three seconds",
	(type) => {
		const home = tmp();
		fs.mkdirSync(path.join(home, ".codex"));
		const values = [undefined, null, 0, 1, 3, 4, -1, 0.5, "2"];
		fs.writeFileSync(
			path.join(home, ".codex/hooks.json"),
			JSON.stringify({
				hooks: {
					Interrupt: [
						{
							hooks: values.map((timeout, index) => ({
								type,
								...(type === "command" ? { command: `echo ${index}` } : { server: "policy", tool: `observe${index}` }),
								timeout,
							})),
						},
					],
				},
			}),
		);
		const loaded = loadHooks(tmp(), false, home, { sourceProfiles: true });
		expect(commandsFor(loaded.config, "Interrupt", []).map((hook) => hook.timeoutMs)).toEqual([
			1000, 1000, 1000, 1000, 3000, 3000,
		]);
		expect(loaded.errors).toHaveLength(3);
	},
);

it.each([' {"systemMessage":"MCP interruption notice"}', '{"continue":false}'])(
	"dispatches Interrupt through MCP with fresh signal and observable output %s",
	async (output) => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const { registerHooks } = await import("../../src/octocode/hooks/register.ts");
		const { fakePi, fakeCtx } = await import("./fake-pi.ts");
		const { createEventBus } = await import("../../src/core/event-bus.ts");
		const { registerMcpHookCaller } = await import("../../src/extensions/mcp/hook-caller.ts");
		const home = tmp();
		fs.mkdirSync(path.join(home, ".codex"));
		fs.writeFileSync(
			path.join(home, ".codex/hooks.json"),
			JSON.stringify({
				hooks: {
					Interrupt: [
						{
							hooks: [
								{
									type: "mcp_tool",
									server: "policy",
									tool: "observe",
									input: { turn: "${turn_id}", model: "${model}" },
								},
							],
						},
					],
				},
			}),
		);
		const fake = fakePi();
		fake.pi.events = createEventBus();
		let called = false;
		const unregister = registerMcpHookCaller(fake.pi.events, async (request) => {
			called = true;
			expect(request.signal?.aborted).toBe(false);
			expect(request.input).toEqual({
				turn: "interrupted-turn",
				model: "captured-model",
			});
			return { content: [{ type: "text", text: output }] };
		});
		const ctx = fakeCtx({
			cwd: tmp(),
			hasUI: false,
			model: { id: "later-model" },
		});
		ctx.signal = AbortSignal.abort();
		registerHooks(fake.pi, { OCTOCODE_HOOKS: "1", OCTOCODE_HOOKS_COMPAT: "1" }, home, undefined, () => ({
			permissionMode: "workspace",
		}));
		try {
			await fake.fire("session_start", { reason: "startup" }, { ...ctx, signal: undefined });
			const results = await fake.emit(
				"agent_interrupted",
				{
					turnId: "interrupted-turn",
					sessionId: "session",
					cwd: ctx.cwd,
					model: { id: "captured-model" },
				},
				ctx,
			);
			expect(called).toBe(true);
			expect(results.every((result) => result === undefined)).toBe(true);
			expect(fake.sent).toEqual([]);
			expect(stderr).toHaveBeenCalled();
		} finally {
			unregister();
			stderr.mockRestore();
		}
	},
);
