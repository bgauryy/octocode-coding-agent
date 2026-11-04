import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { commandsFor } from "../../src/octocode/hooks/config/calls.ts";
import { parseHooks } from "../../src/octocode/hooks/config/parse.ts";
import { interpret, runHook } from "../../src/octocode/hooks/runner.ts";
import { tmp } from "./helpers.ts";

function hook(input: unknown = { path: "${tool_input.file_path}" }) {
	return commandsFor(
		parseHooks(
			{
				hooks: {
					PreToolUse: [
						{
							hooks: [
								{
									type: "mcp_tool",
									server: "policy",
									tool: "check",
									input,
									timeout: 0.1,
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
		),
		"PreToolUse",
		["Bash"],
	)[0];
}
it("calls the MCP owner with substituted arguments and decodes text results", async () => {
	const call = vi.fn(async () => ({
		content: [
			{
				type: "text" as const,
				text: '{"decision":"block","reason":"policy denied"}',
			},
		],
	}));
	const result = await runHook(
		hook(),
		{ hook_event_name: "PreToolUse", tool_input: { file_path: "a b.txt" } },
		tmp(),
		{},
		undefined,
		call,
	);
	expect(call).toHaveBeenCalledWith(
		expect.objectContaining({
			server: "policy",
			tool: "check",
			input: { path: "a b.txt" },
			waitForConnection: true,
			signal: expect.any(AbortSignal),
		}),
	);
	expect(interpret("PreToolUse", result, "claude")).toMatchObject({
		block: "policy denied",
	});
});
it("treats server errors as failures and bounds calls that ignore cancellation", async () => {
	const result = await runHook(hook(), {}, tmp(), {}, undefined, async () => ({
		isError: true,
		content: [{ type: "text" as const, text: "server error" }],
	}));
	expect(result.code).toBeNull();
	expect(interpret("PreToolUse", result, "claude")).toEqual({});
	const stalled = await runHook(hook(), {}, tmp(), {}, undefined, () => new Promise(() => {}));
	expect(stalled.timedOut).toBe(true);
});
it("does not call MCP after cancellation or when no MCP owner is available", async () => {
	const call = vi.fn();
	const abort = new AbortController();
	abort.abort();
	await runHook(hook(), {}, tmp(), {}, abort.signal, call);
	expect(call).not.toHaveBeenCalled();
	expect((await runHook(hook(), {}, tmp())).stderr).toContain("MCP");
});
it("skips launch SessionStart MCP hooks but runs later compact/clear hooks", async () => {
	const errors: string[] = [];
	const config = parseHooks(
		{
			hooks: {
				SessionStart: [{ hooks: [{ type: "mcp_tool", server: "policy", tool: "context" }] }],
			},
		},
		"fixture",
		undefined,
		errors,
		undefined,
		"claude",
	);
	expect(errors).toEqual([]);
	const selected = commandsFor(config, "SessionStart", ["compact"])[0];
	const call = vi.fn(async () => ({
		content: [{ type: "text" as const, text: "session guidance" }],
	}));
	for (const source of ["startup", "resume", "fork"]) {
		const result = await runHook(selected, { hook_event_name: "SessionStart", source }, tmp(), {}, undefined, call);
		expect(result).toMatchObject({ code: 0, stdout: "" });
	}
	expect(call).not.toHaveBeenCalled();
	for (const source of ["clear", "compact"]) {
		const result = await runHook(selected, { hook_event_name: "SessionStart", source }, tmp(), {}, undefined, call);
		expect(interpret("SessionStart", result, "claude")).toEqual({
			context: "session guidance",
		});
	}
	expect(call).toHaveBeenCalledTimes(2);
});

function codexHook(event = "PreToolUse", input: Record<string, unknown> = {}) {
	const errors: string[] = [];
	const config = parseHooks(
		{
			hooks: {
				[event]: [
					{
						hooks: [{ type: "mcp_tool", server: "policy", tool: "check", input }],
					},
				],
			},
		},
		"fixture",
		undefined,
		errors,
		undefined,
		"codex",
	);
	return {
		selected: config[event as keyof typeof config][0]?.hooks[0],
		errors,
	};
}
it("runs Codex MCP hooks on existing connections with typed recursive placeholders", async () => {
	const { selected, errors } = codexHook("PreToolUse", {
		count: "${tool_input.count}",
		nested: ["${tool_input.object}", "n=${tool_input.count}", "${tool_input.nil}"],
		literal: "$none",
	});
	expect(errors).toEqual([]);
	const call = vi.fn(async () => ({
		content: [
			{
				type: "text" as const,
				text: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked"}}',
			},
		],
	}));
	const result = await runHook(
		selected,
		{
			hook_event_name: "PreToolUse",
			tool_input: { count: 3, object: { enabled: true }, nil: null },
		},
		tmp(),
		{},
		undefined,
		call,
	);
	expect(call).toHaveBeenCalledWith(
		expect.objectContaining({
			waitForConnection: false,
			input: {
				count: 3,
				nested: [{ enabled: true }, "n=3", null],
				literal: "$none",
			},
		}),
	);
	expect(interpret("PreToolUse", result, "codex")).toMatchObject({
		block: "blocked",
	});
});
it("fails Codex missing placeholders without invoking the tool", async () => {
	const { selected, errors } = codexHook("PreToolUse", {
		missing: "${tool_input.absent}",
	});
	expect(errors).toEqual([]);
	const call = vi.fn();
	const result = await runHook(selected, { tool_input: {} }, tmp(), {}, undefined, call);
	expect(result.code).toBeNull();
	expect(result.stderr).toContain("was not found");
	expect(call).not.toHaveBeenCalled();
});
it("attempts Codex startup MCP hooks but excludes SessionEnd", async () => {
	const { selected, errors } = codexHook("SessionStart");
	expect(errors).toEqual([]);
	const call = vi.fn(async () => ({
		content: [{ type: "text" as const, text: "startup context" }],
	}));
	await runHook(selected, { hook_event_name: "SessionStart", source: "startup" }, tmp(), {}, undefined, call);
	expect(call).toHaveBeenCalledWith(expect.objectContaining({ waitForConnection: false }));
	const ending = codexHook("SessionEnd");
	expect(ending.selected).toBeUndefined();
	expect(ending.errors.join()).toContain("SessionEnd");
});
it("isolates typed Codex placeholder objects from the original event payload", async () => {
	const payload = { tool_input: { nested: { permitted: false } } };
	const { selected } = codexHook("PreToolUse", {
		value: "${tool_input.nested}",
	});
	await runHook(selected, payload, tmp(), {}, undefined, async (request) => {
		(request.input.value as { permitted: boolean }).permitted = true;
		return { content: [] };
	});
	expect(payload.tool_input.nested.permitted).toBe(false);
});

it("counts a run whose MCP server is missing as failed in the hooks report", async () => {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	fs.mkdirSync(path.join(home, ".claude"));
	fs.writeFileSync(
		path.join(home, ".claude/settings.json"),
		JSON.stringify({
			hooks: { PreToolUse: [{ hooks: [{ type: "mcp_tool", server: "missing", tool: "check", timeout: 1 }] }] },
		}),
	);
	const fake = fakeHost();
	const hooks = registerHooks(fake.api, {}, home);
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	await fake.fire("session_start", { reason: "startup" }, ctx);
	await hooks.preToolUse({ toolName: "bash", toolCallId: "m", input: { command: "true" } } as never, ctx);
	expect(hooks.report(ctx.cwd)).toMatch(/ · 1 run, 1 failed, avg /);
	vi.unstubAllEnvs();
});
