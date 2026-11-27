import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsedShell } from "../../src/octocode/permission/shell/commands.ts";
import { splitString, wrappedCommand } from "../../src/octocode/permission/shell/words.ts";
import { inlineInterpreter, interpreterRefusal } from "../../src/octocode/team/interpreter.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const unconfinedInterpreter = (...args: Parameters<typeof interpreterRefusal>) => interpreterRefusal(...args)?.name;

const CONFINED = "node --permission --no-experimental-sqlite --allow-fs-read=*";

/** Commands in places the old tokenizer did not look, or read wrongly; each runs inline code (or something that may). */
const REFUSED: Array<[string, string]> = [
	// Groups, function bodies, control flow, subshells, substitutions.
	["{ python3 -c 'x'; }", "python3"],
	["node(){ /usr/bin/env node -e 'x'; }; node --permission --no-experimental-sqlite -e '1'", "node"],
	["run() { perl -pi -e 's/a/b/' f; }; run", "perl"],
	["function go { ruby -e 'x'; }; go", "ruby"],
	["if true; then python3 -c 'x'; fi", "python3"],
	["if python3 -c 'x'; then echo ok; fi", "python3"],
	["for f in a b; do python3 -c 'x'; done", "python3"],
	["case $1 in a) deno eval 'x';; esac", "deno"],
	["(python3 -c 'x')", "python3"],
	["echo $(python3 -c 'x')", "python3"],
	["echo \"$(node -e 'x')\"", "node"],
	["echo `python3 -c 'x'`", "python3"],
	["cat <(python3 -c 'x')", "python3"],
	["X=$(python3 -c 'x')", "python3"],
	// A function or alias named like the program changes what it means, wherever the call is.
	["node() { echo hi; }; node --permission --no-experimental-sqlite -p 1", "node"],
	["function env { :; }; env node --permission --no-experimental-sqlite -p 1", "env"],
	["time() { :; }; time node --permission --no-experimental-sqlite -p 1", "time"],
	["alias node=cat; node --permission --no-experimental-sqlite -p 1", "node"],
	["alias 'python3=cat'", "python3"],
	// Code on standard input of a bare interpreter.
	["echo 'print(1)' | python3", "python3"],
	["cat <<'EOF' | python3\nprint(1)\nEOF", "python3"],
	["cat f.js | node", "node"],
	["node < f.js", "node"],
	["python3 <<EOF\nprint(1)\nEOF", "python3"],
	["python3 <<< 'print(1)'", "python3"],
	["echo x | { python3; }", "python3"],
	["echo x | sudo -u root python3", "python3"],
	["echo x | python3 -W ignore", "python3"],
	["python3 < <(echo x)", "python3"],
	["python3 <(echo x)", "python3"],
	["deno run - < f.ts", "deno"],
	// A stray apostrophe in a comment, an escape or a heredoc body, before the interpreter.
	["echo it\\'s; python3 -c 'x'", "python3"],
	["# it's a comment\npython3 -c 'x'", "python3"],
	["cat <<EOF\nit's\nEOF\npython3 -c 'x'", "python3"],
	// Code another program runs: a shell's script, eval, trap, find -exec.
	["bash -c \"python3 -c 'x'\"", "python3"],
	["sh -c 'node -e 1'", "node"],
	["sudo -u me bash -lc 'python3 -c x'", "python3"],
	["bash -c \"sh -c 'python3 -c 1'\"", "python3"],
	["bash -c 'echo hi; { node -e 1; }'", "node"],
	["eval \"python3 -c 'x'\"", "python3"],
	["trap 'python3 -c x' EXIT", "python3"],
	["find . -exec python3 -c 'x' \\;", "python3"],
	["find . -name a -execdir sh -c 'node -e x' {} +", "node"],
	["echo x | xargs python3 -c 'x'", "python3"],
	// Code the parse cannot read: refused as the shell that runs it.
	['bash -c "$SCRIPT"', "bash"],
	['zsh -c "$(cat s.sh)"', "zsh"],
	["eval $SCRIPT", "eval"],
	['eval "$(cat s.sh)"', "eval"],
	["echo 'python3 -c x' | bash", "bash"],
	["bash <<'EOF'\npython3 -c x\nEOF", "bash"],
	["source <(echo x)", "source"],
	['trap "$HANDLER" EXIT', "trap"],
	// Everything the tokenizer found before.
	["python3 -c \"open('a','w')\"", "python3"],
	["node --eval='x'", "node"],
	["node -e'x'", "node"],
	["python3 \\\n  -c 'x'", "python3"],
	["node.exe -e 'x'", "node"],
	["python - <<'EOF'\nx\nEOF", "python"],
	["cd src && FOO=1 /usr/bin/python3 -c 'x'", "python3"],
	["echo hi | xargs node -e 'x'", "node"],
	["perl -i.bak f", "perl"],
	// Quoting, escapes and ANSI-C strings do not hide the program or its options.
	["'python3' -c x", "python3"],
	['py"thon"3 -c x', "python3"],
	["no''de -e x", "node"],
	["\\python3 -c x", "python3"],
	["$'python3' -c x", "python3"],
	['python3 "-c" x', "python3"],
	["node '-e' x", "node"],
	['"bash" -c "$X"', "bash"],
	["pyth*3 -c x", "pyth*3"],
	// Here-document bodies the grammar leaves as text, and stdin sources.
	["cat <<EOF\n`python3 -c x`\nEOF", "python3"],
	["source /dev/stdin <<EOF\npython3 -c x\nEOF", "source"],
	[". /dev/fd/0 <<EOF\nx\nEOF", "."],
	// A shell's script is its first operand; -s reads stdin.
	["bash -c -- 'python3 -c x'", "python3"],
	["bash -c -e 'python3 -c x'", "python3"],
	["echo 'python3 -c x' | bash -s foo", "bash"],
	["echo 'python3 -c x' | sh -s -- a", "sh"],
	// Wrappers the permission layer knows.
	["ionice -c3 python3 -c x", "python3"],
	["taskset 1 python3 -c x", "python3"],
	["caffeinate python3 -c x", "python3"],
	["setsid python3 -c x", "python3"],
	["flock /tmp/l python3 -c x", "python3"],
	["arch -arm64 python3 -c x", "python3"],
	["uv run python -c x", "python"],
	["poetry run python -c x", "python"],
	["pyenv exec python -c x", "python"],
	["conda run -n e python -c x", "python"],
	["npx node -e x", "node"],
	["coproc python3 -c x", "python3"],
	// More stdin code.
	["python3 /dev/stdin < f", "python3"],
	["python3 -m code < f", "python3"],
	["python3 -m timeit \"open('f','w')\"", "python3"],
	["deno run -A - < f", "deno"],
	["deno repl < f", "deno"],
	// One confined run does not cover another run beside it, inside a group or a body.
	// A wrapper option's value is not the program; `env -S` runs its string as the command.
	["exec -a name python3 -c x", "python3"],
	["env -S 'python3 -c x'", "python3"],
	['env -S"python3 -c x"', "python3"],
	["env --split-string='python3 -c x'", "python3"],
	["env --split-string 'node -e 1'", "node"],
	["env -iS 'python3 -c x'", "python3"],
	["sudo env -S 'perl -pi -e s/a/b/ f'", "perl"],
	["env -S 'python3' -c x", "python3"],
	["env -S 'python3\\_-c\\_x'", "env"],
	['env -S "python3 -c $X"', "env"],
	// A descriptor-0 redirect feeds standard input; the grammar reads its `0` as a word.
	["python3 0<f", "python3"],
	["node 0< f.js", "node"],
	["python3 2>err.txt 0<f", "python3"],
	["python3 0<<<'print(1)'", "python3"],
	["0<f python3", "python3"],
	["exec 0<file; python3", "python3"],
	["exec 0<file; ls; { python3; }", "python3"],
	["exec <file; echo $(python3)", "python3"],
	["exec 0<file; bash -s", "bash"],
	// The words after a redirect's destination are the command's.
	["python3 --check-hash-based-pycs always -c x", "python3"],
	["python3 >out -c x", "python3"],
	["python3 <f -c x", "python3"],
	["0<f python3 -c x", "python3"],
	[`${CONFINED} -p 1; { python3 -c 'x'; }`, "python3"],
	[`${CONFINED} -p 1 && if true; then node -e 'x'; fi`, "node"],
	[`{ ${CONFINED} -p 1; }; echo x | python3`, "python3"],
];

/** Lines whose only fault is a `node` without the read-only flags: the gate adds them after each `node` while a peer holds a reservation. */
const REWRITTEN: Array<[string, string]> = [
	["{ node -e 'x'; } > out.txt", `{ ${CONFINED} -e 'x'; } > out.txt`],
	["while read l; do node -e 'x'; done < list.txt", `while read l; do ${CONFINED} -e 'x'; done < list.txt`],
	["echo \"it's\" && node -e 'x'", `echo "it's" && ${CONFINED} -e 'x'`],
	["node -e 'a' | timeout 5 node -p 'b'", `${CONFINED} -e 'a' | timeout 5 ${CONFINED} -p 'b'`],
];

/** Commands that run no inline code, and the confined Node forms, wherever they sit. */
const ALLOWED = [
	// Options after the script operand belong to the script.
	"node server.js -p 3000",
	"node app.js -e production",
	"node build.js --print",
	"python3 -m pytest -c pytest.ini",
	"python3 script.py -c cfg",
	"python3 script.py -",
	"perl script.pl -i",
	"uv run pytest -c pytest.ini",
	"npx tsx script.ts",
	"[ -f x ] && ls",
	`${CONFINED} -e 'console.log(1)'`,
	`cd src && ${CONFINED} -e 'console.log(1)'`,
	`${CONFINED} -e 'x' | jq .`,
	`echo '{}' | ${CONFINED} -e 'x'`,
	`${CONFINED} - <<'EOF'\nconsole.log(1)\nEOF`,
	`cd src && ${CONFINED} - <<'EOF'\nconsole.log(1)\nEOF`,
	`${CONFINED} - < in.js`,
	`{ ${CONFINED} -p 1; }`,
	`if true; then ${CONFINED} -p 1; fi`,
	`timeout 30 ${CONFINED} -p 1`,
	"echo it\\'s; ls",
	"python3 script.py",
	"node build.js --print-width 3",
	"echo 'print(1)' | python3 script.py",
	"curl -s x | python3 -m json.tool",
	"cat a.json | node app.js",
	"python3 script.py < in.txt",
	"python3 --version",
	// Wrapper options with values, `env -S` strings that run nothing risky, descriptors that are not standard input.
	"exec -a name ls",
	"env -S 'ls -la'",
	"env -iS 'ls -la'",
	"env --split-string='git status'",
	"python3 script.py 2>err.txt",
	"python3 script.py 2>err.txt 0<f",
	"python3 script.py 5<f",
	"python3 2>err.txt 5<f script.py",
	"python3 <f script.py",
	"python3 >out script.py",
	"cat 0<f",
	"ls 0<f",
	"exec 3<file; python3",
	"exec >log; python3",
	"exec 0<file; ls; python3 script.py",
	"python3 script.py; exec 0<file",
	"echo | python3 -V",
	"node -r ./register.js app.js",
	"python3 -Xtracemalloc script.py",
	'git commit -m "fix python -c and node -e"',
	"cat <<'EOF' | grep node\nnode -e x\nEOF",
	"echo python -c",
	"echo bash -c x",
	"grep -c eval src/a.ts",
	"bash -c 'ls | wc -l'",
	"sh -c 'echo $HOME'",
	"eval 'echo hi'",
	"trap 'rm -f tmp' EXIT",
	"echo python3 | cat",
	"find . -name '*.ts' -exec grep -l node {} +",
	"run() { echo hi; }; run",
	"alias ll='ls -l'",
	"ls -la",
];

describe("inline interpreter detection by the shell parse", () => {
	beforeEach(() => {
		vi.stubEnv("NODE_OPTIONS", "");
		vi.stubEnv("BASH_ENV", "");
	});
	afterEach(() => vi.unstubAllEnvs());

	it.each(REFUSED)("finds unconfined code in %j", async (command, name) => {
		const parsed = await parsedShell(command);
		expect(parsed, "the line parses").toBeDefined();
		expect(unconfinedInterpreter(command, process.env, parsed)).toBe(name);
	});

	it.each(REWRITTEN)("finds unconfined node in %j and none once the flags are added", async (command, rewritten) => {
		expect(unconfinedInterpreter(command, process.env, await parsedShell(command))).toBe("node");
		expect(unconfinedInterpreter(rewritten, process.env, await parsedShell(rewritten))).toBeUndefined();
	});

	it.each(ALLOWED)("does not refuse %j", async (command) => {
		const parsed = await parsedShell(command);
		expect(parsed, "the line parses").toBeDefined();
		expect(unconfinedInterpreter(command, process.env, parsed)).toBeUndefined();
	});

	it("reports inline runs apart from the confinement check", async () => {
		const command = `{ ${CONFINED} -p 1; }`;
		expect(inlineInterpreter(command, await parsedShell(command))).toBe("node");
		expect(inlineInterpreter("{ ls; }", await parsedShell("{ ls; }"))).toBeUndefined();
	});

	it("describes each command with its words, redirections and where stdin comes from", async () => {
		expect(await parsedShell("cat <<'EOF' | python3 -u\nx\nEOF")).toEqual({
			commands: [
				{ words: ["cat"], literals: ["cat"], program: 0, redirects: ["<<'EOF'"], stdin: "heredoc" },
				{ words: ["python3", "-u"], literals: ["python3", "-u"], program: 0, redirects: [], stdin: "pipe" },
			],
			functions: [],
		});
		expect(await parsedShell("A=1 node -e 'x' 2>&1 < in")).toEqual({
			commands: [
				{
					words: ["A=1", "node", "-e", "'x'"],
					literals: [undefined, "node", "-e", "x"],
					program: 1,
					redirects: ["2>&1", "< in"],
					stdin: "file",
				},
			],
			functions: [],
		});
		expect((await parsedShell("f() { :; }; function g { :; }"))?.functions).toEqual(["f", "g"]);
		expect(await parsedShell("echo it's")).toBeUndefined();
	});

	it("folds a digit abutting a redirect into its descriptor, and a redirect's trailing words into the command", async () => {
		expect(await parsedShell("cat 0<f")).toEqual({
			commands: [{ words: ["cat"], literals: ["cat"], program: 0, redirects: ["0<f"], stdin: "file" }],
			functions: [],
		});
		expect((await parsedShell("cat 5<f"))?.commands[0]).toMatchObject({ redirects: ["5<f"] });
		expect((await parsedShell("cat 5<f"))?.commands[0].stdin).toBeUndefined();
		expect((await parsedShell("cat a 0 <f"))?.commands[0].words).toEqual(["cat", "a", "0"]);
		expect((await parsedShell("cat A=1<f"))?.commands[0].words).toEqual(["cat", "A=1"]);
		expect((await parsedShell("python3 >out -c x"))?.commands[0]).toMatchObject({
			words: ["python3", "-c", "x"],
			redirects: [">out"],
		});
		// A bare `exec` with input redirections gives later commands standard input; one with a command does not.
		const after = (await parsedShell("exec 0<file; ls; { cat; }"))?.commands.map((command) => command.stdin);
		expect(after).toEqual(["file", "file", "file"]);
		expect((await parsedShell("exec 0<file ls; cat"))?.commands[1].stdin).toBeUndefined();
		expect((await parsedShell("exec 3<file; cat"))?.commands[1].stdin).toBeUndefined();
	});

	it("does not resolve a program past an option value or an env split string", async () => {
		const at = (words: string[]) => wrappedCommand(words, 0);
		expect(at(["exec", "-a", "name", "python3"])).toBe(3);
		expect(at(["env", "-u", "X", "A=1", "ls"])).toBe(4);
		expect(at(["env", "-S", "python3 -c x"])).toBeUndefined();
		expect(at(["env", "-Spython3 -c x"])).toBeUndefined();
		expect(at(["env", "--split-string=python3", "-c"])).toBeUndefined();
		expect(at(["sudo", "-u", "r", "env", "-iS", "ls"])).toBeUndefined();
		expect(splitString(["env", "-S", "ls -la", "x"], 0)).toEqual({ value: "ls -la", end: 3 });
		expect(splitString(["env", "--split-string=ls"], 0)).toEqual({ value: "ls", end: 2 });
		expect(splitString(["env", "-S"], 0)).toEqual({ value: undefined, end: 3 });
		expect(splitString(["xargs", "-S", "9", "ls"], 0)).toBeUndefined();
		// The split string's command is parsed as one of the line's commands; an unreadable one is opaque.
		expect((await parsedShell("env -S 'ls -la' x"))?.commands.map((c) => c.words)).toEqual([
			["env", "-S", "'ls -la'", "x"],
			["ls", "-la", "x"],
		]);
		expect((await parsedShell("env -S 'a\\_b'"))?.commands[0].opaque).toBe(true);
		// An expansion as the command is not guessed at: it hides which program runs, so it is opaque, named by its source text.
		expect(unconfinedInterpreter("$PY -c x", {}, await parsedShell("$PY -c x"))).toBe("$PY");
	});

	it("reads the tokenizer's answer and refuses any interpreter named when the parse failed", () => {
		// `null`: a parser exists but gave up. The tokenizer's finding stands; otherwise a name in the text refuses.
		expect(unconfinedInterpreter("python3 -c 'x'", {}, null)).toBe("python3");
		expect(unconfinedInterpreter("{ python3 -c 'x'", {}, null)).toBe("python3");
		expect(unconfinedInterpreter("git commit -m 'node -e'", {}, null)).toBe("node");
		expect(unconfinedInterpreter('{ bash -c "$X"', {}, null)).toBe("bash");
		expect(unconfinedInterpreter("git status", {}, null)).toBeUndefined();
		expect(unconfinedInterpreter("ls src/nodes my-python-notes", {}, null)).toBeUndefined();
		// No parser wired (`undefined`): the tokenizer alone, as before.
		expect(unconfinedInterpreter("python3 script.py", {})).toBeUndefined();
	});
});

describe("the reservation gate with the shell parse", () => {
	const stops: Array<() => Promise<unknown>> = [];
	beforeEach(() => {
		vi.stubEnv("NODE_OPTIONS", "");
		vi.stubEnv("BASH_ENV", "");
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		for (const stop of stops.splice(0)) await stop();
	});

	async function member(
		db: string,
		cwd: string,
		options: Parameters<typeof registerCollab>[2] = { shellCommands: parsedShell },
	) {
		const fake = fakeHost();
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: db });
		const { reservationGate } = registerCollab(fake.api, team, options);
		const ctx = fakeCtx({ cwd });
		await fake.emit("session_start", {}, ctx);
		stops.push(() => fake.emit("session_shutdown", {}, ctx));
		const lock = (paths: string[]) =>
			fake.tools.get("coordinate").execute("c", { action: "lock", paths, reason: "auth" }, undefined, undefined, ctx);
		// Inline code is held back only when its text names a reserved path: a trailing comment names it for these cases.
		const gate = (command: string) =>
			reservationGate({ toolName: "bash", input: { command: `${command}\n# src/a.ts` } } as never, ctx);
		/** Runs the gate on a call with an id, then the result hooks on a plain result; returns the verdict, the command the call runs and the result text. */
		const call = async (command: string) => {
			const event = { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command } };
			const verdict = await reservationGate(event as never, ctx);
			const results = await fake.emit(
				"tool_result",
				{
					type: "tool_result",
					toolCallId: "call-1",
					toolName: "bash",
					input: event.input,
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
				ctx,
			);
			const content = (results as Array<{ content?: Array<{ text: string }> } | undefined>).find(
				(result) => result?.content,
			)?.content;
			return {
				verdict,
				command: event.input.command,
				text: (content ?? [{ text: "ok" }]).map((part) => part.text).join("\n"),
			};
		};
		return { team, lock, gate, call };
	}

	it.each(REFUSED)("refuses %j while a peer holds a reservation", async (command, name) => {
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const owner = await member(db, cwd);
		const peer = await member(db, cwd);
		// Nobody holds anything: the command runs as before, and the parse is not even asked for.
		expect(await peer.gate(command)).toBeUndefined();
		await owner.lock(["src/a.ts"]);
		const refused = await peer.gate(command);
		expect(refused, command).toMatchObject({
			block: true,
			reason: expect.stringContaining(`reserved by ${owner.team.id}`),
		});
		expect(refused?.reason).toContain(`runs ${name} on inline code`);
		expect(refused?.reason).toContain(
			"write the code to a script file under .octocode/agent/temp/ and run that file, or use the file tool for edits",
		);
		// The holder's own commands run.
		expect(await owner.gate(command)).toBeUndefined();
	});

	it.each(REWRITTEN)(
		"runs %j with the flags added while a peer holds a reservation, and says so",
		async (command, rewritten) => {
			const db = path.join(tmp(), "team.sqlite");
			const cwd = tmp();
			const owner = await member(db, cwd);
			const peer = await member(db, cwd);
			// Nobody holds anything: the command runs as written, with no note.
			expect(await peer.call(command)).toEqual({ verdict: undefined, command, text: "ok" });
			await owner.lock(["src/a.ts"]);
			// Inline code is rewritten only when its text names the reserved path.
			expect((await peer.call(command)).command).toBe(command);
			const confined = await peer.call(`${command}\n# src/a.ts`);
			expect(confined.verdict).toBeUndefined();
			expect(confined.command).toBe(`${rewritten}\n# src/a.ts`);
			expect(confined.text).toContain("ERR_ACCESS_DENIED");
			expect(confined.text).toContain("--permission --no-experimental-sqlite --allow-fs-read=*");
			// The holder's own command runs as written.
			expect(await owner.call(command)).toEqual({ verdict: undefined, command, text: "ok" });
		},
	);

	it("refuses rather than rewrites when node is not the only fault or the node words do not match the runs", async () => {
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const owner = await member(db, cwd);
		const peer = await member(db, cwd);
		await owner.lock(["src/a.ts"]);
		for (const [command, name, cause] of [
			// Python, Perl and Ruby have no read-only form: the refusal names them, not the node beside them.
			["node -e 'x'; python3 -c 'x'", "python3", "python3 has no read-only form"],
			["node -e 'x' && perl -pi -e 's/a/b/' f", "perl", "perl has no read-only form"],
			["ruby -e 'x'", "ruby", "ruby has no read-only form"],
			// A confined node already in the line counts as a node word but not as a faulty run.
			[`${CONFINED} -p 1 && node -e 'x'`, "node", "needs both"],
			// The flags added, another fault remains: that one is named.
			["node -e 'x' --inspect", "node", "`--inspect` after the code"],
		] as const) {
			const { verdict, command: ran } = await peer.call(`${command}\n# src/a.ts`);
			expect(verdict, command).toMatchObject({ block: true });
			expect(verdict?.reason).toContain(`runs ${name} on inline code`);
			expect(verdict?.reason).toContain(cause);
			expect(ran).toBe(`${command}\n# src/a.ts`);
		}
	});

	it("runs the rewritten node for real: it reads, and a write fails with ERR_ACCESS_DENIED", async () => {
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const owner = await member(db, cwd);
		const peer = await member(db, cwd);
		await owner.lock(["src/a.ts"]);
		writeFileSync(path.join(cwd, "in.txt"), "hello");
		const run = async (command: string) => {
			const { verdict, command: confined } = await peer.call(`${command}\n# src/a.ts`);
			expect(verdict, command).toBeUndefined();
			expect(confined).not.toBe(command);
			return spawnSync("bash", ["-c", confined], { cwd, encoding: "utf8" });
		};
		const read = await run(`node -p 'require("fs").readFileSync("in.txt", "utf8")'`);
		expect(read.status, read.stderr).toBe(0);
		expect(read.stdout.trim()).toBe("hello");
		const write = await run(`{ node -e 'require("fs").writeFileSync("out.txt", "x")'; }`);
		expect(write.status).not.toBe(0);
		expect(write.stderr).toContain("ERR_ACCESS_DENIED");
		expect(existsSync(path.join(cwd, "out.txt"))).toBe(false);
	});

	it("lets the allowed forms run while a peer holds a reservation", async () => {
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const owner = await member(db, cwd);
		const peer = await member(db, cwd);
		await owner.lock(["src/a.ts"]);
		for (const command of ALLOWED) expect(await peer.gate(command), command).toBeUndefined();
	});

	it("refuses a command naming an interpreter or shell when the parse fails, and runs the rest", async () => {
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const owner = await member(db, cwd);
		const peer = await member(db, cwd, { shellCommands: async () => undefined });
		await owner.lock(["src/a.ts"]);
		for (const command of ["{ python3 -c 'x'", "python3 script.py", "echo it's; node build.js", 'bash -c "$X"']) {
			expect(await peer.gate(command), command).toMatchObject({ block: true });
		}
		for (const command of ["git status", "cat src/b.ts", "echo it's"]) {
			expect(await peer.gate(command), command).toBeUndefined();
		}
	});

	it("gates a 2000-stage pipeline quickly", async () => {
		const command = `${Array.from({ length: 2000 }, (_, i) => `cat f${i}`).join(" | ")} | python3 -c x`;
		// CPU time of this process (one test file per forked worker; the parser runs in process): wall time also counts
		// other workers' turns on the CPU.
		const started = process.cpuUsage();
		const parsed = await parsedShell(command);
		const name = unconfinedInterpreter(command, process.env, parsed ?? null);
		const used = process.cpuUsage(started);
		expect((used.user + used.system) / 1000).toBeLessThan(400);
		expect(name).toBe("python3");
	});

	it.each([
		["over the size limit", `echo ${"x".repeat(130 * 1024)}; python3 -c x`],
		["an error node", "echo 'unterminated; python3 -c x"],
		["over the command limit", `${Array.from({ length: 2100 }, () => "true").join("; ")}; python3 -c x`],
	])("drives the real parse into failure (%s) and refuses", async (_label, command) => {
		expect(await parsedShell(command)).toBeUndefined();
		expect(unconfinedInterpreter(command, {}, null)).toBe("python3");
	});

	it("falls back to the tokenizer when no parser is wired", async () => {
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const owner = await member(db, cwd);
		const peer = await member(db, cwd, {});
		await owner.lock(["src/a.ts"]);
		expect(await peer.gate("python3 -c 'x'")).toMatchObject({ block: true });
		expect(await peer.gate("python3 script.py")).toBeUndefined();
	});

	it("still lets a read-only interpreter command through and still checks the writes it names", async () => {
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const owner = await member(db, cwd);
		const peer = await member(db, cwd, {
			shellCommands: parsedShell,
			shellReadOnly: (command) => command.startsWith("{ python3 -c 'print(1)'; }"),
			shellWrites: async (command) => (command.includes("> src/a.ts") ? ["src/a.ts"] : []),
		});
		await owner.lock(["src/a.ts"]);
		expect(await peer.gate("{ python3 -c 'print(1)'; }")).toBeUndefined();
		expect(await peer.gate("{ python3 -c 'print(2)'; }")).toMatchObject({ block: true });
		expect(await peer.gate(`${CONFINED} -p 1 > src/a.ts`)).toMatchObject({ block: true });
	});
});
