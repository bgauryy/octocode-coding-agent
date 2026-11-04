import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	answer,
	close,
	dialogs,
	git,
	linkedWorktree,
	merge,
	notices,
	prompt,
	reachedStep,
	resultsOf,
	script,
	session,
	type Session,
} from "./e2e-a2a-helpers.ts";
import {
	type Endpoint,
	killEverything,
	outputOfRuns,
	sandbox,
	type Sandbox,
	startEndpoint,
	until,
} from "./e2e-real-process-harness.ts";

/** Landing commits on the protected branch through `bash` is the `worktree.merge` ask: real processes, real git, real dialogs. */
let endpoint: Endpoint;
vi.setConfig({ testTimeout: 240_000 });

beforeAll(async () => {
	endpoint = await startEndpoint();
});
afterAll(async () => {
	await endpoint.close();
});
afterEach((context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	killEverything();
	endpoint.requests.length = 0;
});

const ONCE = "Allow once";
const ALL = "Allow all worktree merges for this session";

/** A branch with one commit the sandbox's checked-out branch lacks, without a worktree; the checkout stays where it was. */
function branchWithCommit(box: Sandbox, branch: string, file = `${branch}.txt`): void {
	const here = git(box.project, "branch", "--show-current");
	git(box.project, "switch", "-qc", branch);
	fs.writeFileSync(path.join(box.project, file), `${branch}\n`);
	git(box.project, "add", ".");
	git(box.project, "commit", "-qm", `work on ${branch}`);
	git(box.project, "switch", "-q", here);
}

const bash = (command: string) => ({ tool: "bash", args: { command } });

const head = (cwd: string) => git(cwd, "rev-parse", "HEAD");

let turns = 0;
/** The model runs `command` through `bash`; resolves with the session's turn so a test can wait for its result. */
function runs(each: Session, command: string): string {
	const steps = script([bash(command), { text: "done" }]);
	prompt(each.run, `turn-${turns++}`, steps);
	return steps;
}

async function askedFor(each: Session, count: number) {
	await until(() => dialogs(each.run).length >= count, `dialog ${count}`);
	return dialogs(each.run)[count - 1];
}

const finished = (steps: string) => reachedStep(endpoint, steps, 1, "the tool's result");

describe("git merge in the main checkout, on the default branch, in full mode", () => {
	it("asks over RPC, naming the command and the branch; once asks again, for this session does not, and shares the tool's grant", async () => {
		const box = sandbox(endpoint);
		const branch = git(box.project, "branch", "--show-current");
		for (const each of ["one", "two", "three"]) branchWithCommit(box, each);
		const started = await session(box);

		const first = runs(started, "git merge --no-ff --no-edit one");
		const dialog = await askedFor(started, 1);
		expect(dialog.permission.action).toBe("worktree.merge");
		expect(dialog.title).toContain("git merge --no-ff --no-edit one");
		expect(dialog.title).toContain(`Land commits on ${branch} in the main checkout?`);
		expect(dialog.title).toContain(`on ${branch} in the main checkout ${box.project}`);
		expect(dialog.options).toEqual([ONCE, ALL, "Deny", expect.any(String)]);
		expect(fs.existsSync(path.join(box.project, "one.txt"))).toBe(false);
		answer(started.run, dialog.id, ONCE);
		await finished(first);
		expect(fs.existsSync(path.join(box.project, "one.txt"))).toBe(true);

		// "Once" held for one call.
		const second = runs(started, "git merge --no-ff --no-edit two");
		const again = await askedFor(started, 2);
		expect(fs.existsSync(path.join(box.project, "two.txt"))).toBe(false);
		answer(started.run, again.id, ALL);
		await finished(second);
		expect(fs.existsSync(path.join(box.project, "two.txt"))).toBe(true);

		// "For this session" holds for the next one, and for the tool's merge: one grant.
		const third = runs(started, "git merge --no-ff --no-edit three");
		await finished(third);
		expect(fs.existsSync(path.join(box.project, "three.txt"))).toBe(true);
		const worktree = linkedWorktree(box, "tool-branch");
		const tool = script([merge("tool-branch"), { text: "done" }]);
		prompt(started.run, "tool", tool);
		await finished(tool);
		expect(resultsOf(endpoint, tool)).toContain("Merged tool-branch");
		expect(fs.existsSync(path.join(worktree, "feature.txt"))).toBe(true);
		expect(dialogs(started.run)).toHaveLength(2);

		// `/permissions` shows and revokes it, and the audit has each decision.
		prompt(started.run, "grants", "/permissions grants");
		await until(() => notices(started.run).includes("worktree.merge: all worktree merges"), "the grant listed");
		prompt(started.run, "log", "/permissions log");
		await until(() => /worktree\.merge allowed \(user\)/.test(notices(started.run)), "the once answer in the audit");
		expect(notices(started.run)).toMatch(/worktree\.merge allowed \(grant\)/);
		prompt(started.run, "clear", "/permissions grants clear");
		await until(() => /"id":"clear"/.test(started.run.stdout()), "the grants cleared");
		branchWithCommit(box, "four");
		const fourth = runs(started, "git merge --no-ff --no-edit four");
		await askedFor(started, 3);
		expect(fs.existsSync(path.join(box.project, "four.txt"))).toBe(false);
		answer(started.run, dialogs(started.run)[2].id, "Deny");
		await finished(fourth);
		await close(started);
	});

	it("a deny leaves the branch untouched and tells the model", async () => {
		const box = sandbox(endpoint);
		branchWithCommit(box, "feature");
		const started = await session(box);
		const before = head(box.project);
		const steps = runs(started, "git merge feature");
		const dialog = await askedFor(started, 1);
		answer(started.run, dialog.id, "Deny");
		await finished(steps);
		expect(head(box.project)).toBe(before);
		expect(resultsOf(endpoint, steps)).toContain("The user denied the worktree merge: git merge feature");
		await close(started);
	});

	it("with no one to ask, refuses by name, says how to go on, and leaves the worktree and the branch", async () => {
		const box = sandbox(endpoint);
		const worktree = linkedWorktree(box, "feature");
		const before = head(box.project);
		const worktreeHead = head(worktree);
		const steps = script([bash("git merge feature"), { text: "done" }]);
		const run = box.start(["-p", steps]);
		const ended = await run.exited;
		expect(ended.code).toBe(0);
		expect(head(box.project)).toBe(before);
		expect(head(worktree)).toBe(worktreeHead);
		const refusal = resultsOf(endpoint, steps);
		expect(refusal).toContain("Not run, needs approval: the worktree merge (git merge feature)");
		expect(refusal).toContain("no one can be asked here");
		expect(refusal).toContain("in the main checkout");
		expect(refusal).toContain("this worktree and its branch are as they were");
		expect(refusal).toContain("`/worktree merge <branch>`");
	});

	it("`cd <main> && git merge x` and a `git switch` to it on the same line ask", async () => {
		const box = sandbox(endpoint);
		const branch = git(box.project, "branch", "--show-current");
		branchWithCommit(box, "feature");
		git(box.project, "switch", "-qc", "side");
		const started = await session(box);
		// A feature branch now, but the line moves the checkout to the default branch first.
		const switching = runs(started, `git switch -q ${branch} && git merge feature`);
		const dialog = await askedFor(started, 1);
		expect(dialog.permission.action).toBe("worktree.merge");
		answer(started.run, dialog.id, "Deny");
		await finished(switching);
		expect(git(box.project, "branch", "--show-current")).toBe("side");
		git(box.project, "switch", "-q", branch);
		const moved = runs(started, `cd ${JSON.stringify(box.project)} && git merge feature`);
		const second = await askedFor(started, 2);
		expect(second.title).toContain(`cd ${JSON.stringify(box.project)}`);
		answer(started.run, second.id, "Deny");
		await finished(moved);
		await close(started);
	});

	it("`git merge --abort` runs unasked", async () => {
		const box = sandbox(endpoint);
		// A real merge in progress: a conflict the abort takes back.
		git(box.project, "switch", "-qc", "conflict");
		fs.writeFileSync(path.join(box.project, "a.txt"), "theirs\n");
		git(box.project, "commit", "-qam", "theirs");
		git(box.project, "switch", "-q", "-");
		fs.writeFileSync(path.join(box.project, "a.txt"), "ours\n");
		git(box.project, "commit", "-qam", "ours");
		try {
			execFileSync("git", ["merge", "conflict"], { cwd: box.project, stdio: "ignore" });
		} catch {
			// The conflict is the point.
		}
		expect(fs.existsSync(path.join(box.project, ".git", "MERGE_HEAD"))).toBe(true);
		const started = await session(box);
		const steps = runs(started, "git merge --abort");
		await finished(steps);
		expect(dialogs(started.run)).toHaveLength(0);
		expect(fs.existsSync(path.join(box.project, ".git", "MERGE_HEAD"))).toBe(false);
		await close(started);
	});

	it("a user's own `!git merge` is consent: it runs, asks nothing, and the audit says it was typed", async () => {
		const box = sandbox(endpoint);
		branchWithCommit(box, "feature");
		const started = await session(box);
		// RPC's `bash` is the terminal's `!`: the `user_bash` path.
		started.run.process.stdin?.write(
			`${JSON.stringify({ id: "typed", type: "bash", command: "git merge --no-edit feature" })}\n`,
		);
		await until(() => /"id":"typed"/.test(started.run.stdout()), "the typed merge");
		expect(fs.existsSync(path.join(box.project, "feature.txt"))).toBe(true);
		expect(dialogs(started.run)).toHaveLength(0);
		prompt(started.run, "log", "/permissions log");
		await until(() => /shell allowed \(typed\)/.test(notices(started.run)), "the audit's typed entry");
		expect(notices(started.run)).not.toContain("worktree.merge");
		await close(started);
	});
});

describe("elsewhere no one is asked", () => {
	it("a feature branch in the main checkout merges into that branch unasked", async () => {
		const box = sandbox(endpoint);
		branchWithCommit(box, "topic");
		git(box.project, "switch", "-qc", "side");
		const started = await session(box);
		const steps = runs(started, "git merge --no-edit topic");
		await finished(steps);
		expect(dialogs(started.run)).toHaveLength(0);
		expect(fs.existsSync(path.join(box.project, "topic.txt"))).toBe(true);
		await close(started);
	});

	it("a linked worktree merges into its own branch unasked, in every mode that allows the shell", async () => {
		const box = sandbox(endpoint);
		branchWithCommit(box, "topic");
		const worktree = linkedWorktree(box, "own");
		const started = await session(box, worktree);
		const steps = runs(started, "git merge --no-edit topic");
		await finished(steps);
		expect(dialogs(started.run)).toHaveLength(0);
		expect(fs.existsSync(path.join(worktree, "topic.txt"))).toBe(true);
		expect(fs.existsSync(path.join(box.project, "topic.txt"))).toBe(false);
		await close(started);
	});
});

describe("a linked worktree that targets the main checkout", () => {
	it("`git -C <main> merge` asks, with the session answer, in full and in workspace", async () => {
		const box = sandbox(endpoint);
		const branch = git(box.project, "branch", "--show-current");
		const worktree = linkedWorktree(box, "own");
		const before = head(box.project);
		const started = await session(box, worktree);
		const steps = runs(started, `git -C ${JSON.stringify(box.project)} merge own`);
		const dialog = await askedFor(started, 1);
		expect(dialog.permission.action).toBe("worktree.merge");
		expect(dialog.title).toContain(`on ${branch} in the main checkout ${box.project}`);
		expect(dialog.options).toEqual([ONCE, ALL, "Deny", expect.any(String)]);
		answer(started.run, dialog.id, "Deny");
		await finished(steps);
		expect(head(box.project)).toBe(before);
		await close(started);

		// In workspace it is both the merge and a change outside this worktree: one dialog names them, with no session answer.
		box.env.OCTOCODE_PERMISSION = "workspace";
		const stricter = await session(box, worktree);
		const again = runs(stricter, `git -C ${JSON.stringify(box.project)} merge own`);
		const second = await askedFor(stricter, 1);
		expect(second.permission.action).toBe("worktree.merge");
		expect(second.options).toEqual([ONCE, "Deny", expect.any(String)]);
		answer(stricter.run, second.id, "Deny");
		await finished(again);
		expect(head(box.project)).toBe(before);
		await close(stricter);
	});
});

describe("the other asks still behave", () => {
	it("in manual one dialog answers the merge; the session answer then leaves the shell's own ask", async () => {
		const box = sandbox(endpoint);
		branchWithCommit(box, "one");
		branchWithCommit(box, "two");
		box.env.OCTOCODE_PERMISSION = "manual";
		const started = await session(box);
		const first = runs(started, "git merge --no-ff --no-edit one");
		const dialog = await askedFor(started, 1);
		expect(dialog.permission.action).toBe("worktree.merge");
		answer(started.run, dialog.id, ALL);
		await finished(first);
		expect(fs.existsSync(path.join(box.project, "one.txt"))).toBe(true);
		const second = runs(started, "git merge --no-ff --no-edit two");
		const shellAsk = await askedFor(started, 2);
		expect(shellAsk.title).toContain("git merge --no-ff --no-edit two");
		expect(fs.existsSync(path.join(box.project, "two.txt"))).toBe(false);
		answer(started.run, shellAsk.id, ONCE);
		await finished(second);
		expect(fs.existsSync(path.join(box.project, "two.txt"))).toBe(true);
		await close(started);
	});

	it("a destructive line that also lands stays destructive, takes its restore point and asks once in full", async () => {
		const box = sandbox(endpoint);
		branchWithCommit(box, "feature");
		const started = await session(box);
		const steps = runs(started, "git merge --no-edit feature && git reset --hard HEAD~1");
		const dialog = await askedFor(started, 1);
		expect(dialog.permission.action).toBe("shell.destructive");
		expect(dialog.title).toContain("Run this destructive command?");
		expect(dialog.title).toContain("in the main checkout");
		expect(dialog.options).toEqual([ONCE, "Deny", expect.any(String)]);
		expect(dialog.title).toMatch(/snapshot|restored/);
		answer(started.run, dialog.id, "Deny");
		await finished(steps);
		await close(started);
	});

	it("a Claude `Bash` allow rule does not answer it", async () => {
		const box = sandbox(endpoint);
		branchWithCommit(box, "feature");
		fs.mkdirSync(path.join(box.home, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(box.home, ".claude", "settings.json"),
			JSON.stringify({ permissions: { allow: ["Bash(git merge:*)", "Bash"] } }),
		);
		const started = await session(box);
		const before = head(box.project);
		const steps = runs(started, "git merge feature");
		const dialog = await askedFor(started, 1);
		expect(dialog.permission.action).toBe("worktree.merge");
		answer(started.run, dialog.id, "Deny");
		await finished(steps);
		expect(head(box.project)).toBe(before);
		await close(started);
	});

	it("a PreToolUse hook's deny wins before any dialog", async () => {
		const box = sandbox(endpoint);
		branchWithCommit(box, "feature");
		const hooks = path.join(box.home, ".octocode", "octocodecode", "hooks.json");
		fs.writeFileSync(
			hooks,
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							matcher: "bash",
							hooks: [
								{
									type: "command",
									command: "echo 'no merges here' >&2; exit 2",
								},
							],
						},
					],
				},
			}),
		);
		const started = await session(box);
		const before = head(box.project);
		const steps = runs(started, "git merge feature");
		await finished(steps);
		expect(dialogs(started.run)).toHaveLength(0);
		expect(resultsOf(endpoint, steps)).toContain("no merges here");
		expect(head(box.project)).toBe(before);
		await close(started);
	});
});
