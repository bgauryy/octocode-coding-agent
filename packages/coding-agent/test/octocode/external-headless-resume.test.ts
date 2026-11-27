import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { headlessRoute } from "../../src/octocode/external/headless/routes.ts";
import { headlessTurn, resolveHeadless } from "../../src/octocode/external/runner-headless.ts";
import { resumableChild } from "../../src/octocode/subagents/children.ts";
import { runnerOf } from "../../src/octocode/subagents/runner-task.ts";
import { tmp } from "./helpers.ts";

const ID = "0199a213-81c0-7800-8aa1-bbab2a035a53";

const parsed = (runner: string, lines: readonly object[]) => {
	const parser = headlessRoute(runner)!.parser({ runner, roots: ["/w"], onActivity: () => undefined });
	for (const line of lines) parser.line(line as Record<string, unknown>);
	return parser.reply(0, "");
};

describe("resume arguments per vendor", () => {
	// https://code.claude.com/docs/en/headless#continue-conversations and `claude --help` 2.1.330 (`-r, --resume <id>`)
	it("Claude Code resumes with --resume <id> and keeps its own permission mapping", () => {
		const resolved = resolveHeadless({ runner: "claude-code", cwd: "/w/t", sessionCwd: "/w", resume: ID });
		expect(resolved.args).toEqual(["--permission-mode", "acceptEdits", "--permission-prompts", "none", "--resume", ID]);
	});

	// https://developers.openai.com/codex/noninteractive#resume-a-non-interactive-session, `codex exec resume --help` 0.166.0
	it("Codex resumes with the `resume <id> -` subcommand after the exec options, task on stdin", () => {
		const resolved = resolveHeadless({ runner: "codex", cwd: "/w/t", sessionCwd: "/w", resume: ID });
		expect(resolved.args).toEqual(["--sandbox", "workspace-write"]);
		expect(resolved.trailing).toEqual(["resume", ID, "-"]);
		expect(headlessRoute("codex")!.args).not.toContain("--ephemeral");
	});

	// https://cursor.com/docs/cli/reference/parameters (`--resume [chatId]`)
	it("Cursor resumes with --resume <chatId>", () => {
		const resolved = resolveHeadless({ runner: "cursor", cwd: "/w/t", sessionCwd: "/w", resume: ID });
		expect(resolved.args).toEqual(["--resume", ID]);
	});

	// `gemini --help` 0.64.0: --resume takes "latest" or an index, never an id.
	it("Gemini refuses a resume: its flag names no session id", () => {
		expect(() => resolveHeadless({ runner: "gemini", cwd: "/w", sessionCwd: "/w", resume: ID })).toThrow(
			/gemini cannot resume its session: .*position/,
		);
	});

	it("never lets a value that is not a session id reach argv", () => {
		for (const bad of ["--dangerously-bypass-approvals-and-sandbox", "a b", "", "x"])
			expect(() => resolveHeadless({ runner: "claude-code", cwd: "/w", sessionCwd: "/w", resume: bad })).toThrow(
				/not a session id/,
			);
	});
});

describe("capturing the vendor session id", () => {
	it("reads Claude's result session_id, Codex's thread_id and Cursor's session_id", () => {
		expect(
			parsed("claude-code", [{ type: "result", subtype: "success", is_error: false, result: "r", session_id: ID }])
				.sessionId,
		).toBe(ID);
		expect(
			parsed("codex", [
				{ type: "thread.started", thread_id: ID },
				{ type: "item.completed", item: { type: "agent_message", text: "ok" } },
				{ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
			]).sessionId,
		).toBe(ID);
		expect(
			parsed("cursor", [
				{ type: "system", subtype: "init", session_id: ID },
				{ type: "result", subtype: "success", is_error: false, result: "r" },
			]).sessionId,
		).toBe(ID);
	});

	it("reports none when the stream names none", () => {
		expect(parsed("claude-code", [{ type: "result", subtype: "success", result: "r" }]).sessionId).toBeUndefined();
	});
});

describe("a resumed turn through a stand-in CLI", () => {
	it("runs `codex exec ... resume <id> -` with the task on stdin", async () => {
		const home = tmp("octocode-resume-cli-");
		const journal = path.join(home, "j.json");
		const command = path.join(home, "codex");
		fs.writeFileSync(
			command,
			`#!${process.execPath}\nlet s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{require("fs").writeFileSync(${JSON.stringify(journal)},JSON.stringify({args:process.argv.slice(2),stdin:s}));for(const l of [{type:"thread.started",thread_id:${JSON.stringify(ID)}},{type:"item.completed",item:{type:"agent_message",text:"again"}},{type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}])console.log(JSON.stringify(l))})`,
			{ mode: 0o755 },
		);
		const cwd = tmp("octocode-resume-cwd-");
		const reply = await headlessTurn({
			runner: "codex",
			command,
			args: [...headlessRoute("codex")!.args],
			cwd,
			sessionCwd: cwd,
			text: "continue",
			resume: ID,
			signal: new AbortController().signal,
			onActivity: () => undefined,
			awake: () => undefined,
		});
		expect(reply).toMatchObject({ text: "again", sessionId: ID });
		const run = JSON.parse(fs.readFileSync(journal, "utf8")) as { args: string[]; stdin: string };
		expect(run.args).toEqual([...headlessRoute("codex")!.args, "--sandbox", "read-only", "resume", ID, "-"]);
		expect(run.stdin).toBe("continue");
	});
});

describe("Cursor write tasks (read-only signal)", () => {
	it("refuses a write task in the session's folder, runs a read-only caller's task in ask mode", () => {
		expect(() => resolveHeadless({ runner: "cursor", cwd: "/w", sessionCwd: "/w" })).toThrow(/own worktree/);
		expect(resolveHeadless({ runner: "cursor", cwd: "/w", sessionCwd: "/w", readOnly: true }).args).toEqual([
			"--mode",
			"ask",
		]);
	});

	it("keeps a read-only caller out of every writing mode", () => {
		const args = (runner: string) =>
			resolveHeadless({ runner, cwd: "/w/t", sessionCwd: "/w", readOnly: true }).args.join(" ");
		expect(args("claude-code")).toContain("--permission-mode manual");
		expect(args("codex")).toContain("--sandbox read-only");
		expect(args("gemini")).toContain("--approval-mode default");
	});
});

describe("resuming a runner child", () => {
	const entries = (details: Record<string, unknown>) => [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "agent",
				details: { id: "c1", profile: "runner", goal: "g", status: "done", ...details },
			},
		},
	];

	it("runnerOf takes the child's runner and refuses another", () => {
		expect(runnerOf(undefined, { id: "c1", runner: "codex" })).toBe("codex");
		expect(runnerOf("codex", { id: "c1", runner: "codex" })).toBe("codex");
		expect(() => runnerOf("claude-code", { id: "c1", runner: "codex" })).toThrow(/ran in codex/);
		expect(() => runnerOf("codex", { id: "c1" })).toThrow(/not a codex task/);
		expect(runnerOf(undefined, undefined)).toBeUndefined();
	});

	it("an unknown child still reports what the session started", () => {
		expect(() => resumableChild(entries({}), "nope", new Set())).toThrow(/No subagent "nope"/);
	});
});
