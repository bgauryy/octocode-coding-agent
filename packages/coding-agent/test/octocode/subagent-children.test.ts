import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeWork, unreportedWork } from "../../src/octocode/sessions/work.ts";
import { tildePath } from "../../src/octocode/shared/home.ts";
import { sessionChildren } from "../../src/octocode/shared/session-children.ts";
import { describeChild, resumableChild, resumedTask } from "../../src/octocode/subagents/children.ts";
import { runFooter } from "../../src/octocode/subagents/tracking.ts";
import { shortPath } from "../../src/octocode/shared/format.ts";
import { agentsCommand } from "../../src/octocode/subagents/command.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const at = new Date().toISOString();

/** An `agent` task call and its result as a session records them; `details` are the run's `RunDetails`. */
function agentCall(callId: string, input: Record<string, unknown>, details: Record<string, unknown>): unknown[] {
	return [
		{
			type: "message",
			timestamp: at,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: callId, name: "agent", arguments: { type: "task", input } }],
			},
		},
		{
			type: "message",
			timestamp: at,
			message: {
				role: "toolResult",
				toolCallId: callId,
				toolName: "agent",
				isError: false,
				content: [{ type: "text", text: "…" }],
				details: { ...details, agentType: "task" },
			},
		},
	];
}

/** A background child's report message. */
const report = (details: Record<string, unknown>) => ({
	type: "custom_message",
	timestamp: at,
	customType: "octocode-agent-result",
	content: "report",
	details,
});

/** A child's scratch folder with its saved transcript (and its report file when `withReport`). */
function scratch(id: string, withReport = false): { dir: string; session: string; file: string } {
	const dir = path.join(tmp("octocode-children-"), id);
	const session = path.join(dir, "session");
	fs.mkdirSync(session, { recursive: true });
	const file = path.join(session, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	fs.writeFileSync(file, "{}\n");
	if (withReport) fs.writeFileSync(path.join(dir, "report.md"), "done: all of it\n");
	return { dir, session, file };
}

describe("a resumed session's unreported subagents", () => {
	it("names the child's transcript folder without presenting an unversioned file as its pending report", () => {
		const child = scratch("general-ab12", true);
		const entries = agentCall(
			"call-1",
			{ goal: "Review the parser", task: "Review it", background: true },
			{
				id: "general-ab12",
				profile: "general",
				goal: "Review the parser",
				status: "background",
				session: { id: "general-ab12", dir: child.session },
			},
		);
		const [work] = unreportedWork(entries);
		expect(describeWork(work)).toBe(
			`general-ab12 (goal "Review the parser", transcript folder ${tildePath(child.session)})`,
		);
	});

	it("keeps the newest continuation's status when an earlier report arrives late", () => {
		const entries = [
			...agentCall(
				"first",
				{ goal: "First" },
				{ id: "general-repeat", profile: "general", goal: "First", status: "background", runId: "run-1" },
			),
			...agentCall(
				"second",
				{ goal: "Second" },
				{ id: "general-repeat", profile: "general", goal: "Second", status: "background", runId: "run-2" },
			),
			report({ id: "general-repeat", status: "done", outcome: "done", runId: "run-1" }),
		];
		expect(sessionChildren(entries)).toMatchObject([{ goal: "Second", status: "background" }]);
		expect(sessionChildren(entries)[0]?.outcome).toBeUndefined();
		expect(
			sessionChildren([
				...entries,
				report({ id: "general-repeat", status: "done", outcome: "partial", runId: "run-2" }),
			]),
		).toMatchObject([{ outcome: "partial" }]);
	});

	it("accepts a later message-based continuation's report without another task launch", () => {
		const entries = [
			...agentCall(
				"first",
				{ goal: "First" },
				{ id: "general-message", profile: "general", status: "background", runId: "run-1", startedAt: 1 },
			),
			report({ id: "general-message", status: "done", outcome: "blocked", runId: "run-1", startedAt: 1 }),
			report({ id: "general-message", status: "done", outcome: "done", runId: "run-2", startedAt: 2 }),
			report({ id: "general-message", status: "done", outcome: "blocked", runId: "run-1", startedAt: 1 }),
		];
		expect(sessionChildren(entries)).toMatchObject([{ outcome: "done" }]);
		const continued = [
			...entries,
			...agentCall(
				"third",
				{},
				{ id: "general-message", profile: "general", status: "background", runId: "run-3", startedAt: 3 },
			),
			report({ id: "general-message", status: "done", outcome: "done", runId: "unseen-old-run", startedAt: 1 }),
		];
		expect(sessionChildren(continued)).toMatchObject([{ status: "background" }]);
	});

	it("ignores a delayed legacy report after a continuation has a run identity", () => {
		const entries = [
			...agentCall(
				"current",
				{},
				{ id: "general-migrated", profile: "general", status: "background", runId: "current-run", startedAt: 2 },
			),
			report({ id: "general-migrated", status: "done", outcome: "blocked" }),
		];
		expect(sessionChildren(entries)).toMatchObject([{ status: "background" }]);
		expect(
			sessionChildren([
				...entries,
				report({ id: "general-migrated", status: "done", outcome: "done", runId: "current-run", startedAt: 2 }),
			]),
		).toMatchObject([{ outcome: "done" }]);
	});
});

describe("a finished child's report", () => {
	it("keeps a failed foreground child with a saved transcript available to resume", () => {
		const child = scratch("general-failed");
		const entries = agentCall(
			"failed",
			{ goal: "Recover", task: "Recover" },
			{
				id: "general-failed",
				profile: "general",
				goal: "Recover",
				status: "failed",
				outcome: "failed",
				session: { id: "general-failed", file: child.file },
			},
		);
		(entries[1] as { message: { isError: boolean } }).message.isError = true;
		expect(sessionChildren(entries)).toMatchObject([{ id: "general-failed", status: "failed" }]);
		expect(resumableChild(entries, "general-failed", new Set()).session.dir).toBe(child.session);
	});

	it("names its saved transcript whether it succeeded or failed, so the parent can read or resume it", () => {
		const child = scratch("general-ok");
		const details = { session: { id: "general-ok", dir: child.session, file: child.file } } as Parameters<
			typeof runFooter
		>[0];
		expect(runFooter(details, false)).toContain(`Session general-ok: ${shortPath(child.file)}`);
		expect(runFooter(details, true)).toContain(`Session general-ok: ${shortPath(child.file)}`);
		// Before its file is known the id alone says nothing the report does not: only a failure names it.
		expect(runFooter({ session: { id: "general-ok" } } as Parameters<typeof runFooter>[0], false)).not.toContain(
			"Session",
		);
	});
});

describe("the subagents a session started", () => {
	const foreground = scratch("review-fg");
	const background = scratch("general-bg", true);
	const entries = [
		...agentCall(
			"call-1",
			{ goal: "Review the diff", task: "Review", profile: "review" },
			{
				id: "review-fg",
				profile: "review",
				goal: "Review the diff",
				status: "done",
				outcome: "done",
				session: { id: "review-fg", file: foreground.file },
			},
		),
		...agentCall(
			"call-2",
			{ goal: "Fix the build", task: "Fix", background: true },
			{
				id: "general-bg",
				profile: "general",
				goal: "Fix the build",
				status: "background",
				session: { id: "general-bg", dir: background.session },
			},
		),
		...agentCall(
			"call-3",
			{ goal: "Try a worktree", task: "Try", isolate: true },
			{
				id: "general-iso",
				profile: "general",
				goal: "Try a worktree",
				status: "failed",
				session: { id: "general-iso" },
			},
		),
		report({
			id: "general-bg",
			status: "stopped",
			summary: "Stopped",
			session: { id: "general-bg", file: background.file },
		}),
	];

	it("lists each child once with its profile, goal, latest status, report and transcript", () => {
		expect(sessionChildren(entries)).toEqual([
			{
				id: "review-fg",
				profile: "review",
				goal: "Review the diff",
				status: "done",
				outcome: "done",
				transcript: foreground.file,
			},
			{
				id: "general-bg",
				profile: "general",
				goal: "Fix the build",
				status: "stopped",
				transcript: background.file,
				report: path.join(background.dir, "report.md"),
			},
			{ id: "general-iso", profile: "general", goal: "Try a worktree", status: "failed", isolated: true },
		]);
		expect(describeChild(sessionChildren(entries)[1])).toBe(
			`general-bg (general, goal "Fix the build", stopped, transcript ${tildePath(background.file)}, report ${tildePath(path.join(background.dir, "report.md"))})`,
		);
	});

	it("resumes only a child recorded in this session, refusing an unknown id with the ones it can resume", () => {
		expect(() => resumableChild(entries, "general-other", new Set())).toThrow(
			/No subagent "general-other" in this session\. Its subagents: review-fg \(review, goal "Review the diff", done/,
		);
		expect(() => resumableChild(entries, "general-iso", new Set())).toThrow(/ran in an isolated worktree/);
		expect(() => resumableChild(entries, "general-bg", new Set(["general-bg"]))).toThrow(/general-bg is running/);
	});

	it("are listed by `/agents history` for the user, each with its transcript and report", async () => {
		const command = agentsCommand(new Team(fakeHost().api), new Map());
		const ctx = fakeCtx({ cwd: tmp() });
		Object.assign(ctx.sessionManager, { getEntries: () => entries });
		await command.handler("history", ctx);
		expect(ctx.ui.notes.at(-1)?.message).toBe(sessionChildren(entries).map(describeChild).join("\n"));
		Object.assign(ctx.sessionManager, { getEntries: () => [] });
		await command.handler("history", ctx);
		expect(ctx.ui.notes.at(-1)?.message).toBe("No subagents in this session.");
	});

	it("continues on the recorded transcript: its folder and the child's id are the launch's session", () => {
		expect(resumableChild(entries, "general-bg", new Set())).toMatchObject({
			child: { id: "general-bg", profile: "general", goal: "Fix the build" },
			session: { dir: background.session, id: "general-bg" },
		});
		fs.rmSync(foreground.file);
		expect(() => resumableChild(entries, "review-fg", new Set())).toThrow(/transcript .* is gone/);
	});
});

describe("the task a continued child runs", () => {
	it("keeps the child's recorded profile, browser mode and model unless the call names its own", () => {
		const { file } = scratch("reviewer-m1");
		const entries = agentCall(
			"call-m1",
			{ profile: "reviewer", goal: "Review", headless: false },
			{
				id: "reviewer-m1",
				profile: "reviewer",
				goal: "Review",
				status: "done",
				model: "anthropic/claude-haiku:low",
				session: { id: "reviewer-m1", file },
			},
		);
		const { child } = resumableChild(entries, "reviewer-m1", new Set());
		const available = [{ provider: "anthropic", id: "claude-haiku" }];
		type Task = { goal: string; resume?: string; profile?: string; headless?: boolean; model?: string };
		const again: Task = { goal: "Again", resume: "reviewer-m1" };
		expect(resumedTask(again, child, available)).toMatchObject({
			profile: "reviewer",
			headless: false,
			model: "anthropic/claude-haiku:low",
		});
		const chosen: Task = { goal: "Again", model: "opencode/qwen-coder", headless: true };
		expect(resumedTask(chosen, child, available)).toMatchObject({
			model: "opencode/qwen-coder",
			headless: true,
		});
		// A recorded model no longer configured is not forced on the run: the profile or parent routing applies.
		expect(resumedTask(again, child, []).model).toBeUndefined();
	});
});
