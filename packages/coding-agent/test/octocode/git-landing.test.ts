import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { initializeBashSyntax } from "../../src/octocode/permission/bash-syntax.ts";
import { gitLandings } from "../../src/octocode/permission/shell/git-landing.ts";
import { protectedBranch } from "../../src/octocode/worktrees/default-branch.ts";
import { tmp } from "./helpers.ts";

beforeAll(initializeBashSyntax);

/** The commands found, and the directories they act on. */
const found = (command: string) => gitLandings(command, {}).map((each) => [each.command, each.dirs]);

describe("the landing commands of a bash line", () => {
	it.each([
		["git merge x", "git merge"],
		["git merge --ff-only x", "git merge"],
		["git merge --no-commit x", "git merge"],
		["git merge --squash x", "git merge"],
		["git pull", "git pull"],
		["git pull --rebase origin main", "git pull"],
		// `-n` is pull's `--no-stat`, which lands: it is not a dry run.
		["git pull -n", "git pull"],
		["git rebase main", "git rebase"],
		["git cherry-pick abc", "git cherry-pick"],
		["git cherry-pick -n abc", "git cherry-pick"],
		["git revert abc", "git revert"],
		["git revert -n abc", "git revert"],
		["git revert --no-edit HEAD", "git revert"],
		["git am patch.mbox", "git am"],
		['"git" merge x', "git merge"],
		["/usr/bin/git merge x", "git merge"],
		["'g'it mer''ge x", "git merge"],
		["git --no-pager merge x", "git merge"],
		["git -c x=y merge z", "git merge"],
		['git -c "x=a b" -c y=z merge z', "git merge"],
		["env A=1 git merge x", "git merge"],
		["A=1 git merge x", "git merge"],
		["timeout 30 git merge x", "git merge"],
		["command git merge x", "git merge"],
		["sudo git merge x", "git merge"],
		["echo hi && git merge x", "git merge"],
		["echo hi; git merge x", "git merge"],
		["true || git merge x", "git merge"],
		["(git merge x)", "git merge"],
		["{ git merge x; }", "git merge"],
		["if git merge x; then echo ok; fi", "git merge"],
		["for b in a b; do git merge $b; done", "git merge"],
		["echo $(git merge x)", "git merge"],
		["sh -c 'git merge x'", "git merge"],
		["bash -lc 'echo a && git merge x'", "git merge"],
		["eval git merge x", "git merge"],
		["git merge -- --abort", "git merge"],
	])("finds %s", (line, command) => {
		expect(gitLandings(line, {}).map((each) => each.command)).toEqual([command]);
	});

	it.each([
		"git merge --abort",
		"git merge --continue",
		"git merge --quit",
		"git merge --help",
		"git merge -h",
		"git merge-base main x",
		"git merge-tree main x",
		"git mergetool",
		"git pull --dry-run",
		"git pull --dry-run origin main",
		"git rebase --abort",
		"git rebase --continue",
		"git rebase --skip",
		"git rebase --quit",
		"git rebase --edit-todo",
		"git rebase --show-current-patch",
		"git cherry-pick --abort",
		"git cherry-pick --continue",
		"git revert --abort",
		"git revert --continue",
		"git revert --skip",
		"git revert --quit",
		"git am --abort",
		"git am --continue",
		"git am --resolved",
		"git am --show-current-patch=diff",
		"git fetch origin",
		"git status",
		"git log --grep merge",
		"echo git merge x",
		"echo 'git merge x'",
		"grep 'git merge' notes.md",
		"# git merge x",
		"git -C merge status",
		"git -c merge=x status",
		"git commit -m 'git merge x'",
		"mergetool",
	])("does not catch %s", (line) => {
		expect(gitLandings(line, {})).toEqual([]);
	});

	it("reads where it acts: -C, cd, --work-tree, --git-dir and the variables for them", () => {
		expect(found("git merge x")).toEqual([["git merge", [""]]]);
		expect(found("git -C /main merge x")).toEqual([["git merge", ["/main"]]]);
		expect(found("git -C /a -C b merge x")).toEqual([["git merge", ["/a/b"]]]);
		expect(found("git -C ../main merge x")).toEqual([["git merge", ["../main"]]]);
		expect(found("git -C ~/main merge x")).toEqual([["git merge", ["~/main"]]]);
		expect(found("git -C $HOME/main merge x")).toEqual([["git merge", ["~/main"]]]);
		expect(found("D=/main; git -C $D merge x")).toEqual([["git merge", ["/main"]]]);
		expect(found("cd /main && git merge x")).toEqual([["git merge", ["/main"]]]);
		expect(found("cd /main; git merge x")).toEqual([["git merge", ["", "/main"]]]);
		expect(found("cd sub && git merge x")).toEqual([["git merge", ["./sub"]]]);
		expect(found("cd /a && git -C b merge x")).toEqual([["git merge", ["/a/b"]]]);
		expect(found("(cd /main && git merge x)")).toEqual([["git merge", ["/main"]]]);
		expect(found("cd /main && sh -c 'git merge x'")).toEqual([["git merge", ["/main/"]]]);
		expect(found("sh -c 'cd /main && git merge x'")).toEqual([["git merge", ["/main"]]]);
		expect(found("git --work-tree=/main --git-dir=/main/.git merge x")).toEqual([["git merge", ["/main"]]]);
		expect(found("git --git-dir /main/.git merge x")).toEqual([["git merge", ["/main"]]]);
		expect(found("GIT_DIR=/main/.git git merge x")).toEqual([["git merge", ["/main"]]]);
		expect(found('GIT_WORK_TREE="/main" git merge x')).toEqual([["git merge", ["/main"]]]);
		expect(found("env GIT_DIR=/main/.git git merge x")).toEqual([["git merge", ["/main"]]]);
	});

	it.each([
		'git -C "$X" merge x',
		"git -C $(pwd) merge x",
		"cd $X && git merge x",
		"cd - && git merge x",
		"cd .. && git merge x",
		"git $SUB x",
		"$GIT merge x",
		"GIT_DIR=$X git merge x",
		'git --work-tree "$X" merge x',
		"git --git-dir=/bare.git merge x",
		"git merge x '",
	])("yields nothing it cannot place, so the normal rules apply: %s", (line) => {
		expect(gitLandings(line, {})).toEqual([]);
	});

	// A local refspec writes a branch of this repository, so it lands like a merge; a remote one is no landing here.
	it.each<[string, string[]]>([
		["git push . feat:main", ["git push"]],
		["git fetch . feat:main", ["git fetch"]],
		["git push . +feat:main", ["git push"]],
		["git fetch . +feat:main", ["git fetch"]],
		["git push . feat:refs/heads/main", ["git push"]],
		["git fetch . feat:refs/heads/main", ["git fetch"]],
		["git fetch --depth 1 . feat:main", ["git fetch"]],
		["git fetch --jobs 2 . feat:main", ["git fetch"]],
		["git -C /main fetch . feat:main", ["git fetch"]],
		["git fetch . feat:main && git push . a:main", ["git fetch", "git push"]],
	])("counts the local refspec %s as a landing", (line, commands) => {
		expect(gitLandings(line, {}).map((each) => each.command)).toEqual(commands);
	});

	it.each([
		"git fetch origin",
		"git fetch origin main:main",
		"git fetch --depth 1 origin main:main",
		"git push origin feat",
		"git push origin feat:main",
		"git push --force origin +feat:refs/heads/main",
		"git fetch . feat:refs/remotes/origin/feat",
		"git push . feat:refs/tags/v1",
		"git fetch .",
	])("does not count %s", (line) => {
		expect(gitLandings(line, {})).toEqual([]);
	});

	// The module has no "uncertain" result (the guard is not a boundary): a program word the shell computes, or an alias,
	// is not seen, and the session's normal rules apply. This pins that choice (documented in git-landing.ts).
	it.each([
		"$g merge x",
		"g=git; $g merge x",
		"$g push . feat:main",
		"${GIT} fetch . feat:main",
		"alias g=git; g merge x",
	])("does not see a landing behind an unresolved program word: %s", (line) => {
		expect(gitLandings(line, {})).toEqual([]);
	});

	it("records the branch the line switched to first, for the same checkout", () => {
		const of = (line: string) => gitLandings(line, {}).map((each) => each.switchedTo);
		expect(of("git checkout main && git merge x")).toEqual([{ name: "main", created: false }]);
		expect(of("git switch main; git merge x")).toEqual([{ name: "main", created: false }]);
		expect(of("git checkout -q main && git pull")).toEqual([{ name: "main", created: false }]);
		expect(of("git switch -c feature && git merge x")).toEqual([{ name: "feature", created: true }]);
		// `-B` resets an existing branch, so it is a landing itself (git-landing-refs.test.ts), then the merge follows.
		expect(of("git checkout -B main x && git merge y")).toEqual([
			{ name: "main", created: true },
			{ name: "main", created: true },
		]);
		expect(of("git checkout --detach main && git merge x")).toEqual([{ name: "HEAD", created: true }]);
		// It restores paths or acts elsewhere: HEAD stays.
		expect(of("git checkout -- a.txt && git merge x")).toEqual([undefined]);
		expect(of("git checkout . && git merge x")).toEqual([undefined]);
		expect(of("git checkout main -- a.txt && git merge x")).toEqual([undefined]);
		expect(of("git -C /other checkout main && git merge x")).toEqual([undefined]);
		expect(of('git checkout "$B" && git merge x')).toEqual([undefined]);
	});

	it("takes the branch `git rebase <upstream> <branch>` checks out, and leaves HEAD there", () => {
		const of = (line: string) => gitLandings(line, {}).map((each) => each.switchedTo);
		const feat = { name: "feat", created: false };
		expect(of("git rebase main feat")).toEqual([feat]);
		expect(of("git rebase -i main feat")).toEqual([feat]);
		expect(of("git rebase --onto next main feat")).toEqual([feat]);
		expect(of("git rebase -s ours -X theirs main feat")).toEqual([feat]);
		expect(of("git rebase --root feat")).toEqual([feat]);
		expect(of("git rebase main feat && git merge x")).toEqual([feat, feat]);
		// One operand is the upstream: the current branch is rebased.
		expect(of("git rebase main")).toEqual([undefined]);
		expect(of("git rebase --onto next main")).toEqual([undefined]);
		expect(of("git rebase --root")).toEqual([undefined]);
		expect(of("git switch main && git rebase main")).toEqual([{ name: "main", created: false }]);
		expect(of("git switch main && git rebase main feat")).toEqual([feat]);
	});
});

describe("the protected branch, by real git", () => {
	const git = (cwd: string, ...args: string[]): string =>
		execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	const repository = (branch: string): string => {
		const dir = fs.realpathSync(tmp("octo-landing-"));
		git(dir, "init", "-q", "-b", branch);
		git(dir, "config", "user.email", "test@example.invalid");
		git(dir, "config", "user.name", "test");
		fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
		git(dir, "add", ".");
		git(dir, "commit", "-qm", "init");
		return dir;
	};

	it("is main or master with no origin/HEAD, in the main checkout, from any folder in it", async () => {
		const main = repository("main");
		fs.mkdirSync(path.join(main, "sub"));
		expect(await protectedBranch(main)).toEqual({ branch: "main", checkout: main });
		expect(await protectedBranch(path.join(main, "sub"))).toEqual({ branch: "main", checkout: main });
		const master = repository("master");
		expect(await protectedBranch(master)).toEqual({ branch: "master", checkout: master });
	});

	it("is not a feature branch, a detached HEAD or a branch no rule names", async () => {
		const dir = repository("main");
		git(dir, "switch", "-qc", "feature");
		expect(await protectedBranch(dir)).toBeUndefined();
		git(dir, "switch", "-q", "--detach");
		expect(await protectedBranch(dir)).toBeUndefined();
		const other = repository("develop");
		expect(await protectedBranch(other)).toBeUndefined();
	});

	it("follows origin/HEAD when it is set", async () => {
		const dir = repository("develop");
		git(dir, "branch", "main");
		git(dir, "update-ref", "refs/remotes/origin/develop", "HEAD");
		git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
		expect(await protectedBranch(dir)).toEqual({ branch: "develop", checkout: dir });
		git(dir, "switch", "-q", "main");
		expect(await protectedBranch(dir)).toBeUndefined();
	});

	it("is not a linked worktree on its own branch, and it is the main checkout from one that names it", async () => {
		const main = repository("main");
		const linked = path.join(fs.realpathSync(tmp("octo-landing-wt-")), "wt");
		git(main, "worktree", "add", "-q", "-b", "feature", linked);
		expect(await protectedBranch(linked)).toBeUndefined();
		expect(await protectedBranch(main)).toEqual({ branch: "main", checkout: main });
	});

	it("takes a branch the line switched to, when it exists or the line creates it", async () => {
		const dir = repository("main");
		git(dir, "switch", "-qc", "feature");
		expect(await protectedBranch(dir, { name: "main", created: false })).toEqual({ branch: "main", checkout: dir });
		expect(await protectedBranch(dir, { name: "no-such-branch", created: false })).toBeUndefined();
		git(dir, "switch", "-q", "main");
		expect(await protectedBranch(dir, { name: "feature", created: false })).toBeUndefined();
		expect(await protectedBranch(dir, { name: "new", created: true })).toBeUndefined();
	});

	it("says nothing outside a repository, in a bare one and in a folder that does not exist", async () => {
		expect(await protectedBranch(fs.realpathSync(tmp("octo-landing-none-")))).toBeUndefined();
		expect(await protectedBranch("/no/such/folder")).toBeUndefined();
		const bare = fs.realpathSync(tmp("octo-landing-bare-"));
		git(bare, "init", "-q", "--bare", "-b", "main");
		expect(await protectedBranch(bare)).toBeUndefined();
	});
});
