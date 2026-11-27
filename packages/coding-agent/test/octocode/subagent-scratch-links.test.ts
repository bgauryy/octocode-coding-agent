import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPORT_MAX_BYTES } from "../../src/octocode/native/prompts/report.ts";
import { newChildState, reduceEvent } from "../../src/octocode/subagents/events.ts";
import { savedNotices, StderrTail } from "../../src/octocode/subagents/process/stderr.ts";
import { ReportTracker } from "../../src/octocode/subagents/report.ts";
import { ID_PATTERN } from "../../src/octocode/subagents/worktree-base.ts";
import { createWorktree, finishWorktree } from "../../src/octocode/subagents/worktree.ts";
import { tmp } from "./helpers.ts";

/** A child can plant links in its scratch folder; the parent must not write through them to a file elsewhere. */

const VICTIM_TEXT = "the user's own file\n";
const LONG = `done\n${"x".repeat(REPORT_MAX_BYTES + 10_000)}`;

function setup() {
	const root = tmp("octocode-scratch-links-");
	const scratch = path.join(root, "scratch");
	fs.mkdirSync(scratch);
	const victim = path.join(root, "victim.txt");
	fs.writeFileSync(victim, VICTIM_TEXT);
	return { root, scratch, victim };
}

const plant = {
	symlink: (target: string, file: string) => fs.symlinkSync(target, file),
	hardlink: (target: string, file: string) => fs.linkSync(target, file),
} as const;

const unchanged = (victim: string) => expect(fs.readFileSync(victim, "utf8")).toBe(VICTIM_TEXT);

describe.each(Object.keys(plant) as Array<keyof typeof plant>)("a %s planted in the child's scratch folder", (kind) => {
	it("does not receive report.md, and the report is still delivered in memory", () => {
		const { scratch, victim } = setup();
		plant[kind](victim, path.join(scratch, "report.md"));
		const tracker = new ReportTracker(scratch);
		tracker.answer(LONG, "stop");
		const result = tracker.result();
		unchanged(victim);
		expect(result.answered).toBe(true);
		expect(result.body.startsWith("done\n")).toBe(true);
		expect(result.pointer).toBeUndefined();
		expect(result.body).toContain("was not saved to a file");
		expect(result.reportArtifact?.path).toBeUndefined();
	});

	it("does not receive partial-report.md, and the partial answer is still delivered in memory", () => {
		const { scratch, victim } = setup();
		plant[kind](victim, path.join(scratch, "partial-report.md"));
		const tracker = new ReportTracker(scratch);
		tracker.answer(LONG, "error", "provider failed");
		const result = tracker.result();
		unchanged(victim);
		expect(result.answered).toBe(false);
		expect(result.text.startsWith("done\n")).toBe(true);
		expect(result.pointer).toBeUndefined();
		expect(result.text).toContain("was not saved to a file");
	});

	it("does not receive stderr.txt, and the tail is still reported", () => {
		const { scratch, victim } = setup();
		plant[kind](victim, path.join(scratch, "stderr.txt"));
		const stderr = new StderrTail(scratch);
		stderr.write(`Error: first\n${"y".repeat(10_000)}\nlast line\n`);
		stderr.write("another line\n");
		expect(stderr.save()).toBeUndefined();
		unchanged(victim);
		expect(stderr.text()).toContain("another line");
		expect(stderr.firstError()).toBeDefined();
	});

	it("does not receive a short stderr saved at the end", () => {
		const { scratch, victim } = setup();
		plant[kind](victim, path.join(scratch, "stderr.txt"));
		const stderr = new StderrTail(scratch);
		stderr.write("Error: short\n");
		expect(stderr.save()).toBeUndefined();
		unchanged(victim);
	});

	it("does not receive notices.txt, and the notices go inline", () => {
		const { scratch, victim } = setup();
		plant[kind](victim, path.join(scratch, "notices.txt"));
		const state = newChildState();
		for (let n = 0; n < 200; n++)
			reduceEvent(
				state,
				{
					type: "extension_ui_request",
					id: `n${n}`,
					method: "notify",
					notifyType: "warning",
					message: `w${n} ${"z".repeat(2_000)}`,
				},
				{ idleMs: 1_000, busyMs: 5_000 },
				0,
			);
		expect(state.notices.more).toBeGreaterThan(0);
		const saved = savedNotices(state, scratch);
		unchanged(victim);
		expect(saved?.file).toBeUndefined();
		expect(saved?.more).toBe(0);
		expect(saved?.kept.length).toBeGreaterThan(0);
	});
});

describe("a scratch folder that is itself a link", () => {
	it("receives no artifact", () => {
		const { root, scratch } = setup();
		const elsewhere = path.join(root, "elsewhere");
		fs.mkdirSync(elsewhere);
		fs.rmSync(scratch, { recursive: true });
		fs.symlinkSync(elsewhere, scratch);
		const tracker = new ReportTracker(scratch);
		tracker.answer(LONG, "stop");
		const stderr = new StderrTail(scratch);
		stderr.write("y".repeat(10_000));
		expect(stderr.save()).toBeUndefined();
		expect(tracker.result().body.startsWith("done\n")).toBe(true);
		expect(fs.readdirSync(elsewhere)).toEqual([]);
	});
});

describe("a scratch folder without planted links", () => {
	it("saves the report, the partial answer and stderr as private files, and replaces its own earlier file", () => {
		const { scratch } = setup();
		const partial = new ReportTracker(scratch);
		partial.answer(LONG, "length");
		partial.answer(`${LONG}!`, "length");
		const pointer = partial.result().pointer;
		expect(pointer).toContain("partial-report.md");
		expect(fs.readFileSync(path.join(scratch, "partial-report.md"), "utf8")).toBe(`${LONG}!`);

		const tracker = new ReportTracker(scratch);
		tracker.answer(LONG, "stop");
		tracker.answer("retry", "toolUse");
		const result = tracker.result();
		expect(result.reportArtifact?.path).toBeDefined();
		expect(fs.readFileSync(path.join(scratch, "report.md"), "utf8")).toBe(LONG);
		expect(fs.statSync(path.join(scratch, "report.md")).mode & 0o777).toBe(0o600);

		const stderr = new StderrTail(scratch);
		stderr.write("e".repeat(10_000));
		const file = stderr.save();
		expect(file).toBe(path.join(scratch, "stderr.txt"));
		expect(fs.readFileSync(file!, "utf8")).toBe("e".repeat(10_000));
	});
});

describe("worktree agent ids", () => {
	it.each([".", "..", "-x", ".hidden", "", "a/b", "a".repeat(81)])("refuses %j", (id) =>
		expect(ID_PATTERN.test(id)).toBe(false),
	);
	it.each(["inky-shell", "a", "agent_1.2", "A".repeat(80)])("accepts %j", (id) =>
		expect(ID_PATTERN.test(id)).toBe(true),
	);
});

describe("a child's git configuration", () => {
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

	/** A repository whose `core.fsmonitor` command touches a marker file whenever git runs it. */
	function trapped() {
		const repo = fs.realpathSync(tmp("octocode-fsmonitor-repo-"));
		git(repo, "init", "-q", "-b", "main");
		git(repo, "config", "user.name", "Test");
		git(repo, "config", "user.email", "test@example.com");
		fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "init");
		const marker = path.join(tmp("octocode-fsmonitor-marker-"), "ran");
		const hook = path.join(path.dirname(marker), "hook.sh");
		fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
		return { repo, marker, hook };
	}

	it("is a trap that plain git runs, so the checks below can fail", () => {
		const { repo, marker, hook } = trapped();
		git(repo, "config", "core.fsmonitor", hook);
		fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
		git(repo, "status", "--porcelain");
		expect(fs.existsSync(marker)).toBe(true);
	});

	it("does not run a core.fsmonitor command while the parent saves the child's changes", async () => {
		const { repo, marker, hook } = trapped();
		const worktree = await createWorktree(repo, "fsmonitor-1", tmp());
		git(worktree.path, "config", "core.fsmonitor", hook);
		fs.writeFileSync(path.join(worktree.path, "b.txt"), "child work\n");
		fs.writeFileSync(path.join(worktree.path, "a.txt"), "changed\n");
		const result = await finishWorktree(worktree);
		expect(result.ref).toBe("refs/octocode/fsmonitor-1");
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("does not run a core.fsmonitor command while the parent snapshots its working files", async () => {
		const { repo, marker, hook } = trapped();
		git(repo, "config", "core.fsmonitor", hook);
		fs.writeFileSync(path.join(repo, "a.txt"), "dirty\n");
		fs.writeFileSync(path.join(repo, "c.txt"), "untracked\n");
		const worktree = await createWorktree(repo, "fsmonitor-2", tmp(), true);
		expect(fs.readFileSync(path.join(worktree.path, "a.txt"), "utf8")).toBe("dirty\n");
		await finishWorktree(worktree);
		expect(fs.existsSync(marker)).toBe(false);
	});
});
