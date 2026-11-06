import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reportContract } from "../../src/octocode/instructions/report.ts";
import { identityBlock } from "../../src/octocode/instructions/task.ts";
import { CONTINUITY_TYPE } from "../../src/octocode/compaction/continuity.ts";
import { shortPath } from "../../src/octocode/shared/format.ts";
import { IDENTITY_ENTRY } from "../../src/octocode/subagents/identity-reminder.ts";
import type { Identity } from "../../src/octocode/subagents/process/env.ts";
import { reportStatus } from "../../src/octocode/subagents/report.ts";
import { admitResultSchema } from "../../src/octocode/subagents/result-schema.ts";
import { type Fixture, fixture } from "./agent-context/capture.ts";
import { assign, long, longTask, runChild } from "./agent-context/child-run.ts";

/**
 * A child's identity after its own compaction, in real sessions on a scripted model: `agent-context/child-run.ts` starts
 * each child process as `subagents/tool.ts` starts it, and a task resume reopens its session file with the new
 * assignment, as a new child process does.
 */

const FOREGROUND =
	"You run in the foreground: your coordinator reads your messages only with your report, so put a decision or approval you need in a `blocked` report; do not wait for an answer.";
const BACKGROUND = "You run in the background: your coordinator can answer a message while you work.";

const contract = admitResultSchema({
	type: "object",
	properties: { verdict: { type: "string" } },
	required: ["verdict"],
});

describe("child identity after its own compaction (real sessions)", () => {
	let fx: Fixture | undefined;
	afterEach(() => {
		if (fx) fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		fx = undefined;
	});

	const base = (f: Fixture): Identity => ({
		id: "child-example",
		role: "implementer",
		parentId: "parent-example",
		parentSession: "parent-session-example",
		scratch: f.scratch,
		permission: { mode: "workspace", grants: [] },
	});

	/** One isolated child: a long task, two long turns, a compaction, then the next request. */
	async function isolatedChild(f: Fixture, withAssignment: boolean) {
		const worktree = path.join(f.root, "worktrees", "child-example");
		fs.mkdirSync(worktree, { recursive: true });
		const run = assign(
			{
				...base(f),
				goal: "migrate the parser",
				why: "The old parser blocks the release",
				item: "B7",
				isolation: { path: worktree, repo: f.cwd, cwd: worktree },
				background: true,
			} as Identity,
			longTask("Migrate the parser."),
			contract,
		);
		const identity = withAssignment ? run.identity : { ...run.identity, assignment: undefined };
		const result = await runChild(
			f,
			identity,
			[
				{ prompt: run.task, reply: long("Working.") },
				{ prompt: "Keep going.", reply: long("More work.") },
				"compact",
				{ prompt: "Go on.", reply: 'done\n{"verdict":"migrated"}' },
			],
			path.join(f.scratch, "session"),
		);
		return { ...result, run };
	}

	it("T1: the next request after the child's compaction carries its latest identity; system and tools are unchanged", async () => {
		fx = fixture();
		const { requests, final, entries, run } = await isolatedChild(fx, true);
		const assignment = run.identity.assignment!;
		expect(run.task.length).toBeGreaterThan(6_000);
		// The rendered identity: worktree, id, goal, item, scratch, run mode, report outcomes, then the result contract.
		expect(assignment.startsWith(identityBlock(run.assigned))).toBe(true);
		for (const part of [
			`\`${run.identity.isolation!.cwd}\``,
			"Why you were started: The old parser blocks the release.\n\n## You\n",
			"Your name is `child-example` (implementer). Your goal: migrate the parser. You work on a team led by your coordinator",
			"Your backlog item is `B7`",
			`Your scratch folder is \`${shortPath(fx.scratch)}\``,
			BACKGROUND,
			reportContract(),
			`Result contract (SHA-256 ${contract.hash}`,
		])
			expect(assignment).toContain(part);
		const turns = requests.filter((request) => !request.summary);
		expect(requests.some((request) => request.summary)).toBe(true);
		const [first, before, after] = [turns[0], turns.at(-2)!, turns.at(-1)!];
		expect(turns).toHaveLength(3);
		expect(first.texts).toContain(run.task);
		// The compaction removed the task message; the identity follows the summary as its own message, word for word.
		expect(after.texts).not.toContain(run.task);
		expect(after.texts.filter((text) => text === assignment)).toHaveLength(1);
		const summaryAt = after.texts.findIndex((text) => text.includes("Scripted checkpoint."));
		expect(summaryAt).toBeGreaterThanOrEqual(0);
		expect(after.texts.indexOf(assignment)).toBeGreaterThan(summaryAt);
		expect(after.system).toBe(before.system);
		expect(after.tools).toBe(before.tools);
		expect(after.system).toBe(first.system);
		expect(reportStatus(final)).toBe("done");
		expect(entries.filter((entry) => entry.type === "custom" && entry.customType === IDENTITY_ENTRY)).toHaveLength(1);
	}, 120_000);

	it("T1 control: without the recorded assignment (the code before the reminder), the identity is gone after compaction", async () => {
		fx = fixture();
		const { requests, run } = await isolatedChild(fx, false);
		const after = requests.filter((request) => !request.summary).at(-1)!;
		const block = identityBlock(run.assigned);
		expect(after.texts.some((text) => text.includes(block))).toBe(false);
		expect(after.texts.some((text) => text.includes("Your backlog item is `B7`"))).toBe(false);
	}, 120_000);

	it("T1 overflow: the automatic retry after an overflow compaction carries the identity and, after a default summary, the continuity message", async () => {
		fx = fixture();
		const run = assign(
			{ ...base(fx), goal: "migrate the parser", item: "B7", background: true } as Identity,
			longTask("Migrate the parser."),
		);
		const assignment = run.identity.assignment!;
		// After an overflow Octocode skips its cache-sharing summary request (`compaction/summary.ts`), so failing its
		// standalone one fails Octocode's summary: Octocode's default summary is saved and the continuity message follows.
		const { requests, final, entries } = await runChild(
			fx,
			run.identity,
			[
				{ prompt: run.task, reply: long("Working.") },
				{ prompt: "Keep going.", reply: long("More work.") },
				{ prompt: "Go on.", reply: "done\nMigrated.", overflow: true },
			],
			path.join(fx.scratch, "session"),
			undefined,
			1,
		);
		const compaction = entries.filter((entry) => entry.type === "compaction");
		expect(compaction).toHaveLength(1);
		expect(compaction[0]).toMatchObject({ fromHook: false });
		const continuity = entries.filter(
			(entry) => entry.type === "custom_message" && entry.customType === CONTINUITY_TYPE,
		) as Array<{ content: string }>;
		expect(continuity).toHaveLength(1);
		// The provider saw: three turns (the third overflowed), the summary requests, then the retry the session made on its
		// own, with no new prompt.
		const lastSummary = requests.findLastIndex((request) => request.summary);
		expect(requests.slice(0, 3).every((request) => !request.summary)).toBe(true);
		expect(lastSummary).toBeGreaterThan(2);
		const retried = requests.slice(lastSummary + 1);
		expect(retried).toHaveLength(1);
		const [first] = retried;
		expect(first.texts).not.toContain(run.task);
		expect(first.texts.filter((text) => text === assignment)).toHaveLength(1);
		expect(first.texts.filter((text) => text === continuity[0].content)).toHaveLength(1);
		expect(first.texts.join("\n")).toContain("<user-message>\nKeep going.\n</user-message>");
		expect(first.system).toBe(requests[0].system);
		expect(reportStatus(final)).toBe("done");
	}, 120_000);

	it("T1b: after a task resume with a new assignment, the compaction reminder carries only the latest one", async () => {
		fx = fixture();
		const sessionDir = path.join(fx.scratch, "session");
		const a = assign(
			{ ...base(fx), goal: "draft the schema", item: "B11", background: true } as Identity,
			longTask("Draft the schema."),
			contract,
		);
		const first = await runChild(fx, a.identity, [{ prompt: a.task, reply: long("Drafted.") }], sessionDir);
		// The parent resumes the same child (same id, same session file) with assignment B: another goal and item, a
		// foreground run, no result contract.
		const b = assign(
			{ ...base(fx), goal: "review the schema", item: "B12", background: false } as Identity,
			longTask("Review the schema."),
		);
		const second = await runChild(
			fx,
			b.identity,
			[
				{ prompt: b.task, reply: long("Reviewed.") },
				{ prompt: "Keep going.", reply: long("More review.") },
				"compact",
				{ prompt: "Go on.", reply: "done\nReviewed." },
			],
			sessionDir,
			first.file,
		);
		expect(second.file).toBe(first.file);
		const records = second.entries.filter((entry) => entry.type === "custom" && entry.customType === IDENTITY_ENTRY);
		expect(records.map((entry) => (entry as { data: { text: string } }).data.text)).toEqual([
			a.identity.assignment,
			b.identity.assignment,
		]);
		const turns = second.requests.filter((request) => !request.summary);
		const [before, after] = [turns.at(-2)!, turns.at(-1)!];
		const assignment = b.identity.assignment!;
		expect(after.texts.filter((text) => text === assignment)).toHaveLength(1);
		for (const kept of [
			"Your name is `child-example` (implementer). Your goal: review the schema.",
			"`B12`",
			FOREGROUND,
		])
			expect(assignment).toContain(kept);
		const request = after.texts.join("\n");
		for (const gone of ["draft the schema", "`B11`", BACKGROUND, "Result contract"])
			expect(request).not.toContain(gone);
		// Same child, same place: no worktree note in either assignment, the same id and scratch folder.
		expect(assignment).not.toContain("worktree");
		expect(a.identity.assignment).toContain(`Your scratch folder is \`${shortPath(fx.scratch)}\``);
		expect(assignment).toContain(`Your scratch folder is \`${shortPath(fx.scratch)}\``);
		expect(after.system).toBe(before.system);
		expect(after.tools).toBe(before.tools);
		expect(after.system).toBe(first.requests[0].system);
		expect(after.tools).toBe(first.requests[0].tools);
		expect(reportStatus(second.final)).toBe("done");
	}, 120_000);
});
