import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commandsFor } from "../../src/octocode/hooks/config/calls.ts";
import { parseHooks } from "../../src/octocode/hooks/config/parse.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { failureOf } from "../../src/octocode/hooks/runner.ts";
import { events } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { approveFixtureHooks } from "./guard-helpers.ts";

beforeEach(() => {
	vi.stubEnv("OCTOCODE_HOME", tmp("octocode-hooks-home-"));
});

type Hook = { type: "command"; command: string; timeout?: number; failClosed?: boolean };

/** A trusted project with one native hook: PreToolUse for Bash unless `event` names another. */
function project(hook: Hook, event = "PreToolUse"): string {
	const dir = tmp("octocode-hookfail-");
	fs.mkdirSync(path.join(dir, ".git"));
	fs.mkdirSync(path.join(dir, ".octocode"));
	const group = event === "PreToolUse" ? { matcher: "Bash", hooks: [hook] } : { hooks: [hook] };
	fs.writeFileSync(path.join(dir, ".octocode", "hooks.json"), JSON.stringify({ hooks: { [event]: [group] } }));
	approveFixtureHooks(dir);
	return dir;
}

async function run(hook: Hook, options: { hasUI?: boolean; event?: string } = {}) {
	const cwd = project(hook, options.event);
	const { api, fire } = fakeHost();
	const failures: Array<{ what: readonly string[]; note: string; allowed: boolean }> = [];
	const hooks = registerHooks(api, {
		env: {},
		home: tmp(),
		onFailure: (what, note, allowed) => failures.push({ what, note, allowed }),
	});
	const notify = vi.fn();
	const ctx = {
		cwd,
		hasUI: options.hasUI ?? true,
		ui: { notify, setStatus: () => undefined },
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined, getBranch: () => [] },
	};
	await fire("session_start", { reason: "startup" }, ctx);
	const call = () =>
		hooks.preToolUse({ toolName: "bash", toolCallId: "b", input: { command: "ls" } } as never, ctx as never);
	return { call, failures, notify, fire, ctx, hooks, cwd };
}

const TIMEOUT: Hook = { type: "command", command: "sleep 5", timeout: 0.2 };

describe("durable hook dispatch", () => {
	const rows = (cwd: string, id: string, event: string) =>
		events.read(sharedAgentDb().db, {
			workspaceId: registeredWorkspace(cwd).id,
			sessionId: `hooks:${id}`,
			topic: `hook.${event}`,
			after: 0,
		});

	it("records only the one configured SessionStart protocol", async () => {
		const cwd = project({ type: "command", command: "true" }, "SessionStart");
		const host = fakeHost();
		registerHooks(host.api, { env: {}, home: tmp() });
		const ctx = fakeCtx({ cwd });
		await host.fire("session_start", { reason: "startup" }, ctx);
		await host.fire("before_agent_start", {}, ctx);
		expect(rows(cwd, ctx.sessionManager.getSessionId(), "SessionStart")).toHaveLength(1);
		await host.fire("session_shutdown", { reason: "quit" }, ctx);
	});

	it("shuts down a decision-only child before a queued gate can launch a command", async () => {
		const cwd = project({ type: "command", command: "touch child-hook-started" });
		const host = fakeHost();
		const hooks = registerHooks(host.api, {
			env: { OCTOCODE_SUBAGENT: "1", OCTOCODE_SUBAGENT_HOOKS: "decisions" },
			home: tmp(),
		});
		const ctx = fakeCtx({ cwd });
		await host.fire("session_start", { reason: "startup" }, ctx);
		const pending = hooks.preToolUse(
			{ type: "tool_call", toolName: "bash", toolCallId: "stopped", input: { command: "ls" } },
			ctx,
		);
		await host.fire("session_shutdown", { reason: "quit" }, ctx);
		await pending;
		expect(fs.existsSync(path.join(cwd, "child-hook-started"))).toBe(false);
	});

	it("keeps concurrent parent and child decisions in their own session and workspace after resume", async () => {
		const first = project({ type: "command", command: "echo first >&2; exit 2" });
		const second = project({ type: "command", command: "echo second >&2; exit 2" });
		const start = async (env: NodeJS.ProcessEnv, id: string) => {
			const host = fakeHost();
			const view = registerHooks(host.api, { env, home: tmp() });
			const open = async (cwd: string, reason: "startup" | "resume") => {
				const ctx = fakeCtx({ cwd });
				ctx.sessionManager.getSessionId = () => id;
				await host.fire("session_start", { reason }, ctx);
				return () =>
					view.preToolUse({ type: "tool_call", toolName: "bash", toolCallId: "call", input: { command: "ls" } }, ctx);
			};
			return { open, call: await open(first, "startup") };
		};
		const parent = await start({}, "parent");
		const child = await start(
			{ OCTOCODE_SUBAGENT: "1", OCTOCODE_SUBAGENT_HOOKS: "decisions", OCTOCODE_PARENT_SESSION: "parent" },
			"child",
		);
		const decisions = await Promise.all([parent.call(), child.call()]);
		for (const verdict of decisions)
			expect(verdict).toMatchObject({ block: true, reason: expect.stringContaining("first") });
		const resumed = await child.open(second, "resume");
		const [parentVerdict, childVerdict] = await Promise.all([parent.call(), resumed()]);
		expect(parentVerdict?.reason).toContain("first");
		expect(childVerdict?.reason).toContain("second");
		expect(rows(first, "parent", "PreToolUse")).toHaveLength(2);
		expect(rows(first, "child", "PreToolUse")).toHaveLength(1);
		expect(rows(second, "child", "PreToolUse")).toHaveLength(1);
		expect(rows(second, "parent", "PreToolUse")).toHaveLength(0);
	});
});

describe("native hook failures outside a gate", () => {
	it("warns once when a native SessionStart hook times out, and starts the session anyway", async () => {
		// SessionStart hooks run in the background: the warning follows the timeout, not the start.
		const { notify, fire, ctx, hooks, cwd } = await run(TIMEOUT, { event: "SessionStart" });
		const warnings = () => notify.mock.calls.filter(([, level]) => level === "warning");
		await vi.waitFor(() => expect(warnings()).toHaveLength(1), { timeout: 5_000 });
		expect(warnings()[0][0]).toMatch(/^SessionStart hook timed out after 0\.2s: sleep 5/);
		expect(hooks.report(cwd)).toMatch(/sleep 5 .* · 1 run, 1 failed/);
		await fire("session_start", { reason: "resume" }, ctx);
		// The second run timed out too (the report counts it) before the warnings are counted again.
		await vi.waitFor(() => expect(hooks.report(cwd)).toMatch(/sleep 5 .* · 2 runs, 2 failed/), { timeout: 5_000 });
		expect(warnings().map(([message]) => message)).toEqual([warnings()[0][0]]);
	}, 15_000);
});

describe("PreToolUse hook failures", () => {
	it("warns, audits and lets the call go ahead when a hook times out (fail open)", async () => {
		const { call, failures, notify } = await run(TIMEOUT);
		expect(await call()).toBeUndefined();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]).toEqual([
			expect.stringMatching(/PreToolUse hook timed out after 0\.2s: sleep 5.*allowed.*failClosed/),
			"warning",
		]);
		expect(failures).toEqual([
			{
				what: ["PreToolUse hook timed out after 0.2s: sleep 5", "tool: Bash"],
				note: expect.stringContaining("fail open"),
				allowed: true,
			},
		]);
		// The warning is shown once per hook; every failure is audited.
		await call();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(failures).toHaveLength(2);
	}, 15_000);

	it("shows controls in a failed hook's command as visible escapes in the reason the model reads", async () => {
		const { call } = await run({ ...TIMEOUT, command: "sleep 5 # \u001b[31m\u202e", failClosed: true });
		const verdict = (await call()) as { reason: string };
		expect(verdict.reason).toContain("failClosed: sleep 5 # \\u{1b}[31m\\u{202e}");
		expect(verdict.reason).not.toMatch(/[\u001b\u202e]/u);
	}, 15_000);

	it("denies the call when a failClosed hook times out, and says so", async () => {
		const { call, failures, notify } = await run({ ...TIMEOUT, failClosed: true });
		expect(await call()).toEqual({
			block: true,
			reason: expect.stringMatching(
				/^Blocked by a PreToolUse hook: PreToolUse hook timed out after 0\.2s and is set to failClosed: sleep 5/,
			),
		});
		expect(notify.mock.calls[0]?.[0]).toMatch(/denied \(failClosed\)/);
		expect(failures).toEqual([
			expect.objectContaining({ allowed: false, note: expect.stringContaining("failClosed denied") }),
		]);
	}, 15_000);

	it("treats a crash and invalid JSON as failures, headless too (audit only), and a clean answer or exit 2 as none", async () => {
		const crash = await run({ type: "command", command: "exit 3", failClosed: true }, { hasUI: false });
		expect(await crash.call()).toMatchObject({ block: true });
		expect(crash.notify).not.toHaveBeenCalled();
		expect(crash.failures[0]?.what[0]).toBe("PreToolUse hook crashed (exit 3): exit 3");
		const invalid = await run({ type: "command", command: 'echo "{oops"' });
		expect(await invalid.call()).toBeUndefined();
		expect(invalid.failures[0]?.what[0]).toBe('PreToolUse hook printed invalid JSON: echo "{oops"');
		for (const command of [
			"exit 0",
			"echo checked 3 files",
			`echo '{"hookSpecificOutput":{"permissionDecision":"ask"}}'`,
		]) {
			const fine = await run({ type: "command", command, failClosed: true });
			expect(await fine.call(), command).not.toMatchObject({ block: true });
			expect(fine.failures, command).toEqual([]);
		}
		const blocks = await run({ type: "command", command: "echo no >&2; exit 2", failClosed: true });
		expect(await blocks.call()).toEqual({ block: true, reason: "Blocked by a PreToolUse hook: no" });
		expect(blocks.failures).toEqual([]);
	}, 20_000);

	it("does not treat other events or a cancelled run as failures", () => {
		const base = { code: null, stdout: "", stderr: "", timedOut: false };
		expect(failureOf({ timeoutMs: 1000 }, base, true)).toBeUndefined();
		expect(failureOf({ timeoutMs: 1000 }, base, false)).toMatch(/^crashed/);
		expect(failureOf({ timeoutMs: 1000 }, { ...base, code: 0 }, false)).toBeUndefined();
		expect(failureOf({ timeoutMs: 2500 }, { ...base, timedOut: true }, false)).toBe("timed out after 2.5s");
	});

	it("reads failClosed from the config, and keeps it when the same command is configured twice", () => {
		const config = parseHooks(
			{
				hooks: {
					PreToolUse: [
						{
							hooks: [
								{ type: "command", command: "g", failClosed: "yes" },
								{ type: "command", command: "h", failClosed: true },
							],
						},
					],
				},
			},
			"a",
		);
		parseHooks(
			{ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "g", failClosed: true }] }] } },
			"b",
			config,
		);
		expect(commandsFor(config, "PreToolUse", ["bash"])).toEqual([
			expect.objectContaining({ command: "g", failClosed: true }),
			expect.objectContaining({ command: "h", failClosed: true }),
		]);
		expect(
			parseHooks({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "g", failClosed: "yes" }] }] } }, "a")
				.PreToolUse[0].hooks[0],
		).not.toHaveProperty("failClosed");
	});
});

describe("observer hook dispatch failures", () => {
	/** A trusted project with `event` hooks; the session id lookup throws after `okCalls` calls, which fails the dispatch itself. */
	async function failing(event: "Notification" | "PostMessageReceive", okCalls: number) {
		const cwd = tmp("octocode-hookobs-");
		fs.mkdirSync(path.join(cwd, ".git"));
		fs.mkdirSync(path.join(cwd, ".octocode"));
		fs.writeFileSync(
			path.join(cwd, ".octocode", "hooks.json"),
			JSON.stringify({ hooks: { [event]: [{ hooks: [{ type: "command", command: "true" }] }] } }),
		);
		approveFixtureHooks(cwd);
		const { api, fire } = fakeHost();
		const hooks = registerHooks(api, { env: {}, home: tmp() });
		const notify = vi.fn();
		let calls = 0;
		const ctx = {
			cwd,
			hasUI: true,
			ui: { notify, setStatus: () => undefined },
			isProjectTrusted: () => true,
			sessionManager: {
				getSessionId: () => {
					if (++calls > okCalls) throw new Error("session store unavailable");
					return "s";
				},
				getSessionFile: () => undefined,
			},
		};
		await fire("session_start", { reason: "startup" }, ctx);
		calls = 0;
		return { hooks, notify, ctx, fire };
	}

	it("warns once when a Notification hook cannot be dispatched", async () => {
		const { hooks, notify, ctx, fire } = await failing("Notification", 0);
		hooks.notification({ type: "idle_prompt", message: "idle" }, ctx as never);
		await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
		expect(notify).toHaveBeenCalledWith("Notification hooks could not run: session store unavailable", "warning");
		hooks.notification({ type: "idle_prompt", message: "idle" }, ctx as never);
		// Shutdown waits for every Notification dispatch still going, so the second one has failed by now.
		await fire("session_shutdown", { reason: "quit" }, ctx);
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("warns when a PostMessageReceive hook cannot be dispatched", async () => {
		// The first lookup (is the message for this session?) works; the dispatch's own lookup fails.
		const { hooks, notify, ctx } = await failing("PostMessageReceive", 1);
		await hooks.messageReceive(
			{ channel: "internal", direction: "inbound", from: "a", to: "b", text: "hi", id: "m-1" },
			ctx as never,
		);
		expect(notify).toHaveBeenCalledWith("PostMessageReceive hooks could not run: session store unavailable", "warning");
	});
});
