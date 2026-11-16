import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { describe, expect, it, vi } from "vitest";
import {
	AGENT_ID_ENV,
	AGENT_RUN_ID_ENV,
	PARENT_SESSION_ENV,
	TEAM_WORKSPACE_ENV,
} from "@octocodeai/octocode-common/env";
import { sessionDir } from "../../src/storage/runtime-paths.ts";
import type { AgentRuns, Run } from "../../src/octocode/subagents/claim.ts";
import type { BackgroundRun } from "../../src/octocode/subagents/command.ts";
import {
	exitingChildren,
	isolatedCheckout,
	resumableChild,
	resumeNote,
} from "../../src/octocode/subagents/children.ts";
import { parentGoneReportId, saveParentGoneReport } from "../../src/octocode/subagents/handoff/parent-gone.ts";
import { pendingReportsDir, takePendingReports } from "../../src/octocode/subagents/handoff/pending.ts";
import { startBackground } from "../../src/octocode/subagents/run-execution.ts";
import { runDetails } from "../../src/octocode/subagents/tracking.ts";
import { finishWorktree, reopenWorktree } from "../../src/octocode/subagents/worktree.ts";
import { FinishedTracker } from "../../src/octocode/team/panel/finished.ts";
import { removeWorktree } from "../../src/octocode/worktrees/remove.ts";
import { worktreeBranch } from "../../src/octocode/worktrees/name.ts";
import { worktreePath } from "../../src/octocode/worktrees/repo.ts";
import { tmp } from "./helpers.ts";

/**
 * Swarm resume (RFC `.octocode/rfc/swarm-resume.md`): what a coordinator that restarts or is resumed does about the
 * background subagents of its previous process.
 */

const at = new Date().toISOString();

/** An `agent` task call and its result as a session records them (same shape as `subagent-children.test.ts`). */
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

/** A child's session folder with its saved transcript. */
function transcript(id: string): { dir: string; file: string } {
	const dir = path.join(tmp("octocode-swarm-"), id, "session");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	fs.writeFileSync(file, "{}\n");
	return { dir, file };
}

/** A background child the previous process started and never heard back from. */
function backgroundChild(id: string, input: Record<string, unknown> = {}): unknown[] {
	const { dir } = transcript(id);
	return agentCall(
		`call-${id}`,
		{ goal: "Fix the build", task: "Fix it", background: true, ...input },
		{ id, profile: "general", goal: "Fix the build", status: "background", session: { id, dir } },
	);
}

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
const commit = (cwd: string, ...args: string[]) =>
	git(
		cwd,
		"-c",
		"user.email=t@example.com",
		"-c",
		"user.name=t",
		"commit",
		"-q",
		...args.slice(0, -1),
		"-m",
		args.at(-1)!,
	);

/** An isolated child that stopped, with its saved transcript. */
function isolatedChild(id: string): unknown[] {
	const { dir } = transcript(id);
	return agentCall(
		`call-${id}`,
		{ goal: "Try a worktree", task: "Try it", background: true, isolate: true },
		{ id, profile: "general", goal: "Try a worktree", status: "stopped", session: { id, dir } },
	);
}

describe("swarm resume: children of a coordinator that restarted", () => {
	// Gap 1 (re-adopt): a killed parent's child takes up to a second to notice and then a SIGTERM grace to exit.
	// A resume inside that window must neither tell the model it ended for good nor start a second process on its transcript.
	it("does not announce a child as ended while its own process is still exiting", () => {
		const entries = backgroundChild("general-exiting");
		const note = resumeNote(entries, new Set(), new Set(), {
			stillExiting: new Set(["general-exiting"]),
		});
		expect(note).toBeUndefined();
	});

	it("refuses to resume a child whose previous process is still alive (no two processes on one transcript)", () => {
		const entries = backgroundChild("general-alive");
		expect(() =>
			resumableChild(entries, "general-alive", new Set(), {
				stillExiting: new Set(["general-alive"]),
			}),
		).toThrow(/still/);
	});

	// Gap 2 (reports never lost): the only process alive after the parent dies is the child, so the child itself files a
	// stop report into the parent session's `reports/pending`, where the resumed parent's `LateReports` takes it.
	it("a child whose parent is gone files a stop report where the resumed parent takes it", async () => {
		const workspace = tmp("octocode-swarm-ws-");
		const env = {
			...process.env,
			[PARENT_SESSION_ENV]: "parent-session-1",
			[AGENT_ID_ENV]: "general-orphan",
			[TEAM_WORKSPACE_ENV]: workspace,
		};
		saveParentGoneReport(env, { summary: "Stopped: its parent process ended mid-run." });
		// A second save of the same run (the parent-gone check fired twice) is still one report.
		saveParentGoneReport(env, { summary: "Stopped: its parent process ended mid-run." });
		const reports = await takePendingReports(
			path.join(sessionDir("parent-session-1", env, workspace), "reports", "pending"),
		);
		expect(reports).toHaveLength(1);
		expect(reports[0]?.details).toMatchObject({ id: "general-orphan", status: "stopped" });
	});

	// Gap 3 (isolated resume): an isolated child's changes are saved on `refs/octocode/<id>` when its worktree goes;
	// resuming it recreates the worktree at its recorded path from that ref instead of refusing.
	it("resumes a finished isolated child from its saved ref, at its recorded worktree path", () => {
		const entries = isolatedChild("general-iso");
		const free = path.join(tmp("octocode-swarm-wt-"), "general-iso");
		const resumed = resumableChild(entries, "general-iso", new Set(), {
			refExists: (ref) => ref === "refs/octocode/general-iso",
			worktreePath: () => free,
		});
		expect(resumed.worktree).toEqual({ ref: "refs/octocode/general-iso", path: free });
	});

	it("refuses an isolated child whose saved ref is gone (merged or discarded)", () => {
		const entries = isolatedChild("general-merged");
		expect(() =>
			resumableChild(entries, "general-merged", new Set(), {
				refExists: () => false,
				worktreePath: () => path.join(tmp(), "general-merged"),
			}),
		).toThrow(/ran in an isolated worktree, which is gone, and no saved refs\/octocode\/general-merged/);
	});

	it("refuses an isolated child whose worktree path is taken (a kept worktree)", () => {
		const entries = isolatedChild("general-kept");
		const taken = path.join(tmp("octocode-swarm-wt-"), "general-kept");
		fs.mkdirSync(taken);
		expect(() =>
			resumableChild(entries, "general-kept", new Set(), { refExists: () => true, worktreePath: () => taken }),
		).toThrow(/worktree .*general-kept already exists/);
	});

	it("recreates the worktree from the ref, and finishing saves the resumed work on the same ref", async () => {
		const repo = tmp("octocode-swarm-repo-");
		git(repo, "init", "-q", "-b", "main");
		fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
		git(repo, "add", "a.txt");
		commit(repo, "init");
		git(repo, "checkout", "-q", "-b", "child");
		fs.writeFileSync(path.join(repo, "a.txt"), "child\n");
		commit(repo, "-a", "child work");
		const saved = git(repo, "rev-parse", "HEAD").toString().trim();
		git(repo, "update-ref", "refs/octocode/general-iso", saved);
		git(repo, "checkout", "-q", "main");
		git(repo, "branch", "-q", "-D", "child");
		const at = { ref: "refs/octocode/general-iso", path: isolatedCheckout(repo).worktreePath!("general-iso") };

		const worktree = await reopenWorktree(repo, "general-iso", at, undefined, async () => true);
		expect(worktree.path).toBe(at.path);
		expect(fs.readFileSync(path.join(at.path, "a.txt"), "utf8")).toBe("child\n");
		expect(JSON.parse(fs.readFileSync(`${at.path}.json`, "utf8"))).toMatchObject({ owners: [{ pid: process.pid }] });
		// The worktree's HEAD holds the commit while it runs; the ref comes back when it finishes.
		expect(isolatedCheckout(repo).refExists!(at.ref)).toBe(false);

		fs.writeFileSync(path.join(at.path, "b.txt"), "more\n");
		const result = await finishWorktree(worktree);
		expect(result.ref).toBe("refs/octocode/general-iso");
		expect(fs.existsSync(at.path)).toBe(false);
		expect(git(repo, "show", `${at.ref}:a.txt`).toString()).toBe("child\n");
		expect(git(repo, "show", `${at.ref}:b.txt`).toString()).toBe("more\n");

		// Recreating again refuses while the path is taken, and without a ref.
		fs.mkdirSync(at.path);
		await expect(reopenWorktree(repo, "general-iso", at, undefined, async () => true)).rejects.toThrow(
			/already exists/,
		);
		fs.rmSync(at.path, { recursive: true });
		git(repo, "update-ref", "-d", at.ref);
		await expect(reopenWorktree(repo, "general-iso", at, undefined, async () => true)).rejects.toThrow(
			/no saved changes on refs\/octocode\/general-iso/,
		);
	});

	// The parent saves the report of a run that outlived its session; the child saves its own when the parent is gone.
	// Both use the run's id, passed to the child in its environment, so the resumed parent gets one report.
	it("the parent's late report and the child's parent-gone report of one run are delivered once", async () => {
		const workspace = tmp("octocode-swarm-ws-");
		vi.stubEnv(TEAM_WORKSPACE_ENV, workspace);
		try {
			const id = "general-twice";
			const run = { identity: { id, role: "general", goal: "Fix the build" }, route: {} } as unknown as Run;
			const details = runDetails(run);
			const runs = {
				session: 1,
				background: new Map<string, BackgroundRun>(),
				read: { track() {}, consume: () => false },
				reports: {
					add() {
						throw new Error("the session ended: the report must be saved, not queued");
					},
					reportingChanged() {},
				},
				team: { audit: { begin() {}, finish() {}, hint() {} }, unansweredPeerAsks: () => 0 },
				groups: { settled() {}, leave() {} },
				changed() {},
			};
			startBackground(
				runs as unknown as AgentRuns,
				run,
				details,
				"Fix it",
				async () => {
					runs.session += 1; // the parent's session shut down while the child ran
					throw new Error("child killed with its parent");
				},
				async () => "",
				"parent-session-twice",
			);
			await runs.background.get(id)?.done;
			saveParentGoneReport({
				...process.env,
				[PARENT_SESSION_ENV]: "parent-session-twice",
				[AGENT_ID_ENV]: id,
				[AGENT_RUN_ID_ENV]: details.runId,
			});
			const reports = await takePendingReports(pendingReportsDir("parent-session-twice"));
			expect(reports).toHaveLength(1);
			expect(reports[0]?.reportId).toBe(parentGoneReportId(id, details.runId!));
		} finally {
			vi.unstubAllEnvs();
		}
	});

	// Gap 4 (panel): after a restart the panel's finished rows are empty, so children that ended with the previous
	// process vanish from it; the resumed session seeds them as `stopped` rows the user can resume.
	it("the agents panel shows children that stopped with the previous process", () => {
		const tracker = new FinishedTracker();
		const member = { id: "general-gone", parentId: "misty-turtle", goal: "Fix the build" } as unknown as Member;
		tracker.restore([{ member, end: { outcome: "stopped", headline: "stopped with the session" } }], Date.now());
		expect(tracker.finished).toMatchObject([{ member: { id: "general-gone" }, end: { outcome: "stopped" } }]);
		// The session joining the team later keeps them: they are its children.
		tracker.update("misty-turtle", [], [], Date.now());
		expect(tracker.finished).toHaveLength(1);
	});

	// Gap 5 (worktree session): a linked worktree is its own workspace data root, so a session run there keeps its
	// `reports/pending` inside the worktree; `/worktree remove` (gitignored state is not "untracked") deletes them.
	it("keeps a worktree whose sessions hold undelivered subagent reports", async () => {
		const main = tmp("octocode-swarm-repo-");
		git(main, "init", "-q", "-b", "main");
		fs.writeFileSync(path.join(main, ".gitignore"), ".octocode/\n");
		git(main, "add", ".gitignore");
		git(main, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init");
		const target = worktreePath(main, "w1");
		git(main, "worktree", "add", "-q", "-b", worktreeBranch("w1"), target);
		const pending = path.join(sessionDir("worktree-session-1", process.env, target), "reports", "pending");
		fs.mkdirSync(pending, { recursive: true });
		fs.writeFileSync(
			path.join(pending, "1-general-late.json"),
			JSON.stringify({ content: "done", wake: true, details: { id: "general-late", summary: "done", status: "done" } }),
		);
		const result = await removeWorktree(main, "w1");
		expect(result.removed).toBe(false);
		expect(result.message).toMatch(/1 undelivered subagent report in session worktree-session-1/);
		expect(fs.existsSync(pending)).toBe(true);

		// --force copies them to the same session under the main checkout, then removes the worktree.
		const forced = await removeWorktree(main, "w1", { force: true });
		expect(forced).toMatchObject({
			removed: true,
			message: expect.stringMatching(/Copied 1 undelivered subagent report/),
		});
		expect(fs.existsSync(target)).toBe(false);
		const moved = await takePendingReports(
			path.join(sessionDir("worktree-session-1", process.env, main), "reports", "pending"),
		);
		expect(moved.map((report) => report.details.id)).toEqual(["general-late"]);
	});

	it("counts a child as still exiting only while its process lives under this coordinator", () => {
		const row = (id: string, pid: number, parentId = "misty-turtle") =>
			({ id, role: "general", parentId, pid, status: "working" }) as unknown as Member;
		const dead = 2 ** 22 + 12345; // above every default pid_max: no such process
		const members = [row("alive", process.pid), row("dead", dead), row("other", process.pid, "someone-else")];
		expect([...exitingChildren(members, "misty-turtle")]).toEqual(["alive"]);
	});
});
