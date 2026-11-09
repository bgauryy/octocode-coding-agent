import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reportContract } from "../../src/octocode/instructions/report.ts";
import { identityBlock } from "../../src/octocode/instructions/task.ts";
import { shortPath } from "../../src/octocode/shared/format.ts";
import { IDENTITY_ENTRY } from "../../src/octocode/subagents/identity-reminder.ts";
import type { Identity } from "../../src/octocode/subagents/process/env.ts";
import { reportStatus } from "../../src/octocode/subagents/report.ts";
import { admitResultSchema } from "../../src/octocode/subagents/result-schema.ts";
import { type Fixture, fixture } from "./agent-context/capture.ts";
import { assign, long, longTask, runChild } from "./agent-context/child-run.ts";

/**
 * A child's identity after its own compaction, in a real session on a scripted model: `agent-context/child-run.ts` starts
 * each child process as `subagents/tool.ts` starts it, and a task resume reopens its session file with the new
 * assignment, as a new child process does.
 */

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
});
