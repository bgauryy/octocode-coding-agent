import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bashSyntax } from "../../src/octocode/permission/bash-syntax.ts";
import { shellTargetAccess } from "../../src/octocode/permission/file-access.ts";
import { isolatedTreeRefusal } from "../../src/octocode/permission/isolated-tree.ts";
import { readOnlyRoleRefusal } from "../../src/octocode/permission/read-only-role.ts";
import { catastrophicCommand } from "../../src/octocode/permission/shell/destructive.ts";
import { shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { commandWriteTargets } from "../../src/octocode/permission/shell/write-targets.ts";
import { AGENT_SCRATCH_ENV, READ_ONLY_ENV, SUBAGENT_ENV, TEAM_WORKSPACE_ENV } from "../../../common/src/env.ts";
import { worktreesDir } from "../../src/octocode/worktree-paths/own-worktree.ts";
import { WORKTREE_ROOT_ENV } from "../../src/octocode/worktree-paths/prompt-root.ts";
import { tmp } from "./helpers.ts";

/**
 * What the shell parse lets a containment role do with git. A read-only role's git is a closed list (`shell/git-forms.ts`);
 * an isolated child may run git in its own worktree but not at the main tree, and not on a ref they share. Every
 * command here only reaches a guard: nothing runs.
 */
beforeAll(shellParserReady);

function repo(): string {
	const dir = fs.realpathSync(tmp());
	execSync("git init -q", { cwd: dir });
	return dir;
}

describe("a read-only role's git", () => {
	const cwd = repo();
	const env = { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" };
	const refused = (command: string) => readOnlyRoleRefusal({ toolName: "bash", input: { command } }, cwd, env);

	it.each([
		"git status --short",
		"git log --oneline -5",
		"git diff main...HEAD",
		"git show HEAD:a.txt",
		"git blame a.txt",
		"git ls-files",
		"git ls-tree HEAD",
		"git rev-parse HEAD",
		"git rev-list --count HEAD",
		"git describe --tags",
		"git shortlog -sn",
		"git grep -n foo",
		"git cat-file -p HEAD",
		"git show-ref",
		"git --no-pager log -1",
		"git -C . log -1",
		"git --version",
		"git",
		"git branch",
		"git branch -a",
		"git branch -avv",
		"git branch --list 'feat/*'",
		"git branch -l 'feat/*'",
		"git branch --show-current",
		"git branch --contains HEAD",
		"git branch --merged main",
		"git branch --sort=-committerdate --format='%(refname)'",
		"git tag",
		"git tag -l 'v*'",
		"git tag --list",
		"git tag -n3",
		"git tag --points-at HEAD",
		"git remote",
		"git remote -v",
		"git remote get-url origin",
		"git remote show -n origin",
		"git stash list",
		"git stash show -p",
		"git worktree list",
		"git notes",
		"git notes list",
		"git notes show HEAD",
		"git format-patch --stdout -1",
	])("allows `%s`", (command) => {
		expect(refused(command)).toBeUndefined();
	});

	it.each([
		"git branch -D main",
		"git branch -d x",
		"git branch -m a b",
		"git branch -f main HEAD",
		"git branch new-branch",
		"git branch --delete x",
		"git branch -a new-branch",
		"git tag v1",
		"git tag -d v1",
		"git tag -f v1",
		"git remote add x y",
		"git remote remove origin",
		"git remote set-url origin y",
		"git remote show origin",
		"git stash",
		"git stash drop",
		"git stash clear",
		"git worktree add x",
		"git worktree remove x",
		"git worktree lock x",
		"git notes add -m x",
		"git notes remove",
		"git update-ref -d refs/heads/main",
		"git update-ref refs/heads/main HEAD",
		"git symbolic-ref HEAD refs/heads/x",
		"git reflog expire --all --expire=now",
		"git gc --prune=now",
		"git prune",
		"git filter-branch",
		"git submodule update",
		"git replace a b",
		"git pack-refs",
		"git fetch",
		"git bisect start",
		"git config user.name Ada",
		"git config --get --add a.b c",
		"git -c core.pager=evil log",
		'git diff "$BASE"',
		"git diff $(rm -rf x)",
		"git diff $(git rev-parse --output=x)",
		"git --exec-path=/tmp/evil log",
		"git --exec-path log",
		"git --git-dir=/tmp/x log",
		"git --git-dir /tmp/x log",
		"git --work-tree=/tmp/x status",
		"git --config-env=a.b=C log",
		"git --namespace x log",
		"git -p log",
		"git -C $X log",
		"git $X log",
		"git $X",
		"git log $X",
		'git log "$REF"',
		"git log --ext-diff -p",
		"git diff --textconv",
		"git grep -Oevil foo",
		"git diff --output=src/x",
		"GIT_PAGER=evil git log",
		"GIT_EXTERNAL_DIFF=evil git diff",
		"GIT_DIR=/tmp/x git log",
		"GIT_WORK_TREE=/tmp/x git status",
		"env GIT_PAGER=evil git log",
		"sh -c 'git branch -D main'",
		"find . -name x -exec git branch -D {} ;",
		"octocode -p hi",
		"/usr/local/bin/octocode --session x",
	])("refuses `%s`", (command) => {
		expect(refused(command)).toMatch(/read-only role/);
	});

	it("allows the harmless environment, and refuses any nested octocode run", () => {
		expect(refused("GIT_PAGER=cat git log")).toBeUndefined();
		expect(refused("octocode --version")).toMatch(/read-only role/);
	});

	it("names the commands the role has when it refuses a read that is not listed", () => {
		expect(refused("git rerere status")).toMatch(/`git rerere` \(this role's git is status, log, diff/);
	});

	it.each([
		"git merge-base main HEAD",
		"git diff $(git merge-base origin/main HEAD)",
		"git log $(git merge-base origin/main HEAD)..HEAD --oneline",
		"git diff $(git rev-parse --short HEAD)",
		"git for-each-ref refs/heads",
		"git cherry -v main",
		"git show-branch main HEAD",
		"git name-rev HEAD",
		"git check-ignore -v a",
		"git range-diff a..b c..d",
		"git reflog",
		"git reflog show HEAD",
		"git config --get user.name",
		"git config --list",
		"git -c core.quotepath=off status",
		"git -c color.ui=always log",
	])("leaves a reviewer's everyday read `%s` alone", (command) => {
		expect(refused(command)).toBeUndefined();
	});

	it("refuses parsed writes under the home folder, but not the temporary folder or scratch", () => {
		const scratch = path.join(cwd, ".octocode/code/temp/agents/rev-1");
		const withScratch = { ...env, [AGENT_SCRATCH_ENV]: scratch };
		const call = (command: string) => readOnlyRoleRefusal({ toolName: "bash", input: { command } }, cwd, withScratch);
		for (const command of [
			"echo x >> ~/.zshrc",
			"cp a ~/.claude/settings.json",
			'echo x > "$HOME/.profile"',
			`echo x > ${path.join(os.homedir(), ".bashrc")}`,
			"mkdir ~/outside",
			"cd ~ && echo x > .zshrc",
		])
			expect(call(command), command).toMatch(/read-only role/);
		expect(call(`echo x > ${path.join(os.tmpdir(), "note.txt")}`)).toBeUndefined();
		expect(call("echo x > /tmp/note.txt")).toBeUndefined();
		expect(call(`echo x > ${scratch}/note.txt`)).toBeUndefined();
	});
});

describe("an isolated child's shell", () => {
	const main = repo();
	const worktree = repo();
	const scratch = path.join(main, ".octocode/code/temp/agents/impl-1");
	const env = { [SUBAGENT_ENV]: "1", [TEAM_WORKSPACE_ENV]: main, [AGENT_SCRATCH_ENV]: scratch };
	const refused = (command: string) => isolatedTreeRefusal({ toolName: "bash", input: { command } }, worktree, env);

	it.each([
		`echo x > ${main}/a`,
		`git -C ${main} reset --hard`,
		`git -C ${main} clean -fdx`,
		`cd ${main} && git checkout .`,
		`cd ${main} && git reset --hard`,
		`cd ${main} && npm install`,
		`perl -pi -e s/a/b/ ${main}/f`,
		`gawk -i inplace x ${main}/f`,
		`ed ${main}/f`,
		`patch ${main}/f x.patch`,
		`tar -xf x.tar -C ${main}`,
		`unzip x.zip -d ${main}`,
		`git --work-tree=${main} checkout HEAD -- .`,
		`git --git-dir=${main}/.git --work-tree=${main} reset --hard`,
		`git --git-dir=${main}/.git commit -m x`,
		`git --git-dir=${main}/.git update-ref refs/heads/main HEAD`,
		`git -C ${main} update-index --assume-unchanged a`,
		`git -C ${main} read-tree -u HEAD`,
		`git -C ${main} submodule update`,
		`D=${main}; rm -rf $D/src`,
		`rm -rf ${main}/$X`,
		`for d in a b; do echo x > ${main}/$d; done`,
		`rm -rf ../${path.basename(main)}/$X`,
		`cd ../${path.basename(main)} && echo x > a`,
		"cd .. && git reset --hard",
		"cd $SOMEWHERE && echo x > a",
		"git update-ref refs/heads/main HEAD",
		"git update-ref -d refs/heads/main",
		"git symbolic-ref HEAD refs/heads/main",
		"git symbolic-ref -d refs/heads/x",
		"git branch -f main HEAD",
		"git branch -D main",
		"git branch -m main other",
		"git tag -f v1 HEAD",
		"git tag -d v1",
		"git checkout -B main",
		"git switch -C main",
		"git fetch . HEAD:main",
		"git fetch origin main:main",
		"git push . HEAD:main",
		`git push ${main} HEAD:main`,
		"git reflog expire --all --expire=now",
		"git reflog delete HEAD@{0}",
		"git gc --prune=now",
		"git prune",
		"git filter-branch --all",
		"git stash clear",
		"git stash drop",
		"git stash pop",
		"git stash",
		"git stash push -m wip",
		"sh -c 'git branch -D main'",
		"find . -name x -exec git update-ref -d {} ;",
	])("refuses `%s`", (command) => {
		expect(refused(command)).toMatch(/isolated/);
	});

	it.each([
		"git status",
		"git add -A",
		"git commit -m x",
		"git reset --hard",
		"git clean -fdx",
		"git checkout .",
		"git switch -c mine",
		"git branch mine",
		"git tag mine",
		"git tag -m release v1",
		"git tag -am release v1",
		"git symbolic-ref HEAD",
		"git stash list",
		"git stash apply",
		"cd src && echo x > a",
		"cd packages/x && yarn test > ../../log.txt",
		"git fetch origin",
		"git fetch origin main",
		"git push origin HEAD:refs/heads/mine",
		"git log",
		"git merge-base main HEAD",
		`git -C ${main} log -1`,
		`git -C ${main} status`,
		`git --git-dir=${main}/.git log -1`,
		"echo x > a",
		"cd ./src && echo x > a",
		`cd ${worktree} && git reset --hard`,
		"echo x > $OUT",
		"perl -pi -e s/a/b/ f",
		"ed f",
		`echo x > ${scratch}/note.md`,
		"npm install",
	])("allows `%s`", (command) => {
		expect(refused(command)).toBeUndefined();
	});

	it("follows a bare `cd` far enough to see a write that leaves the worktree for the main tree", () => {
		const out = path.relative(path.join(worktree, "src"), path.join(main, "a"));
		expect(refused(`cd src && echo x > ${out}`)).toMatch(/isolated/);
		expect(
			isolatedTreeRefusal({ toolName: "bash", input: { command: "cd src && echo x > a" } }, worktree, {
				...env,
				CDPATH: "/elsewhere",
			}),
		).toMatch(/cannot follow/);
	});

	it("says what to do about a `cd` it cannot follow, and names the shared refs", () => {
		expect(refused("cd $SOMEWHERE && echo x > a")).toMatch(/`cd \/abs\/dir`, `cd ~\/dir` or `cd \.\/dir`/);
		expect(refused("git branch -f main HEAD")).toMatch(
			/`git branch -f` \(every worktree of this repository shares its refs\)/,
		);
	});
});

describe("catastrophicCommand", () => {
	const root = repo();
	const cwd = path.join(root, "src/deep");
	fs.mkdirSync(cwd, { recursive: true });

	it.each([
		["git reset --hard", root],
		["git reset --hard HEAD~3", root],
		["git -C sub reset --hard", root],
		["git clean -f", root],
		["git clean -fdx", root],
		["git clean -xdf", root],
		["git clean --force", root],
		["git checkout .", root],
		["git checkout -- .", root],
		["git checkout HEAD -- .", root],
		["git restore .", root],
		["git restore --staged --worktree .", root],
		["git push --force", root],
		["git push -f origin main", root],
		["git push -uf origin main", root],
		["git push --force-with-lease", root],
		["git push --force-with-lease=main origin main", root],
		["git push origin +main", root],
		["rm -rf .", root],
		["rm -rf ./", root],
		["rm -fr ./*", root],
		["rm -rf *", root],
		[`rm -rf ${root}`, root],
		["rm -rf ..", root],
		["rm -rf ../..", cwd],
		["rm -rf ../../..", cwd],
		["rm -r .", root],
		["truncate -s0 ~/.ssh/id_rsa", root],
		["> ~/.ssh/authorized_keys", root],
		["echo key >> ~/.ssh/authorized_keys", root],
		["cp x ~/.ssh/config", root],
		["mv ~/.ssh/id_rsa /tmp/x", root],
		["echo key | tee -a ~/.ssh/authorized_keys", root],
		["touch ~/.ssh/config", root],
		["sed -i s/a/b/ ~/.ssh/config", root],
		["dd if=x of=$HOME/.ssh/id_rsa", root],
		["sh -c 'git reset --hard'", root],
	])("flags `%s`", (command, where) => {
		expect(catastrophicCommand(command, where), command).toBeDefined();
	});

	it.each([
		["git reset", root],
		["git reset --soft HEAD~1", root],
		["git clean -n", root],
		["git clean -nf", root],
		["git restore --staged .", root],
		["git checkout main", root],
		["git checkout -- a.txt", root],
		["git restore a.txt", root],
		["git push", root],
		["git push origin main", root],
		["rm -rf ./dist", root],
		["rm -rf .", cwd],
		["rm -rf ..", cwd],
		["rm a.txt", root],
		["rm -f .", root],
		["cat ~/.ssh/config", root],
		["cp ~/.ssh/config /tmp/x", root],
		["echo x > notes.txt", root],
	])("leaves `%s` alone", (command, where) => {
		expect(catastrophicCommand(command, where), command).toBeUndefined();
	});
});

describe("the state folder through a shell", () => {
	afterEach(() => vi.unstubAllEnvs());
	/** Whether a parsed write of `command` is refused, with the state folder where production puts it. */
	function refused(command: string): boolean {
		vi.stubEnv("OCTOCODE_HOME", "");
		const cwd = repo();
		return commandWriteTargets({ toolName: "bash", input: { command } }, cwd).some(
			(target) => shellTargetAccess(target, cwd).refusal !== undefined,
		);
	}

	it.each([
		"echo x > ~/.octocode/octocodecode/settings.json",
		"cd ~/.octocode/octocodecode && echo x > settings.json",
		"cd ~/.octocode/octocodecode; rm octocode.db",
		"cd $HOME/.octocode/octocodecode && rm octocode.db",
		'cd "$HOME/.octocode/octocodecode" && touch a',
		"H=~/.octocode; echo x > $H/octocodecode/a",
		"H=~/.octocode/octocodecode; echo x > $H/a",
		"H=$HOME/.octocode/octocodecode; for f in a b; do touch $H/$f; done",
		"sqlite3 ~/.octocode/octocodecode/octocode.db 'delete from trusted_folders'",
		"cd ~/.octocode/octocodecode && sqlite3 octocode.db 'x'",
		"sh -c 'sqlite3 ~/.octocode/octocodecode/octocode.db x'",
	])("refuses `%s`", (command) => {
		expect(refused(command)).toBe(true);
	});

	it.each([
		"sqlite3 -readonly ~/.octocode/octocodecode/octocode.db 'select 1'",
		"sqlite3 ./local.db 'x'",
		"cat ~/.octocode/octocodecode/settings.json",
		"H=~/other; echo x > $H/a",
		"echo x > $OUT",
		"cd ~/work && touch f",
	])("does not refuse `%s`", (command) => {
		expect(refused(command)).toBe(false);
	});
});

describe("undoing a failed attempt in an isolated child's own worktree", () => {
	it("does not read as destructive there, and still does anywhere else", () => {
		const home = fs.realpathSync(tmp());
		vi.stubEnv("OCTOCODE_HOME", home);
		try {
			const main = repo();
			const own = path.join(worktreesDir(main, home), "child-1");
			fs.mkdirSync(path.dirname(own), { recursive: true });
			execSync(
				`git -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m init && git worktree add -q -b child-1 ${own}`,
				{ cwd: main, stdio: "pipe" },
			);
			vi.stubEnv(WORKTREE_ROOT_ENV, own);
			for (const command of ["git reset --hard", "git checkout .", "git restore .", "git clean -fd"]) {
				expect(catastrophicCommand(command, own)).toBeUndefined();
				expect(catastrophicCommand(command, main)).toBeDefined();
				expect(catastrophicCommand(`git -C ${main} ${command.slice(4)}`, own)).toBeDefined();
			}
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("a machine too busy to parse within the first budget", () => {
	it("still parses, so a guard does not read a stalled parse as a harmless command", () => {
		const real = performance.now.bind(performance);
		let calls = 0;
		const spy = vi.spyOn(performance, "now").mockImplementation(() => {
			calls++;
			// The first deadline is set, then every progress check of the first attempt finds it long gone.
			return calls === 1 ? real() - 1_000_000 : real();
		});
		try {
			const syntax = bashSyntax("git update-ref -d refs/heads/main");
			expect(calls).toBeGreaterThan(1);
			expect(syntax.incomplete).toBe(false);
			expect(syntax.commands).toHaveLength(1);
		} finally {
			spy.mockRestore();
		}
	});
});
