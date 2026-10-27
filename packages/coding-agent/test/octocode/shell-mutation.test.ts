import { beforeAll, describe, expect, it } from "vitest";
import { reservationTargets, shellMutation, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";

beforeAll(shellParserReady);

describe("shellMutation", () => {
	it("names the paths a command writes, moves or removes", () => {
		const writes = (command: string) => shellMutation(command).writes;
		expect(writes("echo x > src/a.ts")).toEqual(["src/a.ts"]);
		expect(writes("echo x >> src/a.ts")).toEqual(["src/a.ts"]);
		expect(writes("cat a | tee -a out.txt")).toEqual(["out.txt"]);
		expect(writes("rm -rf src/a.ts lib")).toEqual(["src/a.ts", "lib"]);
		expect(writes("mv src/a.ts src/b.ts")).toEqual(["src/a.ts", "src/b.ts"]);
		expect(writes("cp src/a.ts dist/a.ts")).toEqual(["dist/a.ts"]);
		expect(writes("cp -t dist src/a.ts")).toEqual(["dist"]);
		expect(writes("sed -i s/a/b/ src/a.ts")).toContain("src/a.ts");
		expect(writes("timeout 5 touch src/a.ts")).toEqual(["src/a.ts"]);
		expect(writes("sh -c 'echo x > src/a.ts'")).toEqual(["src/a.ts"]);
		expect(writes("cd pkg && echo x > a.ts")).toEqual([]);
	});

	it("sees the command a wrapper runs: env, sudo, exec, command, nice, nohup and time", () => {
		const writes = (command: string) => shellMutation(command).writes;
		expect(writes("env rm a.ts")).toEqual(["a.ts"]);
		expect(writes("env -i FOO=1 BAR=2 rm a.ts")).toEqual(["a.ts"]);
		expect(writes("env -u HOME rm a.ts")).toEqual(["a.ts"]);
		expect(writes("sudo rm a.ts")).toEqual(["a.ts"]);
		expect(writes("sudo -u root -E touch a.ts")).toEqual(["a.ts"]);
		expect(writes("exec rm a.ts")).toEqual(["a.ts"]);
		expect(writes("command rm a.ts")).toEqual(["a.ts"]);
		expect(writes("nice -n 5 rm a.ts")).toEqual(["a.ts"]);
		expect(writes("nohup rm a.ts")).toEqual(["a.ts"]);
		expect(writes("time rm a.ts")).toEqual(["a.ts"]);
		expect(writes("env tee out.txt")).toEqual(["out.txt"]);
		expect(writes("/usr/bin/env sudo -n env rm a.ts")).toEqual(["a.ts"]);
		expect(shellMutation("env sudo git commit -m x").opaque).toEqual(["git commit"]);
		expect(shellMutation("sudo sh -c 'echo x > a.ts'").writes).toEqual(["a.ts"]);
		expect(shellMutation("env $CMD a.ts").uncertain).toBe(true);
		for (const command of ["env", "env FOO=1", "command -v rm", "sudo ls", "exec ls src", "time git status"])
			expect(shellMutation(command), command).toEqual({ writes: [], opaque: [], uncertain: false, unparsed: false });
	});

	it("treats opaque writers as mutations: rsync, awk -i inplace, ed/ex, git config, npm pkg/config set", () => {
		const opaque = (command: string) => shellMutation(command).opaque;
		expect(opaque("rsync -a src/ dist/")).toEqual(["rsync"]);
		expect(opaque("env rsync -a src/ dist/")).toEqual(["rsync"]);
		expect(opaque("awk -i inplace '{print}' a.txt")).toEqual(["awk -i inplace"]);
		expect(opaque("gawk -iinplace '{print}' a.txt")).toEqual(["gawk -i inplace"]);
		expect(opaque("gawk --include=inplace '{print}' a.txt")).toEqual(["gawk -i inplace"]);
		expect(opaque("ed -s a.txt")).toEqual(["ed"]);
		expect(opaque("ex -sc 'wq' a.txt")).toEqual(["ex"]);
		expect(opaque("git config user.name Ada")).toEqual(["git config"]);
		expect(opaque("git -C . config --global core.editor vim")).toEqual(["git config"]);
		expect(opaque("git config --unset user.name")).toEqual(["git config"]);
		expect(opaque("npm pkg set scripts.x=y")).toEqual(["npm pkg set"]);
		expect(opaque("yarn config set nodeLinker node-modules")).toEqual(["yarn config set"]);
		expect(opaque("pnpm config delete registry")).toEqual(["pnpm config delete"]);
		// Reads stay reads.
		for (const command of [
			"awk '{print}' a.txt",
			"git config user.name",
			"git config --get user.name",
			"git config --list",
			"git config -l --show-origin",
			"npm pkg get name",
			"npm config get registry",
			"npm config list",
		])
			expect(opaque(command), command).toEqual([]);
	});

	it("finds the git subcommand past global options", () => {
		const opaque = (command: string) => shellMutation(command).opaque;
		expect(opaque("git -C . checkout -- a.ts")).toEqual(["git checkout"]);
		expect(opaque("git -C ../other commit -m x")).toEqual(["git commit"]);
		expect(opaque("git -c core.editor=true -c k=v rebase main")).toEqual(["git rebase"]);
		expect(opaque("git --git-dir=.git --no-pager reset --hard")).toEqual(["git reset"]);
		expect(opaque("git --git-dir .git --work-tree . clean -fd")).toEqual(["git clean"]);
		expect(opaque("env git -C . stash")).toEqual(["git stash"]);
		expect(opaque("git -C . status")).toEqual([]);
		expect(opaque("git -C . stash list")).toEqual([]);
		expect(opaque("git -c k=v log --oneline")).toEqual([]);
	});

	it("reports changes without a path, and writes it cannot resolve", () => {
		expect(shellMutation("git commit -am x").opaque).toEqual(["git commit"]);
		expect(shellMutation("yarn install").opaque).toEqual(["yarn install"]);
		expect(shellMutation("sed -i s/a/b/ a.ts").opaque).toEqual(["sed -i"]);
		expect(shellMutation("echo x > $FILE").uncertain).toBe(true);
		expect(shellMutation("echo x > $FILE").unparsed).toBe(false);
		expect(shellMutation("git status")).toEqual({ writes: [], opaque: [], uncertain: false, unparsed: false });
	});

	it("sees nothing in reads, redirects to /dev/null and test runs", () => {
		for (const command of [
			"ls src | wc -l",
			"rg foo src 2>/dev/null",
			"git log --oneline -5",
			"yarn test",
			"git stash list",
		])
			expect(shellMutation(command), command).toEqual({ writes: [], opaque: [], uncertain: false, unparsed: false });
	});
});

describe("reservationTargets", () => {
	it("is the parsed writes when the parse succeeded, unresolved targets and cd included", () => {
		expect(reservationTargets("echo x >> src/a.ts")).toEqual(["src/a.ts"]);
		expect(reservationTargets("echo x > $FILE; cat src/a.ts")).toEqual([]);
		expect(reservationTargets("cd pkg && mv a.ts b.ts")).toEqual([]);
	});

	it("adds every literal word when the parse gave up, so a named path is still checked", () => {
		const command = `echo x >> 'src/a.ts' 2>$LOG; ${"true; ".repeat(30_000)}`;
		expect(shellMutation(command)).toMatchObject({ writes: [], unparsed: true });
		expect(reservationTargets(command)).toEqual(["echo", "x", "src/a.ts", "2", "true"]);
	});
});
