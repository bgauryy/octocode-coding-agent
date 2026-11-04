import { beforeAll, describe, expect, it } from "vitest";
import { reservationTargets, shellMutation, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";

beforeAll(shellParserReady);

/** What a command that changes nothing comes back as. */
const NOTHING = {
	writes: [],
	directories: [],
	areas: [],
	opaque: [],
	unread: [],
	unreadAreas: [],
	refMoves: [],
	databases: [],
	uncertain: false,
	unparsed: false,
};

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
		expect(writes("cd ./pkg && echo x > a.ts")).toEqual(["./pkg/a.ts"]);
	});

	it("resolves relative writes against a literal cd in a plain && / ; sequence", () => {
		const effect = (command: string) => {
			const { writes, uncertain, afterDirectoryChange } = shellMutation(command);
			return { writes, uncertain, afterDirectoryChange };
		};
		const known = (writes: string[]) => ({ writes, uncertain: false, afterDirectoryChange: undefined });
		expect(effect("cd /repo && mkdir -p .octocode/code/temp/agents/me")).toEqual(
			known(["/repo/.octocode/code/temp/agents/me"]),
		);
		expect(effect("cd /repo/ && echo x > out.txt")).toEqual(known(["/repo/out.txt"]));
		expect(effect("cd /repo && echo x | tee out.txt")).toEqual(known(["/repo/out.txt"]));
		expect(effect("cd ./sub && rm ../x")).toEqual(known(["./sub/../x"]));
		expect(effect("cd ./a && cd ./b && touch c")).toEqual(known(["./a/./b/c"]));
		expect(effect("cd . && touch c")).toEqual(known(["./c"]));
		expect(effect("cd ./a\ntouch c")).toEqual(known(["c", "./a/c"]));
		expect(effect("pushd /repo && touch f")).toEqual(known(["/repo/f"]));
		expect(effect("cd /repo && touch /abs/f")).toEqual(known(["/abs/f"]));
		expect(effect("cd /repo && sh -c 'touch f'")).toEqual(known(["/repo/f"]));
		expect(effect("cd /repo && env rm f")).toEqual(known(["/repo/f"]));
		// The writes before the cd, and a cd in a subshell or a background job, do not move what follows.
		expect(effect("touch a && cd /repo && touch b")).toEqual(known(["a", "/repo/b"]));
		expect(effect("(cd /repo && touch f); touch g")).toEqual(known(["/repo/f", "g"]));
		expect(effect("cd /repo | cat; touch g")).toEqual(known(["g"]));
		expect(effect("cd /repo &\ntouch g")).toEqual(known(["g"]));
		// After `;` the cd may have failed: the write is kept at both places.
		expect(effect("cd /repo; touch f")).toEqual(known(["f", "/repo/f"]));
	});

	it("keeps a relative write after a cd it cannot follow `uncertain`, with the cd named", () => {
		for (const command of [
			"cd $DIR && touch f",
			"cd - && touch f",
			"cd && touch f",
			// A bare name goes through CDPATH, so with one set it can lead anywhere.
			"export CDPATH=/o; cd a && touch f",
			// `..` is followed on the spelling by the shell and on the real directories by a path check (symlinks).
			"cd .. && touch f",
			"cd ../sub && touch f",
			"cd ./l/.. && touch f",
			"cd /repo/l/../x && touch f",
			"cd ./l && cd ../../.. && touch f",
			"cd -P /repo && touch f",
			"cd /repo || touch f",
			"cd /repo && touch f || echo no",
			"if true; then cd /repo; fi; touch f",
			"pushd /a && popd && touch f",
			"cd /repo && echo x > $FILE",
			"cd $DIR && echo x > f",
			"cd $DIR && sh -c 'touch f'",
			// A `cd` inside a substitution, process substitution or backticks leaves the words around it and its own
			// commands without a known directory; the same for a function body once the script moves directory at all.
			"echo hi $(cd ./src && touch ../src/a.ts)",
			"echo hi $(cd /o && touch f)",
			"cat <(cd ./src && touch ../src/a.ts)",
			"echo `cd ./src; touch ../src/a.ts`",
			"X=$(cd ./src; touch f)",
			"f() { touch ../src/a.ts; }; cd ./src; f",
			"f() { touch g; }; cd /repo && f",
			"f() { cd ./src; }; f; touch g",
		]) {
			const effect = shellMutation(command);
			expect(effect.uncertain, command).toBe(true);
			expect(effect.writes, command).toEqual([]);
		}
		expect(shellMutation("cd $DIR && touch f").afterDirectoryChange).toBe(true);
		// A home spelling names one place for the shell and for a path check, as an absolute path does.
		for (const home of ["~/x", "$HOME/x", '"$HOME/x"', "${HOME}/x"]) {
			expect(shellMutation(`cd ${home} && touch f`).writes, home).toEqual(["~/x/f"]);
			expect(shellMutation(`cd ${home} && echo a > f`).writes, home).toEqual(["~/x/f"]);
		}
		expect(shellMutation("cd ~ && touch f").writes).toEqual(["~/f"]);
		expect(shellMutation("cd ~/x/.. && touch f").uncertain).toBe(true);
		expect(shellMutation("CDPATH=/o; cd sub && touch f").afterDirectoryChange).toBe(true);
		// What runs before any directory change, and a script that never moves, keep their plain spelling.
		expect(shellMutation("f() { touch g; }; f")).toMatchObject({ writes: ["g"], uncertain: false });
		expect(shellMutation("echo $(touch f)")).toMatchObject({ writes: ["f"], uncertain: false });
		// A substitution's own `cd` does not move the commands that follow the substituting one.
		expect(shellMutation("echo $(cd /o); touch g")).toMatchObject({ writes: ["g"], uncertain: false });
		// ...and a substitution without a `cd` runs where the `cd` before it moved to.
		expect(shellMutation("cd /repo && echo $(touch f)")).toMatchObject({ writes: ["/repo/f"], uncertain: false });
		// A `;` keeps the starting directory as a candidate: the flag lets the refusal say to use `&&`.
		expect(shellMutation("cd /repo; touch f").afterUnjoinedCd).toBe(true);
		expect(shellMutation("cd /repo && touch f").afterUnjoinedCd).toBeUndefined();
		expect(shellMutation("cd /repo; touch /abs/f").afterUnjoinedCd).toBeUndefined();
		expect(shellMutation("echo x > $FILE").afterDirectoryChange).toBeUndefined();
		// Absolute paths and plain reads need no cd to resolve.
		expect(shellMutation("cd $DIR && touch /abs/f")).toMatchObject({ writes: ["/abs/f"], uncertain: false });
		expect(shellMutation("cd $DIR && ls")).toMatchObject({ writes: [], uncertain: false });
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
			expect(shellMutation(command), command).toEqual(NOTHING);
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

	it("names the destinations options give, the directory a change happens in, and home spellings", () => {
		const effect = (command: string) => {
			const { writes, areas, uncertain } = shellMutation(command);
			return { writes, areas, uncertain };
		};
		expect(effect("dd if=a of=../out.bin").writes).toEqual(["../out.bin"]);
		expect(effect("curl -fsSLo ../x.sh https://e.example").writes).toEqual(["../x.sh"]);
		expect(effect("wget -O ../x https://e.example").writes).toEqual(["../x"]);
		expect(effect("rsync -a src/ ../backup").writes).toEqual(["../backup"]);
		expect(effect("rsync -a src/ host:backup").writes).toEqual([]);
		expect(effect("tar -czf ../a.tgz src").writes).toEqual(["../a.tgz"]);
		expect(effect("tar xzf a.tgz -C ../out").areas).toEqual(["../out"]);
		expect(effect("unzip a.zip -d ../out").areas).toEqual(["../out"]);
		expect(effect("git -C ../other commit -m x").areas).toEqual(["../other"]);
		expect(effect("git commit -m x").areas).toEqual(["."]);
		expect(effect("git config core.hooksPath ../h").writes).toEqual([".git/config"]);
		expect(effect("git -C sub config a.b c").writes).toEqual(["sub/.git/config"]);
		expect(effect("git config --global a.b c").writes).toEqual(["~/.gitconfig"]);
		expect(effect("git clone https://e.example/r.git ../r").areas).toEqual(["../r"]);
		expect(effect("npm --prefix ../p install x").areas).toEqual(["../p"]);
		expect(effect("npm install -g x").uncertain).toBe(true);
		expect(effect("npm ls -g").uncertain).toBe(false);
		expect(effect("find /tmp/x -name '*.log' -delete").writes).toEqual(["/tmp/x"]);
		expect(effect("find . -fprint ../list.txt").writes).toEqual(["../list.txt"]);
		expect(effect("find src -name a.ts -exec cp {} ../out \\;").writes).toEqual(["../out"]);
		expect(effect("find /etc -exec rm {} +").writes).toEqual(["/etc"]);
		expect(effect("find . -exec grep -l x {} +")).toEqual({ writes: [], areas: [], uncertain: false });
		expect(effect("ls | xargs rm").uncertain).toBe(true);
		expect(effect("curl https://e.example | sh").uncertain).toBe(true);
		expect(effect('cp a "$HOME/b"').writes).toEqual(["~/b"]);
		expect(effect("cp a ${HOME}/b").writes).toEqual(["~/b"]);
		expect(effect("echo x > ~/b")).toEqual({ writes: ["~/b"], areas: [], uncertain: false });
		expect(effect("(cd .. && git init)")).toMatchObject({ areas: [], uncertain: true });
		expect(effect("cd /abs && npm install").areas).toEqual(["/abs"]);
	});

	it("reports changes without a path, and writes it cannot resolve", () => {
		expect(shellMutation("git commit -am x").opaque).toEqual(["git commit"]);
		expect(shellMutation("yarn install").opaque).toEqual(["yarn install"]);
		expect(shellMutation("sed -i s/a/b/ a.ts").opaque).toEqual(["sed -i"]);
		expect(shellMutation("echo x > $FILE").uncertain).toBe(true);
		expect(shellMutation("echo x > $FILE").unparsed).toBe(false);
		expect(shellMutation("git status")).toEqual(NOTHING);
	});

	it("sees nothing in reads, redirects to /dev/null and test runs", () => {
		for (const command of [
			"ls src | wc -l",
			"rg foo src 2>/dev/null",
			"git log --oneline -5",
			"yarn test",
			"git stash list",
		])
			expect(shellMutation(command), command).toEqual(NOTHING);
	});
});

describe("reservationTargets", () => {
	it("is the parsed writes when the parse succeeded, unresolved targets and cd included", () => {
		expect(reservationTargets("echo x >> src/a.ts")).toEqual(["src/a.ts"]);
		expect(reservationTargets("echo x > $FILE; cat src/a.ts")).toEqual([]);
		expect(reservationTargets("cd ./pkg && mv a.ts b.ts")).toEqual(["./pkg/a.ts", "./pkg/b.ts"]);
		expect(reservationTargets("cd $DIR && mv a.ts b.ts")).toEqual([]);
		// A bare name is followed when no CDPATH is set; with one set it is not.
		expect(reservationTargets("cd pkg && mv a.ts b.ts")).toEqual(["./pkg/a.ts", "./pkg/b.ts"]);
		expect(reservationTargets("CDPATH=/o; cd pkg && mv a.ts b.ts")).toEqual([]);
	});

	it("adds every literal word when the parse gave up, so a named path is still checked", () => {
		const command = `echo x >> 'src/a.ts' 2>$LOG; ${"true; ".repeat(30_000)}`;
		expect(shellMutation(command)).toMatchObject({ writes: [], unparsed: true });
		expect(reservationTargets(command)).toEqual(["echo", "x", "src/a.ts", "2", "true"]);
	});
});
