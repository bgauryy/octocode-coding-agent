import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectAcp } from "../../src/octocode/external/acp-host.ts";
import { HEADLESS_ROUTE, headlessReady, runnerRoute } from "../../src/octocode/external/runner-headless.ts";
import { launchOf, type RunnerLaunch, runnerTurn } from "../../src/octocode/external/runner-session.ts";
import type { RunnerState } from "../../src/octocode/external/runner-status.ts";
import { processAlive } from "../../src/octocode/shared/process.ts";
import { fakeCtx } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

const signedIn = (adapter: boolean): RunnerState => ({
	id: "claude-code",
	name: "Claude Code",
	cli: true,
	adapter,
	version: "2.1.322",
	auth: { signedIn: true, method: "claude.ai", billing: "plan" },
	checkedAt: Date.now(),
});

/**
 * A stand-in `claude` (never the real CLI): it journals its argv, folder, stdin and environment names, then plays one
 * scenario of the `-p --output-format stream-json` event stream.
 */
function fakeClaude(scenario: "report" | "signed-out" | "crash" | "hang") {
	const home = tmp("octocode-headless-");
	const bin = path.join(home, "bin");
	fs.mkdirSync(bin);
	const journal = path.join(home, "journal.jsonl");
	const body = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const journal = ${JSON.stringify(journal)};
const log = (entry) => fs.appendFileSync(journal, JSON.stringify(entry) + "\\n");
const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
let stdin = "";
process.stdin.on("data", (chunk) => (stdin += chunk));
process.stdin.on("end", () => {
	log({ args: process.argv.slice(2), cwd: process.cwd(), stdin, env: Object.keys(process.env), pid: process.pid });
	const scenario = ${JSON.stringify(scenario)};
	out({ type: "system", subtype: "init", cwd: process.cwd(), tools: ["Read"] });
	if (scenario === "report") {
		out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: process.cwd() + "/src/app.ts" } }] } });
		out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "export {}" }] } });
		out({ type: "assistant", message: { content: [{ type: "text", text: "done: read it" }] } });
		out({
			type: "result", subtype: "success", is_error: false, result: "done: the runner read src/app.ts\\nNoticed: none",
			stop_reason: "end_turn", total_cost_usd: 0.42,
			usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
			permission_denials: [{ tool_name: "Bash", tool_use_id: "t2", tool_input: { command: "rm -rf /" } }],
		});
	} else if (scenario === "signed-out") {
		out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
		process.exit(1);
	} else if (scenario === "crash") {
		process.stderr.write("fatal: bad key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\\n");
		process.exit(2);
	} else {
		const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		log({ grandchild: grandchild.pid });
		setInterval(() => {}, 1000);
	}
});
`;
	fs.writeFileSync(path.join(bin, "claude"), `#!${process.execPath}\n${body}`, { mode: 0o755 });
	const entries = () =>
		fs.existsSync(journal)
			? fs
					.readFileSync(journal, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as Record<string, unknown>)
			: [];
	return { bin, entries, command: path.join(bin, "claude") };
}

const headlessDeps = (launch: RunnerLaunch) => ({
	launch: () => launch,
	connect: connectAcp,
	permission: () => async () => ({ outcome: { outcome: "cancelled" as const } }),
});

function turn(
	launch: RunnerLaunch,
	options: { cwd: string; sessionCwd?: string; signal?: AbortSignal; model?: string },
) {
	const activity: string[] = [];
	const started: number[] = [];
	const reply = runnerTurn(
		{
			runner: "claude-code",
			...(options.model ? { model: options.model } : {}),
			cwd: options.cwd,
			text: "Read src/app.ts and report. Secret: sk-ant-api03-donotputmeinargv",
			signal: options.signal ?? new AbortController().signal,
			onActivity: (line) => activity.push(line),
			onStart: (pid) => started.push(pid),
			ctx: fakeCtx({ cwd: options.sessionCwd ?? options.cwd }),
		},
		headlessDeps(launch),
	);
	return { reply, activity, started };
}

describe("the headless route", () => {
	it("is chosen only for a signed-in Claude Code whose adapter is missing, and the row names it", () => {
		expect(headlessReady(signedIn(false))).toBe(true);
		expect(runnerRoute(signedIn(false))).toBe(HEADLESS_ROUTE);
		expect(runnerRoute(signedIn(true))).toBeUndefined();
		expect(headlessReady({ ...signedIn(false), auth: { signedIn: false } })).toBe(false);
		expect(headlessReady({ ...signedIn(false), cli: false })).toBe(false);
		expect(headlessReady({ ...signedIn(false), id: "codex" })).toBe(false);
	});

	it("launches the CLI headless without an adapter, the adapter when it is there, and refuses a signed-out runner", () => {
		const claude = fakeClaude("report");
		vi.stubEnv("PATH", claude.bin);
		expect(launchOf("claude-code", [signedIn(false)])).toEqual({
			command: claude.command,
			args: ["-p", "--output-format", "stream-json", "--verbose"],
			billing: "plan",
			route: "headless",
		});
		fs.writeFileSync(path.join(claude.bin, "claude-agent-acp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		expect(launchOf("claude-code", [signedIn(true)])).toEqual({
			command: path.join(claude.bin, "claude-agent-acp"),
			args: [],
			billing: "plan",
		});
		expect(() => launchOf("claude-code", [{ ...signedIn(false), auth: { signedIn: false } }])).toThrow(
			/not connected.*\/providers/,
		);
	});
});

describe("a runner's turn headless", () => {
	it("sends the task on stdin in the worktree, streams tool calls to the row and returns the report with usage and cost", async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-fixture");
		vi.stubEnv("OPENAI_API_KEY", "sk-fixture");
		const claude = fakeClaude("report");
		const worktree = tmp("octocode-headless-worktree-");
		const session = tmp("octocode-headless-session-");
		const run = turn(
			{
				command: claude.command,
				args: ["-p", "--output-format", "stream-json", "--verbose"],
				billing: "plan",
				route: "headless",
			},
			{ cwd: worktree, sessionCwd: session, model: "opus" },
		);
		expect(await run.reply).toEqual({
			text: "done: the runner read src/app.ts\nNoticed: none",
			stopReason: "end_turn",
			usage: { inputTokens: 1000, outputTokens: 200, cachedReadTokens: 50, totalTokens: 1250 },
			cost: 0.42,
			billing: "plan",
		});
		expect(run.activity).toEqual(["→ Read src/app.ts", "✗ denied Bash"]);
		const [started] = claude.entries();
		expect(started.pid).toBe(run.started[0]);
		expect(fs.realpathSync(String(started.cwd))).toBe(fs.realpathSync(worktree));
		expect(started.args).toEqual([
			"-p",
			"--output-format",
			"stream-json",
			"--verbose",
			"--permission-mode",
			"acceptEdits",
			"--permission-prompts",
			"none",
			"--model",
			"opus",
		]);
		expect(started.stdin).toContain("Secret: sk-ant-api03-donotputmeinargv");
		expect(JSON.stringify(started.args)).not.toContain("sk-ant");
		expect(started.env).not.toContain("ANTHROPIC_API_KEY");
		expect(started.env).not.toContain("OPENAI_API_KEY");
	});

	it("runs a task in the session's own folder without accepting edits", async () => {
		const claude = fakeClaude("report");
		const cwd = tmp("octocode-headless-same-");
		await turn({ command: claude.command, args: ["-p"], billing: "plan", route: "headless" }, { cwd }).reply;
		expect(claude.entries()[0].args).toEqual(["-p", "--permission-mode", "manual", "--permission-prompts", "none"]);
	});

	it("says a signed-out CLI is signed out and drops its cached check", async () => {
		const claude = fakeClaude("signed-out");
		const agentDir = tmp("octocode-headless-agent-");
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", agentDir);
		const cache = path.join(agentDir, "external-runners.json");
		fs.writeFileSync(cache, JSON.stringify({ "claude-code": { stamp: "x", state: signedIn(false) } }));
		const cwd = tmp("octocode-headless-out-");
		await expect(
			turn({ command: claude.command, args: ["-p"], billing: "plan", route: "headless" }, { cwd }).reply,
		).rejects.toThrow(/claude-code is signed out: sign in with \/providers/);
		expect(JSON.parse(fs.readFileSync(cache, "utf8"))).toEqual({});
	});

	it("reports an exit without a result with its stderr, secrets redacted", async () => {
		const claude = fakeClaude("crash");
		const cwd = tmp("octocode-headless-crash-");
		const failure = await turn(
			{ command: claude.command, args: ["-p"], billing: "plan", route: "headless" },
			{ cwd },
		).reply.then(
			() => undefined,
			(error: Error) => error.message,
		);
		expect(failure).toMatch(/claude-code \(headless\) ended without a result: fatal: bad key/);
		expect(failure).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
	});

	it("ends the whole process tree when the task is stopped", async () => {
		const claude = fakeClaude("hang");
		const cwd = tmp("octocode-headless-stop-");
		const stop = new AbortController();
		const run = turn(
			{ command: claude.command, args: ["-p"], billing: "plan", route: "headless" },
			{ cwd, signal: stop.signal },
		);
		await vi.waitFor(() => expect(claude.entries().some((entry) => entry.grandchild)).toBe(true), { timeout: 10_000 });
		const pid = Number(claude.entries()[0].pid);
		const grandchild = Number(claude.entries().find((entry) => entry.grandchild)!.grandchild);
		stop.abort(new Error("Subagent cancelled"));
		await expect(run.reply).rejects.toThrow("Subagent cancelled");
		await vi.waitFor(() => {
			expect(processAlive(pid)).toBe(false);
			expect(processAlive(grandchild)).toBe(false);
		});
	});
});

describe("a Claude Code CLI without its ACP adapter", () => {
	it("counts as connected through the headless route, and only Claude Code has one", async () => {
		const { isConnected } = await import("../../src/octocode/external/runner-status.ts");
		const { runnerRoute } = await import("../../src/octocode/external/runner-headless.ts");
		const claude = { id: "claude-code", name: "Claude Code", cli: true, adapter: false, auth: { signedIn: true } };
		expect(isConnected(claude)).toBe(true);
		expect(runnerRoute(claude)).toBe("headless (adapter missing)");
		expect(isConnected({ ...claude, auth: { signedIn: false } })).toBe(false);
		expect(isConnected({ ...claude, id: "codex", name: "Codex CLI" })).toBe(false);
	});
});
