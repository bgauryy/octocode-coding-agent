import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureToolInvocation } from "../../src/core/tools/tool-invocation.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { HOOK_SETTINGS, tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

/** A subagent in each hook mode: `off` is the default, `decisions` and `all` come from its profile or its task. */
const PLAIN_CHILD = { OCTOCODE_SUBAGENT: "1" };
const DECISIONS_CHILD = { OCTOCODE_SUBAGENT: "1", OCTOCODE_SUBAGENT_HOOKS: "decisions" };
const OPTED_IN_CHILD = { OCTOCODE_SUBAGENT: "1", OCTOCODE_SUBAGENT_HOOKS: "all" };

type Handler = Record<string, unknown>;
const node = (file: string) => `${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`;

/** A hook script that records each run in `<name>.ran` and then does `body` (CommonJS source). */
function script(dir: string, name: string, body: string): { command: string; ran: () => boolean } {
	const file = path.join(dir, `${name}.cjs`);
	const marker = path.join(dir, `${name}.ran`);
	fs.writeFileSync(file, `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x");\n${body}`);
	return { command: node(file), ran: () => fs.existsSync(marker) };
}

/** A session whose user hook files hold `hooks` (written by `write`, which gets a scratch folder for scripts). */
async function session(
	env: NodeJS.ProcessEnv,
	write: (dir: string) => Record<string, Handler[]>,
	profile: "octocode" | "claude" = "octocode",
) {
	const home = tmp("child-hooks-home-");
	const octocodeHome = path.join(home, ".octocode");
	vi.stubEnv("OCTOCODE_HOME", octocodeHome);
	const file =
		profile === "claude" ? path.join(home, ".claude", "settings.json") : path.join(octocodeHome, "hooks.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const groups = Object.fromEntries(
		Object.entries(write(tmp("child-hooks-scripts-"))).map(([event, hooks]) => [event, [{ hooks }]]),
	);
	fs.writeFileSync(file, JSON.stringify({ hooks: groups }));
	const fake = fakeHost(HOOK_SETTINGS);
	fake.tools.set("bash", { name: "bash", description: "Run", parameters: Type.Object({ command: Type.String() }) });
	const failures: Array<{ note: string; allowed: boolean }> = [];
	const hooks = registerHooks(fake.api, {
		env,
		home,
		onFailure: (_what, note, allowed) => failures.push({ note, allowed }),
	});
	const ctx = fakeCtx({ cwd: tmp("child-hooks-cwd-"), hasUI: false });
	await fake.fire("session_start", { reason: "startup" }, ctx);
	const event = { toolName: "bash", toolCallId: "call-1", input: { command: "rm -rf build" } };
	const approval = () =>
		hooks.permissionRequest(captureToolInvocation("call-1", "bash", event.input)!, ctx, new AbortController().signal);
	return { fake, hooks, ctx, event, failures, call: () => hooks.preToolUse(event as never, ctx), approval };
}

const CONTEXT_OUTPUT = JSON.stringify({
	hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "HOOK_ADDED_CONTEXT" },
});

const PERMISSION = (decision: Record<string, unknown>) =>
	JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });

describe("user hooks in a subagent by default", () => {
	it("runs no hook: a PreToolUse deny, a PermissionRequest deny and a Stop hook all stay out", async () => {
		const ran: Record<string, () => boolean> = {};
		const s = await session(
			PLAIN_CHILD,
			(dir) => {
				const hook = (name: string, body: string) => {
					const made = script(dir, name, body);
					ran[name] = made.ran;
					return [{ type: "command", command: made.command }];
				};
				return {
					PreToolUse: hook("pre", 'console.error("no rm in this repo"); process.exit(2);'),
					PermissionRequest: hook("permission", `console.log(${JSON.stringify(PERMISSION({ behavior: "deny" }))});`),
					Stop: hook("stop", ""),
				};
			},
			"claude",
		);
		expect(s.hooks.hasPreToolUse("bash", s.event.input, s.ctx.cwd)).toBe(false);
		expect(await s.call()).toBeUndefined();
		expect(await s.approval()).toBeUndefined();
		for (const event of ["before_agent_start", "tool_result", "turn_end", "agent_before_settle", "session_shutdown"])
			await s.fake.fire(event, { reason: "quit" }, s.ctx);
		expect(Object.entries(ran).filter(([, did]) => did())).toEqual([]);
		expect(s.hooks.summary()).toBe("off in this subagent (neither its profile nor its task turned hooks on)");
		expect(s.hooks.report(s.ctx.cwd)).not.toContain("Loaded");
		expect(s.hooks.promptSection()).toBe("");
	});

	it("reads the mode from the variable its parent set: decisions, all, and 1 for all", () => {
		const mode = (value?: string) =>
			registerHooks(fakeHost(HOOK_SETTINGS).api, {
				env: {
					OCTOCODE_SUBAGENT: "1",
					...(value === undefined ? {} : { OCTOCODE_SUBAGENT_HOOKS: value }),
				},
			}).summary();
		expect(mode()).toMatch(/^off in this subagent/);
		expect(mode("off")).toMatch(/^off in this subagent/);
		expect(mode("decisions")).toMatch(/hook mode decisions/);
		expect(mode("all")).toBe("on, 0 hooks");
		expect(mode("1")).toBe("on, 0 hooks");
	});
});

describe("user hooks in a subagent in the decisions mode", () => {
	it("denies a call a PreToolUse hook denies", async () => {
		const s = await session(DECISIONS_CHILD, (dir) => ({
			PreToolUse: [
				{
					type: "command",
					command: script(dir, "deny", 'console.error("no rm in this repo"); process.exit(2);').command,
				},
			],
		}));
		expect(s.hooks.hasPreToolUse("bash", s.event.input, s.ctx.cwd)).toBe(true);
		expect(await s.call()).toEqual({ block: true, reason: "Blocked by a PreToolUse hook: no rm in this repo" });
	});

	it("denies on a JSON permissionDecision deny and does not inject the context that came with it", async () => {
		const output = JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: "rule 7",
				additionalContext: "HOOK_ADDED_CONTEXT",
			},
		});
		const s = await session(DECISIONS_CHILD, (dir) => ({
			PreToolUse: [
				{ type: "command", command: script(dir, "deny", `console.log(${JSON.stringify(output)});`).command },
			],
		}));
		expect(await s.call()).toEqual({ block: true, reason: "Blocked by a PreToolUse hook: rule 7" });
		expect(s.fake.sent).toEqual([]);
	});

	it("passes an ask to the permission gate", async () => {
		const output = JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "ask",
				permissionDecisionReason: "confirm deletes",
			},
		});
		const s = await session(DECISIONS_CHILD, (dir) => ({
			PreToolUse: [{ type: "command", command: script(dir, "ask", `console.log(${JSON.stringify(output)});`).command }],
		}));
		expect(await s.call()).toEqual({ ask: "confirm deletes" });
	});

	it("runs the hook but ignores its added context", async () => {
		let ran = () => false;
		const s = await session(DECISIONS_CHILD, (dir) => {
			const hook = script(dir, "context", `console.log(${JSON.stringify(CONTEXT_OUTPUT)});`);
			ran = hook.ran;
			return { PreToolUse: [{ type: "command", command: hook.command }] };
		});
		expect(await s.call()).toBeUndefined();
		expect(ran()).toBe(true);
		expect(s.fake.sent).toEqual([]);
	});

	it("ignores a rewritten input", async () => {
		const output = JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
				updatedInput: { command: "echo rewritten" },
			},
		});
		const s = await session(
			DECISIONS_CHILD,
			(dir) => ({
				PreToolUse: [
					{ type: "command", command: script(dir, "rewrite", `console.log(${JSON.stringify(output)});`).command },
				],
			}),
			"claude",
		);
		expect(await s.call()).toBeUndefined();
		expect(s.event.input.command).toBe("rm -rf build");
	});

	it("runs no Stop, SessionStart, SessionEnd or background hook", async () => {
		const ran: Record<string, () => boolean> = {};
		const s = await session(
			DECISIONS_CHILD,
			(dir) => {
				const hook = (name: string, extra: Handler = {}) => {
					const made = script(dir, name, "");
					ran[name] = made.ran;
					return [{ type: "command", command: made.command, ...extra }];
				};
				return {
					Stop: hook("stop"),
					SubagentStop: hook("subagent-stop"),
					SessionStart: hook("session-start"),
					SessionEnd: hook("session-end"),
					PostToolUse: hook("post"),
					PreToolUse: hook("background", { async: true }),
				};
			},
			"claude",
		);
		expect(await s.call()).toBeUndefined();
		for (const event of ["before_agent_start", "tool_result", "turn_end", "agent_before_settle", "session_shutdown"])
			await s.fake.fire(event, { reason: "quit" }, s.ctx);
		expect(Object.entries(ran).filter(([, did]) => did())).toEqual([]);
		// Nothing listens for the events those hooks hang on.
		for (const event of ["before_agent_start", "agent_before_settle", "tool_result", "input"])
			expect(s.fake.handlers.has(event), event).toBe(false);
		expect(s.fake.sent).toEqual([]);
	});

	it("fails open when the hook times out, and denies only for a failClosed hook", async () => {
		const slow = { type: "command", command: "sleep 5", timeout: 0.2 };
		const open = await session(DECISIONS_CHILD, () => ({ PreToolUse: [slow] }));
		expect(await open.call()).toBeUndefined();
		expect(open.failures).toEqual([{ note: "hook failed; hooks fail open, the call was allowed", allowed: true }]);

		const closed = await session(DECISIONS_CHILD, () => ({ PreToolUse: [{ ...slow, failClosed: true }] }));
		expect(await closed.call()).toMatchObject({ block: true, reason: expect.stringContaining("timed out") });
	});

	it("fails open when the hook crashes", async () => {
		const s = await session(DECISIONS_CHILD, (dir) => ({
			PreToolUse: [{ type: "command", command: script(dir, "crash", "process.exit(1);").command }],
		}));
		expect(await s.call()).toBeUndefined();
	});

	it("says what runs in /status and /hooks", async () => {
		const s = await session(DECISIONS_CHILD, () => ({
			PreToolUse: [{ type: "command", command: "true" }],
			Stop: [{ type: "command", command: "echo never" }],
		}));
		expect(s.hooks.summary()).toMatch(
			/^PreToolUse and PermissionRequest hooks can deny or ask; .* off in this subagent/,
		);
		const report = s.hooks.report(s.ctx.cwd);
		expect(report).toContain("Loaded (1):");
		expect(report).not.toContain("echo never");
		expect(s.hooks.promptSection()).toBe("");
	});
});

describe("PermissionRequest hooks in a subagent in the decisions mode", () => {
	const permissionHook = (decision: Record<string, unknown>, name: string) => {
		let ran = () => false;
		const write = (dir: string) => {
			const hook = script(dir, name, `console.log(${JSON.stringify(PERMISSION(decision))});`);
			ran = hook.ran;
			return { PermissionRequest: [{ type: "command", command: hook.command }] };
		};
		return { write, ran: () => ran() };
	};

	it("denies an approval a PermissionRequest hook denies", async () => {
		const hook = permissionHook({ behavior: "deny", message: "no deletes from agents" }, "deny");
		const s = await session(DECISIONS_CHILD, hook.write, "claude");
		expect(await s.approval()).toEqual({ decision: "deny", message: "no deletes from agents" });
		expect(hook.ran()).toBe(true);
	});

	it("runs the hook but takes no grant from its allow, its rewritten input or its permission updates", async () => {
		const hook = permissionHook(
			{
				behavior: "allow",
				updatedInput: { command: "echo rewritten" },
				updatedPermissions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }],
			},
			"allow",
		);
		const s = await session(DECISIONS_CHILD, hook.write, "claude");
		// No answer: the approval goes on to the subagent's usual path (its parent, or a refusal).
		expect(await s.approval()).toBeUndefined();
		expect(hook.ran()).toBe(true);
		expect(s.event.input.command).toBe("rm -rf build");
	});

	it("fails open when the hook crashes, and denies only for a failClosed hook", async () => {
		const crash = (extra: Handler) => (dir: string) => ({
			PermissionRequest: [{ type: "command", command: script(dir, "crash", "process.exit(1);").command, ...extra }],
		});
		expect(await (await session(DECISIONS_CHILD, crash({}), "claude")).approval()).toBeUndefined();
		expect(await (await session(DECISIONS_CHILD, crash({ failClosed: true }), "claude")).approval()).toMatchObject({
			decision: "deny",
		});
	});

	it("still allows in the all mode", async () => {
		const hook = permissionHook({ behavior: "allow" }, "allow");
		const s = await session(OPTED_IN_CHILD, hook.write, "claude");
		expect(await s.approval()).toMatchObject({ decision: "allow" });
	});
});

describe("user hooks in a subagent in the all mode", () => {
	it("still injects a PreToolUse hook's context", async () => {
		const s = await session(OPTED_IN_CHILD, (dir) => ({
			PreToolUse: [
				{ type: "command", command: script(dir, "context", `console.log(${JSON.stringify(CONTEXT_OUTPUT)});`).command },
			],
		}));
		expect(await s.call()).toBeUndefined();
		expect(s.fake.sent).toHaveLength(1);
		expect(s.fake.sent[0].message.content).toContain("HOOK_ADDED_CONTEXT");
	});

	it("still applies a rewritten input and registers the other events", async () => {
		const output = JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
				updatedInput: { command: "echo rewritten" },
			},
		});
		const s = await session(
			OPTED_IN_CHILD,
			(dir) => ({
				PreToolUse: [
					{ type: "command", command: script(dir, "rewrite", `console.log(${JSON.stringify(output)});`).command },
				],
			}),
			"claude",
		);
		expect(await s.call()).toMatchObject({ rewritten: true });
		expect(s.event.input.command).toBe("echo rewritten");
		for (const event of ["before_agent_start", "agent_before_settle", "tool_result"])
			expect(s.fake.handlers.has(event), event).toBe(true);
		expect(s.hooks.summary()).toBe("on, 1 hook");
	});
});
