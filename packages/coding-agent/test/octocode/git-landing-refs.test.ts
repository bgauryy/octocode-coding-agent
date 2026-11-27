import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { initializeBashSyntax } from "../../src/octocode/permission/bash-syntax.ts";
import { landingRequest } from "../../src/octocode/permission/landing.ts";
import { gitLandings } from "../../src/octocode/permission/shell/git-landing.ts";
import { protectedBranch } from "../../src/octocode/worktrees/default-branch.ts";
import { tmp } from "./helpers.ts";

beforeAll(initializeBashSyntax);

/** The branch each landing names (`null`: the one checked out), per landing found. */
const named = (line: string) => gitLandings(line, {}).map((each) => each.switchedTo?.name ?? null);

describe("ref moves that land on a branch", () => {
	// [line, branches named per landing]
	it.each<[string, (string | null)[]]>([
		// branch -f and its move/copy forms
		["git branch -f main origin/main", ["main"]],
		["git branch --force main HEAD~1", ["main"]],
		["git branch -fu origin/x main abc1234", ["main"]],
		["git branch -M feature main", ["main"]],
		["git branch -C feature main", ["main"]],
		// update-ref
		["git update-ref refs/heads/main abc1234", ["main"]],
		["git update-ref -m reset refs/heads/main abc1234 def5678", ["main"]],
		["git update-ref -d refs/heads/main", ["main"]],
		["git update-ref HEAD abc1234", [null]],
		// checkout -B / switch -C
		["git checkout -B main origin/main", ["main"]],
		["git switch -C main abc1234", ["main"]],
		["git switch --force-create main", ["main"]],
		// push . and fetch . write a local branch
		["git push . HEAD:main", ["main"]],
		["git push . feature:main", ["main"]],
		["git push . +feature:refs/heads/main", ["main"]],
		["git push ./ a:main", ["main"]],
		["git push . --delete main", ["main"]],
		["git push . :main", ["main"]],
		["git fetch . origin/main:main", ["main"]],
		["git push . a:feat b:main", ["feat", "main"]],
		// reset that names a commit
		["git reset --hard origin/main", [null]],
		["git reset --hard abc1234", [null]],
		["git reset --soft HEAD~1", [null]],
		["git reset --mixed main", [null]],
		["git reset HEAD~2", [null]],
		["git reset abc1234", [null]],
		["git reset --keep HEAD^", [null]],
		["git reset --hard ORIG_HEAD", [null]],
		["git reset --hard HEAD~1 --", [null]],
		// wrapped and combined lines
		["git -C /repo branch -f main x", ["main"]],
		["sh -c 'git branch -f main x'", ["main"]],
		["git switch main && git reset --hard HEAD~1", ["main"]],
	])("finds %s", (line, branches) => {
		expect(named(line)).toEqual(branches);
	});

	it.each([
		// branch: not forced, deleting, listing, or creating (no force)
		"git branch",
		"git branch feature",
		"git branch -d main",
		"git branch -D main",
		"git branch --list main",
		"git branch -m feature renamed",
		"git branch -u origin/main",
		"git branch --set-upstream-to=origin/main",
		// update-ref: another ref, or HEAD itself detached
		"git update-ref refs/tags/v1 abc1234",
		"git update-ref refs/octocode/x abc1234",
		"git update-ref refs/remotes/origin/main abc1234",
		"git update-ref --no-deref HEAD abc1234",
		"git update-ref --stdin",
		// checkout / switch: a plain switch, a new branch, or no -B
		"git checkout main",
		"git checkout -b feature",
		"git switch -c feature",
		"git switch main",
		// push / fetch: a remote, or a refspec that writes no branch
		"git push origin HEAD:main",
		"git push origin main",
		"git push . HEAD:refs/tags/v1",
		"git push . main",
		"git push",
		"git fetch origin main:main",
		"git fetch .",
		// reset: no commit-ish target, or a pathspec
		"git reset",
		"git reset HEAD",
		"git reset @",
		"git reset -- file.txt",
		"git reset HEAD -- file.txt",
		"git reset HEAD~1 -- file.txt",
		"git reset file.txt",
		"git reset main",
		"git reset -p",
		"git reset --patch HEAD~1",
		"git reset --hard",
		"git reset --hard HEAD",
		"git reset --soft",
		"git reset --pathspec-from-file=list.txt",
		// a mention, not a command
		"echo git branch -f main x",
		"git commit -m 'git reset --hard HEAD~1'",
		"git commit --amend",
	])("does not catch %s", (line) => {
		expect(gitLandings(line, {})).toEqual([]);
	});

	it("keeps the landing a forced create of a branch makes, and the branch the line stays on", () => {
		const landings = gitLandings("git checkout -B main x && git merge y", {});
		expect(landings.map((each) => [each.command, each.switchedTo])).toEqual([
			["git checkout -B", { name: "main", created: true }],
			["git merge", { name: "main", created: true }],
		]);
	});
});

describe("the ask for a ref move, by real git", () => {
	const git = (cwd: string, ...args: string[]): string =>
		execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	const repository = (): string => {
		const dir = fs.realpathSync(tmp("octo-landing-refs-"));
		git(dir, "init", "-q", "-b", "main");
		git(dir, "config", "user.email", "test@example.invalid");
		git(dir, "config", "user.name", "test");
		fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
		git(dir, "add", ".");
		git(dir, "commit", "-qm", "init");
		git(dir, "branch", "feature");
		return dir;
	};
	const ask = (cwd: string, command: string, finds: string[] = []) =>
		landingRequest(
			{ toolName: "bash", toolCallId: "c1", input: { command } } as never,
			{ cwd },
			undefined,
			(dir, switchedTo) => {
				finds.push(dir);
				return protectedBranch(dir, switchedTo);
			},
			false,
		);

	it.each([
		"git reset --hard HEAD~1",
		"git reset --soft abc1234",
		"git branch -f main feature",
		"git update-ref refs/heads/main abc1234",
		"git update-ref HEAD abc1234",
		"git push . feature:main",
		"git checkout -B main feature",
		"git switch -C main feature",
	])("asks as worktree.merge on main: %s", async (command) => {
		const request = await ask(repository(), command);
		expect(request).toMatchObject({ action: "worktree.merge" });
	});

	it.each([
		"git branch -f feature main",
		"git update-ref refs/heads/feature abc1234",
		"git push . main:feature",
		"git checkout -B feature main",
		"git checkout -B brand-new main",
		"git switch -C brand-new",
		"git branch -f brand-new main",
		"git reset --hard",
		"git reset HEAD file",
	])("does not ask on main: %s", async (command) => {
		expect(await ask(repository(), command)).toBeUndefined();
	});

	it("asks for a reset only while the checkout is on the default branch", async () => {
		const dir = repository();
		git(dir, "switch", "-q", "feature");
		expect(await ask(dir, "git reset --hard HEAD~1")).toBeUndefined();
		expect(await ask(dir, "git branch -f main feature")).toMatchObject({ action: "worktree.merge" });
		expect(await ask(dir, "git switch main && git reset --hard HEAD~1")).toMatchObject({ action: "worktree.merge" });
	});

	it("builds one ask for a line with two landings on the same branch", async () => {
		const finds: string[] = [];
		const request = await ask(repository(), "git checkout -B main feature && git merge feature", finds);
		expect(request).toMatchObject({ action: "worktree.merge" });
		expect(finds).toHaveLength(1);
	});
});
