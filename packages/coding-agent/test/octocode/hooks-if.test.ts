import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureToolInvocation } from "../../src/core/tools/tool-invocation.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { HOOK_SETTINGS, tmp } from "./helpers.ts";
afterEach(() => vi.unstubAllEnvs());

/** A Claude PreToolUse guard that denies everything it runs for, with `hook` fields (`if`, `onFailure`) merged in. */
async function setup(
	hook: Record<string, unknown>,
	event = "PreToolUse",
	matcher = "Bash|Edit",
	body = "console.error('guard ran');process.exit(2);",
) {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	fs.mkdirSync(path.join(home, ".claude"));
	const script = path.join(tmp(), "deny.cjs");
	fs.writeFileSync(script, body);
	fs.writeFileSync(
		path.join(home, ".claude/settings.json"),
		JSON.stringify({
			hooks: {
				[event]: [{ matcher, hooks: [{ type: "command", command: `${process.execPath} ${script}`, ...hook }] }],
			},
		}),
	);
	const fake = fakeHost(HOOK_SETTINGS);
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	const hooks = registerHooks(fake.api, {}, home);
	await fake.fire("session_start", { reason: "startup" }, ctx);
	const call = async (toolName: string, input: Record<string, unknown>) =>
		hooks.preToolUse({ toolName, toolCallId: "c", input } as never, ctx);
	return { call, hooks, fake, ctx };
}

it.each([
	["rm -rf x", true],
	["cd build && rm -rf x", true],
	["FOO=1 rm x", true],
	["ls", false],
	["echo rm", false],
])('runs the docs block-rm hook ("if": "Bash(rm *)") for %s: %s', async (command, runs) => {
	const { call } = await setup({ if: "Bash(rm *)" });
	const result = await call("bash", { command });
	if (runs) expect(result).toMatchObject({ block: true });
	else expect(result).toBeUndefined();
});

it("runs a guard when the matcher cannot judge the call (command substitution)", async () => {
	const { call } = await setup({ if: "Bash(rm *)" });
	expect(await call("bash", { command: "echo $(rm -rf /)" })).toMatchObject({ block: true });
});

it("filters file calls per query by path", async () => {
	const { call } = await setup({ if: "Edit(*.env)" });
	const edit = (file: string) => ({
		queries: [{ type: "edit", path: file, edits: [{ oldText: "a", newText: "b" }] }],
	});
	expect(await call("file", edit("prod.env"))).toMatchObject({ block: true });
	expect(await call("file", edit("main.ts"))).toBeUndefined();
});

it.each([{ onFailure: "block" }, { failClosed: true }, {}])(
	"skips a hook with an unparseable if, naming it in the diagnostics, without denying calls (%o)",
	async (extra) => {
		const { call, hooks, ctx } = await setup({ if: "Bash(rm *", ...extra });
		expect(await call("bash", { command: "rm -rf x" })).toBeUndefined();
		expect(hooks.report(ctx.cwd)).toContain("permission rule");
	},
);

it("skips a hook with if on a non-tool event, as Claude never runs it there", async () => {
	const { hooks, ctx } = await setup({ if: "Bash(rm *)" }, "UserPromptSubmit", "");
	expect(hooks.report(ctx.cwd)).toContain("only evaluated on tool events");
});

it("filters PermissionRequest hooks by if", async () => {
	const deny = JSON.stringify({
		hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "no rm" } },
	});
	const { hooks, ctx } = await setup(
		{ if: "Bash(rm *)" },
		"PermissionRequest",
		"Bash",
		`console.log(${JSON.stringify(deny)})`,
	);
	const ask = (command: string) =>
		hooks.permissionRequest(captureToolInvocation(command, "bash", { command })!, ctx, new AbortController().signal);
	expect(await ask("rm -rf x")).toMatchObject({ decision: "deny" });
	expect(await ask("ls")).toBeUndefined();
	expect(hooks.report(ctx.cwd)).not.toContain("PermissionRequest hook skipped");
});

it("accepts if on prompt, HTTP and MCP handlers, as Claude does on every handler type", async () => {
	for (const handler of [
		{ type: "prompt", prompt: "Is this safe?" },
		{ type: "http", url: "https://hooks.example.com/check" },
		{ type: "mcp_tool", server: "guard", tool: "check" },
	]) {
		const { hooks, ctx } = await setup({ ...handler, command: undefined, if: "Bash(rm *)" });
		expect(hooks.report(ctx.cwd)).not.toMatch(/unsupported|invalid/);
	}
});

it("lets a call start early when every PreToolUse hook's if rules it out", async () => {
	const { hooks, ctx } = await setup({ if: "Bash(rm *)" });
	expect(hooks.hasPreToolUse("bash", { command: "rm -rf x" }, ctx.cwd)).toBe(true);
	expect(hooks.hasPreToolUse("bash", { command: "ls" }, ctx.cwd)).toBe(false);
});

it("filters PostToolUse hooks by if", async () => {
	const { fake, ctx } = await setup({ if: "Bash(rm *)" }, "PostToolUse", "Bash");
	const emit = (command: string) =>
		fake.emit(
			"tool_result",
			{ toolName: "bash", toolCallId: command, input: { command }, content: [{ type: "text", text: "ok" }] },
			ctx,
		);
	expect(JSON.stringify(await emit("rm x"))).toContain("guard ran");
	expect(JSON.stringify(await emit("ls"))).not.toContain("guard ran");
});
