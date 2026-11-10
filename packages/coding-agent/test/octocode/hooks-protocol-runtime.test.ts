import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HookCommand, HookRun } from "../../src/octocode/hooks/contracts.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { interpret, runHook } from "../../src/octocode/hooks/runner.ts";
import { captureToolInvocation } from "../../src/core/tools/tool-invocation.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { HOOK_SETTINGS, tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

const run = (code: number | null, stdout = "", stderr = ""): HookRun => ({ code, stdout, stderr, timedOut: false });
const json = (value: unknown) => JSON.stringify(value);

/** Writes `~/.claude` or `~/.codex` hook config; the command is a node script given as source. */
function setup(
	protocol: "claude" | "codex",
	hooks: Record<string, Array<{ matcher?: string; scripts: string[] }>>,
): { home: string; dir: string } {
	const home = tmp();
	const dir = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	fs.mkdirSync(path.join(home, protocol === "codex" ? ".codex" : ".claude"));
	let n = 0;
	const config = Object.fromEntries(
		Object.entries(hooks).map(([event, groups]) => [
			event,
			groups.map((group) => ({
				...(group.matcher ? { matcher: group.matcher } : {}),
				hooks: group.scripts.map((source) => {
					const file = path.join(dir, `hook-${n++}.cjs`);
					fs.writeFileSync(file, source);
					return { type: "command", command: `${process.execPath} ${file}` };
				}),
			})),
		]),
	);
	fs.writeFileSync(
		path.join(home, protocol === "codex" ? ".codex/hooks.json" : ".claude/settings.json"),
		json({ hooks: config }),
	);
	return { home, dir };
}
const print = (value: unknown) => `console.log(${json(json(value))});`;

describe("Claude continue:false stops the turn on tool events (audit finding 2)", () => {
	it.each(["PreToolUse", "PostToolUse", "PostToolUseFailure"] as const)("%s asks the dispatcher to halt", (event) => {
		const verdict = interpret(event, run(0, json({ continue: false, stopReason: "budget spent" })), "claude");
		expect(verdict).toMatchObject({ haltTurn: true, block: "budget spent" });
	});
	it("keeps Stop semantics and leaves other protocols alone", () => {
		expect(interpret("Stop", run(0, json({ continue: false })), "claude")).toEqual({ stop: true });
		expect(interpret("PostToolUse", run(0, json({ continue: false })), "octocode")).not.toHaveProperty("haltTurn");
	});
	it("aborts the turn and shows stopReason when a PreToolUse hook says continue:false", async () => {
		const { home } = setup("claude", {
			PreToolUse: [{ matcher: "Bash", scripts: [print({ continue: false, stopReason: "kill switch" })] }],
		});
		const fake = fakeHost(HOOK_SETTINGS);
		const ctx = fakeCtx({ cwd: tmp() });
		const abort = vi.fn();
		ctx.abort = abort;
		const hooks = registerHooks(fake.api, {}, home);
		await fake.fire("session_start", { reason: "startup" }, ctx);
		const result = await hooks.preToolUse(
			{ toolName: "bash", toolCallId: "c", input: { command: "true" } } as never,
			ctx,
		);
		expect(result).toMatchObject({ block: true });
		expect(abort).toHaveBeenCalledWith("internal");
		expect(ctx.ui.notes.map((note) => note.message)).toContainEqual(expect.stringContaining("kill switch"));
	});
	it("aborts the turn when a PostToolUse hook says continue:false", async () => {
		const { home } = setup("claude", {
			PostToolUse: [{ matcher: "Bash", scripts: [print({ continue: false, stopReason: "enough" })] }],
		});
		const fake = fakeHost(HOOK_SETTINGS);
		const ctx = fakeCtx({ cwd: tmp() });
		const abort = vi.fn();
		ctx.abort = abort;
		registerHooks(fake.api, {}, home);
		await fake.fire("session_start", { reason: "startup" }, ctx);
		await fake.emit(
			"tool_result",
			{ toolName: "bash", toolCallId: "c", input: { command: "true" }, content: [], isError: false },
			ctx,
		);
		expect(abort).toHaveBeenCalledWith("internal");
		expect(ctx.ui.notes.map((note) => note.message)).toContainEqual(expect.stringContaining("enough"));
	});
});

describe("exit 2 stderr per event (audit finding 5)", () => {
	it("feeds PostToolUseFailure stderr back to the model", () => {
		expect(interpret("PostToolUseFailure", run(2, "", "try again with sudo"), "claude")).toEqual({
			block: "try again with sudo",
		});
	});
	it.each(["SessionStart", "SubagentStart"] as const)("shows %s stderr to the user only", (event) => {
		const verdict = interpret(event, run(2, "", "setup failed"), "claude");
		expect(verdict.systemMessage).toContain("setup failed");
		expect(verdict).not.toHaveProperty("block");
		expect(verdict).not.toHaveProperty("context");
	});
});

describe("Codex Stop output (audit finding 7)", () => {
	it.each(["Stop", "SubagentStop"] as const)("treats plain-text %s stdout as invalid output", (event) => {
		expect(interpret(event, run(0, "all done"), "codex")).toEqual({ error: `Codex ${event} requires JSON output` });
		expect(interpret(event, run(0, ""), "codex")).toEqual({});
		expect(interpret(event, run(0, "all done"), "claude")).toEqual({});
	});
});

describe("output limits (audit finding 8)", () => {
	it("caps Claude additionalContext at 10,000 characters", async () => {
		const { home } = setup("claude", {
			SessionStart: [{ scripts: [`console.log(${json("line of context\n".repeat(1500))});`] }],
		});
		const fake = fakeHost(HOOK_SETTINGS);
		const ctx = fakeCtx({ cwd: tmp() });
		registerHooks(fake.api, {}, home);
		await fake.fire("session_start", { reason: "startup" }, ctx);
		const results = (await fake.emit("before_agent_start", {}, ctx)) as Array<
			{ message?: { content: string } } | undefined
		>;
		const content = results.find((value) => value?.message)?.message?.content ?? "";
		expect(content).toContain("line of context");
		expect(content.length).toBeLessThan(12_000);
	});
	it("reads a valid JSON decision far past 64 KiB", async () => {
		const hook: HookCommand = {
			type: "command",
			command: `${process.execPath} -e 'console.log(JSON.stringify({decision:"block",reason:"too big",pad:"x".repeat(200000)}))'`,
			timeoutMs: 10_000,
			source: "test",
			protocol: "claude",
		};
		const result = await runHook(hook, {}, process.cwd());
		expect(result.dropped).toBeUndefined();
		expect(interpret("PreToolUse", result, "claude")).toEqual({ block: "too big" });
	});
});

describe("Claude PermissionRequest with several handlers (S1)", () => {
	it("lets a slower deny beat a faster allow", async () => {
		const { home } = setup("claude", {
			PermissionRequest: [
				{
					matcher: "Bash",
					scripts: [
						print({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }),
						`setTimeout(()=>{${print({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "policy says no" } } })}},400);`,
					],
				},
			],
		});
		const fake = fakeHost(HOOK_SETTINGS);
		const ctx = fakeCtx({ cwd: tmp() });
		const hooks = registerHooks(fake.api, {}, home);
		await fake.fire("session_start", { reason: "startup" }, ctx);
		const decision = await hooks.permissionRequest(
			captureToolInvocation("one", "bash", { command: "true" })!,
			ctx,
			new AbortController().signal,
		);
		expect(decision).toMatchObject({ decision: "deny", message: "policy says no" });
	});
});

describe("SubagentStart runs once per subagent (S2)", () => {
	it("does not re-run the hook on later turns", async () => {
		const counter = path.join(tmp(), "count");
		const { home } = setup("claude", {
			SubagentStart: [
				{
					matcher: "general",
					scripts: [`require('fs').appendFileSync(${json(counter)},'x');console.log('child guidance');`],
				},
			],
		});
		const fake = fakeHost(HOOK_SETTINGS);
		const ctx = fakeCtx({ cwd: tmp(), hasUI: false, model: { id: "m" } });
		ctx.sessionManager.buildSessionProjection = () => ({
			entries: [],
			messages: [],
			model: null,
			thinkingLevel: "off",
		});
		registerHooks(
			fake.api,
			{ OCTOCODE_SUBAGENT: "1", OCTOCODE_SUBAGENT_HOOKS: "1", OCTOCODE_PARENT_SESSION: "parent" },
			home,
			undefined,
			() => ({ permissionMode: "workspace" }),
		);
		await fake.fire("session_start", { reason: "startup" }, ctx);
		await fake.emit("before_agent_start", {}, ctx);
		await fake.emit("before_agent_start", {}, ctx);
		await fake.emit("before_agent_start", {}, ctx);
		expect(fs.readFileSync(counter, "utf8")).toBe("x");
	});
});

describe("Codex hooks in a child session (audit finding 6)", () => {
	it("send the parent session id", async () => {
		const capture = path.join(tmp(), "input.json");
		const { home } = setup("codex", {
			PreToolUse: [
				{ scripts: [`require('fs').writeFileSync(${json(capture)},require('fs').readFileSync(0,'utf8'));`] },
			],
		});
		const fake = fakeHost(HOOK_SETTINGS);
		const ctx = fakeCtx({ cwd: tmp() });
		ctx.sessionManager.getSessionId = () => "child-session";
		const hooks = registerHooks(
			fake.api,
			{ OCTOCODE_SUBAGENT: "1", OCTOCODE_SUBAGENT_HOOKS: "1", OCTOCODE_PARENT_SESSION: "parent-session" },
			home,
		);
		await fake.fire("session_start", { reason: "startup" }, ctx);
		await hooks.preToolUse({ toolName: "bash", toolCallId: "c", input: { command: "true" } } as never, ctx);
		expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toMatchObject({
			session_id: "parent-session",
			agent_id: "child-session",
		});
	});
});
