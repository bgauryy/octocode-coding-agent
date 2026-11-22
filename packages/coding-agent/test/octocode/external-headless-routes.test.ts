import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installedAcpAgents } from "../../src/octocode/external/discover.ts";
import { HEADLESS_ARGS } from "../../src/octocode/external/headless/claude.ts";
import { HEADLESS_ROUTES, headlessRoute } from "../../src/octocode/external/headless/routes.ts";
import type { HeadlessParser } from "../../src/octocode/external/headless/types.ts";
import { headlessTurn, resolveHeadless } from "../../src/octocode/external/runner-headless.ts";
import { launchOf } from "../../src/octocode/external/runner-session.ts";
import type { RunnerState } from "../../src/octocode/external/runner-status.ts";
import { runnerSpec } from "../../src/octocode/external/runners.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

/** Flags that would let a CLI act without Octocode's approval path or the task's own folder. */
const UNRESTRICTED =
	/--yolo|-y$|--force|-f$|--auto$|bypass|danger|--trust|--skip-trust|--approve|--approval-mode=yolo|^yolo$|--bare$/;

function parse(runner: string, lines: readonly object[], code: number | null = 0, stderr = "") {
	const route = headlessRoute(runner)!;
	const activity: string[] = [];
	const parser: HeadlessParser = route.parser({
		runner,
		billing: "plan",
		roots: ["/work/task"],
		onActivity: (line) => activity.push(line),
	});
	for (const line of lines) parser.line(line as Record<string, unknown>);
	return { activity, done: parser.done, reply: () => parser.reply(code, stderr) };
}

const scope = (runner: string, isolated: boolean, model?: string) => ({
	runner,
	cwd: isolated ? "/work/task" : "/work",
	sessionCwd: "/work",
	...(model ? { model } : {}),
});

const resolve = (runner: string, isolated: boolean, model?: string) =>
	resolveHeadless({ runner, cwd: isolated ? "/work/task" : "/work", sessionCwd: "/work", ...(model ? { model } : {}) });

describe("the headless route table", () => {
	it("holds one route per runner, each pinned to the CLI version it was checked against", () => {
		expect(HEADLESS_ROUTES.map((route) => [route.id, route.tested])).toEqual([
			["claude-code", "2.1.330"],
			["codex", "0.166.0"],
			["gemini", "0.64.0"],
			["opencode", "2.0.32"],
			["cursor", "2026.11.19"],
		]);
		expect(HEADLESS_ROUTES.filter((route) => !route.enabled).map((route) => route.id)).toEqual(["opencode"]);
	});

	it("never builds an argv that lifts a sandbox or approval, in either scope", () => {
		for (const route of HEADLESS_ROUTES.filter((each) => each.enabled))
			for (const isolated of [true, false]) {
				// Cursor refuses a write task outside a worktree (its own test below); the read-only form is its folder scope.
				const argv = [...route.args, ...resolveHeadless({ ...scope(route.id, isolated, "m"), readOnly: true }).args];
				expect(
					argv.filter((arg) => UNRESTRICTED.test(arg)),
					`${route.id} isolated=${isolated}`,
				).toEqual([]);
			}
	});
});

describe("Claude Code's mode is stated, not left to the CLI's default", () => {
	// https://code.claude.com/docs/en/headless#start-faster-with-bare-mode: `--bare` "will become the default for -p"
	// and never reads OAuth or the keychain, so a subscription login would fail.
	it("pins the argv: stream-json print mode, isolation flags, no --bare", () => {
		expect([...HEADLESS_ARGS]).toEqual([
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--setting-sources",
			"",
			"--strict-mcp-config",
			"--disable-slash-commands",
		]);
	});

	it("sets CLAUDE_CODE_SIMPLE=0, which the CLI reads as not bare (it parses 1/true/yes/on), after the cleaned environment", () => {
		vi.stubEnv("CLAUDE_CODE_SIMPLE", "1");
		expect(resolve("claude-code", true).env).toEqual({ CLAUDE_CODE_SIMPLE: "0" });
		expect(resolve("claude-code", true).args).toEqual([
			"--permission-mode",
			"acceptEdits",
			"--permission-prompts",
			"none",
		]);
		expect(resolve("claude-code", false).args).toEqual(["--permission-mode", "manual", "--permission-prompts", "none"]);
	});
});

describe("the Codex route", () => {
	// https://developers.openai.com/codex/noninteractive ("Make output machine-readable"), `codex exec --help` 0.166.0.
	it("runs `codex exec --json` with the sandbox as the permission: workspace-write in a worktree, else read-only", () => {
		const route = headlessRoute("codex")!;
		expect([...route.args]).toEqual(["exec", "--json", "--color", "never", "--ignore-user-config"]);
		expect(resolve("codex", true, "gpt-x").args).toEqual(["--sandbox", "workspace-write", "--model", "gpt-x"]);
		expect(resolve("codex", false).args).toEqual(["--sandbox", "read-only"]);
	});

	it("reads the documented JSONL stream: the last agent message, commands, file changes, usage", () => {
		const run = parse("codex", [
			{ type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" },
			{ type: "turn.started" },
			{
				type: "item.started",
				item: { id: "item_1", type: "command_execution", command: "bash -lc ls", status: "in_progress" },
			},
			{
				type: "item.completed",
				item: {
					id: "item_1",
					type: "command_execution",
					command: "bash -lc ls",
					aggregated_output: "",
					exit_code: 0,
					status: "completed",
				},
			},
			{
				type: "item.completed",
				item: {
					id: "item_2",
					type: "command_execution",
					command: "rm -rf /",
					aggregated_output: "",
					exit_code: null,
					status: "declined",
				},
			},
			{
				type: "item.completed",
				item: {
					id: "item_3",
					type: "file_change",
					changes: [{ path: "/work/task/a.ts", kind: "update" }],
					status: "completed",
				},
			},
			{
				type: "item.completed",
				item: { id: "item_4", type: "agent_message", text: "Repo contains docs, sdk, and examples directories." },
			},
			{
				type: "turn.completed",
				usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 0 },
			},
		]);
		expect(run.done).toBe(true);
		expect(run.activity).toEqual(["→ Bash bash -lc ls", "✗ declined rm -rf /", "→ Edit update a.ts"]);
		expect(run.reply()).toEqual({
			text: "Repo contains docs, sdk, and examples directories.",
			stopReason: "end_turn",
			usage: { inputTokens: 315, outputTokens: 122, cachedReadTokens: 24448, totalTokens: 24885 },
			billing: "plan",
			sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
		});
	});

	it("fails a turn.failed run with its message, and reads a login failure as signed out", () => {
		const failed = parse("codex", [{ type: "turn.failed", error: { message: "context window exceeded" } }]);
		expect(failed.done).toBe(true);
		expect(failed.reply).toThrow("codex (headless) failed: context window exceeded");
		expect(parse("codex", [], 1, "Not logged in. Run codex login").reply).toThrow("Not logged in");
	});
});

describe("the Gemini route", () => {
	// https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md ("Streaming JSON output"),
	// `packages/core/src/output/types.ts` for the fields, `gemini --help` 0.64.0 for the flags.
	it("runs `-p` with stream-json, the task on stdin, and the approval mode as the permission", () => {
		const route = headlessRoute("gemini")!;
		expect([...route.args]).toEqual(["--output-format", "stream-json", "-p", "Do the task given above."]);
		expect(route.task).toBe("text");
		expect(resolve("gemini", true).args).toEqual(["--approval-mode", "auto_edit"]);
		expect(resolve("gemini", false, "gemini-x").args).toEqual(["--approval-mode", "default", "--model", "gemini-x"]);
	});

	it("reads the documented stream: the text after the last tool call, tool failures, usage", () => {
		const ts = "2026-11-21T10:00:00.000Z";
		const run = parse("gemini", [
			{ type: "init", timestamp: ts, session_id: "s1", model: "gemini-2.5-pro" },
			{ type: "message", timestamp: ts, role: "user", content: "task" },
			{ type: "message", timestamp: ts, role: "assistant", content: "Let me look. ", delta: true },
			{
				type: "tool_use",
				timestamp: ts,
				tool_name: "read_file",
				tool_id: "t1",
				parameters: { absolute_path: "/work/task/src/app.ts" },
			},
			{ type: "tool_result", timestamp: ts, tool_id: "t1", status: "success", output: "export {}" },
			{
				type: "tool_use",
				timestamp: ts,
				tool_name: "run_shell_command",
				tool_id: "t2",
				parameters: { command: "rm -rf /" },
			},
			{
				type: "tool_result",
				timestamp: ts,
				tool_id: "t2",
				status: "error",
				error: { type: "policy", message: "denied" },
			},
			{ type: "message", timestamp: ts, role: "assistant", content: "Read ", delta: true },
			{ type: "message", timestamp: ts, role: "assistant", content: "it.", delta: true },
			{
				type: "result",
				timestamp: ts,
				status: "success",
				stats: {
					total_tokens: 130,
					input_tokens: 100,
					output_tokens: 30,
					cached: 40,
					input: 60,
					duration_ms: 900,
					tool_calls: 2,
					models: {},
				},
			},
		]);
		expect(run.activity).toEqual([
			"→ read_file src/app.ts",
			"→ run_shell_command rm -rf /",
			"✗ run_shell_command failed: denied",
		]);
		expect(run.reply()).toEqual({
			text: "Read it.",
			stopReason: "end_turn",
			usage: { inputTokens: 60, outputTokens: 30, cachedReadTokens: 40, totalTokens: 130 },
			billing: "plan",
		});
	});

	it("fails an error result with its message", () => {
		const run = parse("gemini", [
			{ type: "result", status: "error", error: { type: "api", message: "quota exhausted" } },
		]);
		expect(run.reply).toThrow("gemini (headless) failed: quota exhausted");
	});
});

describe("the OpenCode route", () => {
	// sst/opencode `packages/cli/src/run/noninteractive.ts` (the `--format json` emitter), `opencode run --help` 2.0.32.
	it("has an argv and a parser, but no task may run through it: its permission defaults cannot be restricted", () => {
		const route = headlessRoute("opencode")!;
		expect([...route.args]).toEqual(["run", "--format", "json", "--standalone"]);
		for (const isolated of [true, false])
			expect(() => resolve("opencode", isolated)).toThrow("has no headless route a task may run through");
		expect(route.permission({ isolated: true })).toHaveProperty("refuse");
	});

	it("reads the emitted events: text, tool calls and errors, step usage", () => {
		const run = parse("opencode", [
			{ type: "step_start", timestamp: 1, sessionID: "s", part: { type: "step-start" } },
			{
				type: "tool_use",
				timestamp: 2,
				sessionID: "s",
				part: {
					type: "tool",
					tool: "read",
					state: { status: "completed", input: { filePath: "/work/task/a.ts" }, output: "x" },
				},
			},
			{ type: "text", timestamp: 3, sessionID: "s", part: { type: "text", text: "All read." } },
			{
				type: "step_finish",
				timestamp: 4,
				sessionID: "s",
				part: {
					type: "step-finish",
					reason: "stop",
					cost: 0.01,
					tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 3, write: 0 } },
				},
			},
		]);
		expect(run.activity).toEqual(["→ read a.ts"]);
		expect(run.reply()).toEqual({
			text: "All read.",
			stopReason: "end_turn",
			usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 3, totalTokens: 18 },
			cost: 0.01,
			billing: "plan",
		});
		expect(parse("opencode", [{ type: "error", timestamp: 1, error: { message: "model not found" } }]).reply).toThrow(
			"model not found",
		);
	});
});

describe("the Cursor route", () => {
	// https://cursor.com/docs/cli/headless ("File modification in scripts"): print mode "writes to files in your
	// workspace even without --force"; https://cursor.com/docs/cli/reference/output-format for the stream.
	it("runs agent mode only in the task's own worktree; a read-only caller's task runs in `--mode ask` anywhere", () => {
		const route = headlessRoute("cursor")!;
		expect([...route.args]).toEqual(["-p", "--output-format", "stream-json", "--sandbox", "enabled"]);
		expect(route.task).toBe("argv");
		expect(resolve("cursor", true, "gpt-5").args).toEqual(["--model", "gpt-5"]);
		expect(resolveHeadless({ ...scope("cursor", false), readOnly: true }).args).toEqual(["--mode", "ask"]);
		expect(resolveHeadless({ ...scope("cursor", true), readOnly: true }).args).toEqual(["--mode", "ask"]);
	});

	it("refuses a write task in the session's folder before any CLI starts", () => {
		expect(() => resolve("cursor", false)).toThrow(
			/cursor cannot run this task headless: .*own worktree.*isolate: true/,
		);
	});

	it("reads the documented stream: the result, tool calls started, the failure case", () => {
		const session = "c6b62c6f-7ead-4fd6-9922-e952131177ff";
		const run = parse("cursor", [
			{
				type: "system",
				subtype: "init",
				apiKeySource: "login",
				cwd: "/work/task",
				session_id: session,
				model: "Claude 4 Sonnet",
				permissionMode: "default",
			},
			{
				type: "user",
				message: { role: "user", content: [{ type: "text", text: "Read README.md" }] },
				session_id: session,
			},
			{
				type: "tool_call",
				subtype: "started",
				call_id: "c1",
				tool_call: { readToolCall: { args: { path: "/work/task/README.md" } } },
				session_id: session,
			},
			{
				type: "tool_call",
				subtype: "completed",
				call_id: "c1",
				tool_call: {
					readToolCall: { args: { path: "/work/task/README.md" }, result: { success: { totalLines: 54 } } },
				},
				session_id: session,
			},
			{
				type: "tool_call",
				subtype: "started",
				call_id: "c2",
				tool_call: { function: { name: "grep", arguments: "{}" } },
				session_id: session,
			},
			{
				type: "assistant",
				message: { role: "assistant", content: [{ type: "text", text: "It is a summary." }] },
				session_id: session,
			},
			{
				type: "result",
				subtype: "success",
				duration_ms: 1234,
				duration_api_ms: 1234,
				is_error: false,
				result: "It is a summary.",
				session_id: session,
			},
		]);
		expect(run.activity).toEqual(["→ read README.md", "→ grep"]);
		expect(run.reply()).toEqual({
			text: "It is a summary.",
			stopReason: "end_turn",
			billing: "plan",
			sessionId: session,
		});
		expect(parse("cursor", [], 1, "Not authenticated. Run agent login").reply).toThrow("Not authenticated");
		expect(parse("cursor", [], 1, "boom").reply).toThrow("ended without a result: boom");
	});

	it("is detected by its `cursor-agent` CLI only: never started as an ACP adapter, status read from `status`", () => {
		const spec = runnerSpec("cursor")!;
		expect([spec.cli, spec.headlessOnly]).toEqual(["cursor-agent", true]);
		const home = tmp("octocode-cursor-bin-");
		fs.writeFileSync(path.join(home, "cursor-agent"), "#!/bin/sh\n", { mode: 0o755 });
		expect(installedAcpAgents({ PATH: home }).map((agent) => agent.vendor)).not.toContain("cursor");
		expect(spec.status!.read("Not authenticated", 1)).toEqual({ signedIn: false });
		expect(spec.status!.read("Logged in as a@b.c", 0)).toMatchObject({ signedIn: true });
		expect(spec.status!.read("something else", 0)).toBeUndefined();
	});

	it("launches headless when signed in, even with a `cursor-agent` on PATH, and refuses when signed out", () => {
		const home = tmp("octocode-cursor-launch-");
		const command = path.join(home, "cursor-agent");
		fs.writeFileSync(command, "#!/bin/sh\n", { mode: 0o755 });
		vi.stubEnv("PATH", home);
		const state: RunnerState = {
			id: "cursor",
			name: "Cursor CLI",
			cli: true,
			adapter: false,
			auth: { signedIn: true },
		};
		expect(launchOf("cursor", [state])).toMatchObject({
			command,
			route: "headless",
			args: [...headlessRoute("cursor")!.args],
		});
		expect(() => launchOf("cursor", [{ ...state, auth: { signedIn: false } }])).toThrow();
	});
});

/** A stand-in CLI (never a vendor's): journals argv, folder and stdin, then prints the given lines. */
function fakeCli(name: string, lines: readonly object[]) {
	const home = tmp("octocode-headless-routes-");
	const journal = path.join(home, "journal.json");
	const body = `
const fs = require("node:fs");
let stdin = "";
process.stdin.on("data", (chunk) => (stdin += chunk));
process.stdin.on("end", () => {
	fs.writeFileSync(${JSON.stringify(journal)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), stdin }));
	for (const line of ${JSON.stringify(lines)}) process.stdout.write(JSON.stringify(line) + "\\n");
});
`;
	const command = path.join(home, name);
	fs.writeFileSync(command, `#!${process.execPath}\n${body}`, { mode: 0o755 });
	return {
		command,
		journal: () => JSON.parse(fs.readFileSync(journal, "utf8")) as { args: string[]; cwd: string; stdin: string },
	};
}

const turn = (runner: string, command: string, cwd: string, sessionCwd: string, extra: { readOnly?: boolean } = {}) =>
	headlessTurn({
		...extra,
		runner,
		command,
		args: [...headlessRoute(runner)!.args],
		billing: "plan",
		cwd,
		sessionCwd,
		text: "Review src. Secret: sk-donotputmeinargv",
		signal: new AbortController().signal,
		onActivity: () => undefined,
		awake: () => undefined,
	});

describe("headless turns through the table", () => {
	it("runs Codex with the task on stdin, in the task folder, under the sandbox of its scope", async () => {
		const cli = fakeCli("codex", [
			{ type: "item.completed", item: { id: "i", type: "agent_message", text: "ok" } },
			{
				type: "turn.completed",
				usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
			},
		]);
		const cwd = tmp("octocode-codex-task-");
		expect((await turn("codex", cli.command, cwd, tmp("octocode-codex-session-"))).text).toBe("ok");
		const run = cli.journal();
		expect(run.args).toEqual([...headlessRoute("codex")!.args, "--sandbox", "workspace-write"]);
		expect(fs.realpathSync(run.cwd)).toBe(fs.realpathSync(cwd));
		expect(run.stdin).toContain("sk-donotputmeinargv");
		expect(JSON.stringify(run.args)).not.toContain("sk-donotputmeinargv");
	});

	it("runs Cursor with the task as the argument after `--`, read-only for a read-only caller in the session's folder", async () => {
		const cli = fakeCli("cursor-agent", [{ type: "result", subtype: "success", is_error: false, result: "fine" }]);
		const cwd = tmp("octocode-cursor-same-");
		expect((await turn("cursor", cli.command, cwd, cwd, { readOnly: true })).text).toBe("fine");
		const args = cli.journal().args;
		expect(args.slice(0, -2)).toEqual([...headlessRoute("cursor")!.args, "--mode", "ask"]);
		expect(args.slice(-2)).toEqual(["--", "Review src. Secret: sk-donotputmeinargv"]);
		expect(cli.journal().stdin).toBe("");
	});

	it("refuses a runner whose route a task may not run through, before starting anything", async () => {
		const cli = fakeCli("opencode", []);
		await expect(turn("opencode", cli.command, tmp("octocode-oc-"), tmp("octocode-oc-s-"))).rejects.toThrow(
			"no headless route",
		);
	});
});
