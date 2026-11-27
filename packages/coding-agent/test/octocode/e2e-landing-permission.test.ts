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
	sessionIdle,
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
	await endpoint?.close();
});
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
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

/** The tool's result reached the model and the run ended, so the next prompt does not meet a busy session. */
async function finished(each: Session, steps: string) {
	await reachedStep(endpoint, steps, 1, "the tool's result");
	await sessionIdle(each);
}

describe("git merge in the main checkout, on the default branch, in full mode", () => {
	it("RPC shell and agent merges ask before landing and share the session grant", async () => {
		const box = sandbox(endpoint);
		const branch = git(box.project, "branch", "--show-current");
		for (const each of ["one", "two", "three"]) branchWithCommit(box, each);
		branchWithCommit(box, "feature");
		const started = await session(box);

		// RPC shell input must wait for its own approval before modifying the protected checkout.
		started.run.process.stdin?.write(
			`${JSON.stringify({ id: "typed", type: "bash", command: "git merge --no-edit feature" })}\n`,
		);
		const requested = await askedFor(started, 1);
		expect(requested.permission.action).toBe("worktree.merge");
		expect(fs.existsSync(path.join(box.project, "feature.txt"))).toBe(false);
		answer(started.run, requested.id, ONCE);
		await until(() => fs.existsSync(path.join(box.project, "feature.txt")), "the approved RPC merge");
		prompt(started.run, "typed-log", "/permissions log");
		await until(() => /worktree\.merge allowed \(user\)/.test(notices(started.run)), "the RPC approval in the audit");

		const first = runs(started, "git merge --no-ff --no-edit one");
		const dialog = await askedFor(started, 2);
		expect(dialog.permission.action).toBe("worktree.merge");
		expect(dialog.title).toContain("git merge --no-ff --no-edit one");
		expect(dialog.title).toContain(`Land commits on ${branch} in the main checkout?`);
		expect(dialog.title).toContain(`on ${branch} in the main checkout ${box.project}`);
		expect(dialog.options).toEqual([ONCE, ALL, "Deny", expect.any(String)]);
		expect(fs.existsSync(path.join(box.project, "one.txt"))).toBe(false);
		answer(started.run, dialog.id, ONCE);
		await finished(started, first);
		expect(fs.existsSync(path.join(box.project, "one.txt"))).toBe(true);

		// "Once" held for one call.
		const second = runs(started, "git merge --no-ff --no-edit two");
		const again = await askedFor(started, 3);
		expect(fs.existsSync(path.join(box.project, "two.txt"))).toBe(false);
		answer(started.run, again.id, ALL);
		await finished(started, second);
		expect(fs.existsSync(path.join(box.project, "two.txt"))).toBe(true);

		// "For this session" holds for the next one, and for the tool's merge: one grant.
		const third = runs(started, "git merge --no-ff --no-edit three");
		await finished(started, third);
		expect(fs.existsSync(path.join(box.project, "three.txt"))).toBe(true);
		const worktree = linkedWorktree(box, "tool-branch");
		const tool = script([merge("tool-branch"), { text: "done" }]);
		prompt(started.run, "tool", tool);
		await finished(started, tool);
		expect(resultsOf(endpoint, tool)).toContain("Merged tool-branch");
		expect(fs.existsSync(path.join(worktree, "feature.txt"))).toBe(true);
		expect(dialogs(started.run)).toHaveLength(3);

		// `/permissions` shows and revokes it, and the audit has each decision.
		prompt(started.run, "grants", "/permissions grants");
		await until(() => notices(started.run).includes("worktree.merge: all worktree merges"), "the grant listed");
		prompt(started.run, "log", "/permissions log");
		await until(() => /"id":"log","type":"response"/.test(started.run.stdout()), "the permission log response");
		expect(notices(started.run)).toMatch(/worktree\.merge allowed \(user\)/);
		expect(notices(started.run)).toMatch(/worktree\.merge allowed \(grant\)/);
		prompt(started.run, "clear", "/permissions grants clear");
		await until(() => /"id":"clear"/.test(started.run.stdout()), "the grants cleared");
		branchWithCommit(box, "four");
		const fourth = runs(started, "git merge --no-ff --no-edit four");
		await askedFor(started, 4);
		expect(fs.existsSync(path.join(box.project, "four.txt"))).toBe(false);
		answer(started.run, dialogs(started.run)[3].id, "Deny");
		await finished(started, fourth);
		expect(fs.existsSync(path.join(box.project, "four.txt"))).toBe(false);
		expect(resultsOf(endpoint, fourth)).toContain(
			"The user denied the worktree merge: git merge --no-ff --no-edit four",
		);
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
		await finished(started, first);
		expect(fs.existsSync(path.join(box.project, "one.txt"))).toBe(true);
		const second = runs(started, "git merge --no-ff --no-edit two");
		const shellAsk = await askedFor(started, 2);
		expect(shellAsk.title).toContain("git merge --no-ff --no-edit two");
		expect(fs.existsSync(path.join(box.project, "two.txt"))).toBe(false);
		answer(started.run, shellAsk.id, ONCE);
		await finished(started, second);
		expect(fs.existsSync(path.join(box.project, "two.txt"))).toBe(true);
		await close(started);
	});
});
