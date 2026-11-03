import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inlineInterpreter, unconfinedInterpreter } from "../../src/octocode/team/interpreter.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

describe("inline interpreter detection", () => {
	it.each([
		["python3 -c \"open('a','w')\"", "python3"],
		["python - <<'EOF'\nopen('a','w')\nEOF", "python"],
		["python3.12 -u -c 'x'", "python3.12"],
		["node -e \"fs.rmSync('a')\"", "node"],
		["node -p 1", "node"],
		["node --eval 'x'", "node"],
		["perl -pi -e 's/a/b/' f", "perl"],
		["perl -i.bak f", "perl"],
		["ruby -e 'x'", "ruby"],
		["deno eval 'x'", "deno"],
		["cd src && FOO=1 /usr/bin/python3 -c 'x'", "python3"],
		["sudo -u root python3 -c 'x'", "python3"],
		["echo hi | xargs node -e 'x'", "node"],
		// Code glued to its option, a continued line, a Windows program name.
		["node --eval='x'", "node"],
		["node --print='x'", "node"],
		["node -e'x'", "node"],
		["node -e='x'", "node"],
		["python3 -c'x'", "python3"],
		["python3 -uc 'x'", "python3"],
		["python3 \\\n  -c 'x'", "python3"],
		["node.exe -e 'x'", "node"],
	])("finds the interpreter in %j", (command, name) => {
		expect(inlineInterpreter(command)).toBe(name);
	});

	it.each([
		"python3 script.py",
		"node build.js --print-width 3",
		"perl -c script.pl",
		'git commit -m "fix python -c and node -e"',
		"echo python -c",
		"cat notes.md | grep node",
		"deno run main.ts",
		"ls -la",
		"python3 -Xtracemalloc script.py",
		"node -r ./register.js app.js",
	])("does not flag %j", (command) => {
		expect(inlineInterpreter(command)).toBeUndefined();
	});
});

describe("inline interpreter code whose writes the runtime refuses", () => {
	// The bash tool passes the process environment on; a developer's own NODE_OPTIONS must not decide these cases.
	beforeEach(() => {
		vi.stubEnv("NODE_OPTIONS", "");
		vi.stubEnv("BASH_ENV", "");
	});
	afterEach(() => vi.unstubAllEnvs());

	it.each([
		"node --permission --no-experimental-sqlite --allow-fs-read=* -e 'console.log(1)'",
		"node --no-experimental-sqlite --permission -p 1",
		"node --permission --no-experimental-sqlite --allow-fs-read=/repo --eval 'x'",
		"node --permission --allow-fs-read=/a --no-experimental-sqlite --allow-fs-read=/b -e 'x'",
		"cd src && node --permission --no-experimental-sqlite --allow-fs-read=* - <<'EOF'\nconsole.log(1)\nEOF",
		"node --permission --no-experimental-sqlite --allow-fs-read=* -e 'x' | jq .",
		"node --permission --no-experimental-sqlite --allow-fs-read=* -e 'console.log(`${1}`)' in.json 2>/dev/null",
		"time /usr/local/bin/node --permission --no-experimental-sqlite -p 1",
		"timeout 30 node --permission --no-experimental-sqlite -p 1",
	])("is not unconfined: %j", (command) => {
		expect(inlineInterpreter(command)).toMatch(/^node/);
		expect(unconfinedInterpreter(command)).toBeUndefined();
	});

	it.each([
		["node -e 'x'", "node"],
		// `node:sqlite` writes outside the permission model unless it is switched off.
		["node --permission --allow-fs-read=* -e 'x'", "node"],
		// Wrappers that write themselves, append words Node reads as options, or change the environment.
		["/usr/bin/time -o reserved.txt node --permission --no-experimental-sqlite -e 'x'", "node"],
		["echo --allow-fs-write=* | xargs node --permission --no-experimental-sqlite -e 'x'", "node"],
		["sudo node --permission --no-experimental-sqlite -e 'x'", "node"],
		// A glued code option is not the exact form.
		["node --permission --no-experimental-sqlite --eval='x'", "node"],
		// Node reads an option after the code word too (see the probe below), so anything but a plain word there refuses.
		["node -e 'x' --permission", "node"],
		["node --permission -e 'x' --allow-fs-write=*", "node"],
		["node --permission -e 'x' '--allow-fs-write=*'", "node"],
		["node --permission -e 'x' --allow-child-process", "node"],
		["X=--allow-fs-write=*; node --permission -e 'x' $X", "node"],
		["node --permission -e $CODE", "node"],
		["node --permission -e 'x' *", "node"],
		// Words that expand at run time or hide an option from the tokenizer.
		[
			"F=$(printf -- '--al''low-fs-write=*'); node $F --permission -e \"require('fs').writeFileSync('reserved.ts','x')\"",
			"node",
		],
		["node $F --permission -e 'x'", "node"],
		["node --permission $F -e 'x'", "node"],
		["node --permission --al''low-fs-write=* -e 'x'", "node"],
		["node --permission '--allow-fs-write=*' -e 'x'", "node"],
		["node --permission --allow-fs-read=$HOME -e 'x'", "node"],
		['node --permission -e "$(touch reserved.ts)"', "node"],
		["node --permission -e `touch reserved.ts`", "node"],
		['node --permission -e "$X"', "node"],
		["node --permission -e x\\' $(touch reserved.ts) \\'", "node"],
		// Words before the program: an indirect wrapper argument, an assignment, a program that is not `node`.
		["V='NODE_OPTIONS=--allow-fs-write=*'; env $V node --permission -e 'x'", "node"],
		["env $V node --permission -e 'x'", "node"],
		["V=NODE_OPTIONS=--allow-fs-write=*; env \"$V\" node --permission -e 'x'", "node"],
		["FOO=1 node --permission -e 'x'", "node"],
		["PATH=/tmp/fake node --permission -e 'x'", "node"],
		["./node --permission -e 'x'", "node"],
		["sudo -u $USER node --permission -e 'x'", "node"],
		["node --allow-fs-read=* -e 'x'", "node"],
		// Options and environment that lift the limits, or can set them from outside.
		["node --permission --allow-fs-write=* -e 'x'", "node"],
		["node --permission --allow_fs_write=/ -e 'x'", "node"],
		["node --permission --allow-child-process -e 'x'", "node"],
		["node --permission --allow-worker --allow-addons -e 'x'", "node"],
		["node --permission --no-permission -e 'x'", "node"],
		["NODE_OPTIONS=--allow-fs-write=* node --permission -e 'x'", "node"],
		["export NODE_OPTIONS=--allow-fs-write=*; node --permission -e 'x'", "node"],
		["env NODE_OPTIONS='--allow-fs-write=*' node --permission -e 'x'", "node"],
		["node --permission --env-file=.env -e 'x'", "node"],
		["node --permission -r ./preload.js -e 'x'", "node"],
		["node --permission --experimental-config-file=c.json -e 'x'", "node"],
		// One confined run does not cover another interpreter in the same line.
		["node --permission --no-experimental-sqlite -p 1; python3 -c 'x'", "python3"],
		["node --permission --no-experimental-sqlite -p 1 && node -e 'x'", "node"],
		// Only Node has a runtime permission model here.
		["python3 -c 'x'", "python3"],
		["perl --permission -e 'x'", "perl"],
		["deno eval 'x'", "deno"],
	])("stays unconfined: %j", (command, name) => {
		expect(unconfinedInterpreter(command)).toBe(name);
	});

	it.each([
		["NODE_OPTIONS", "--allow-fs-write=*"],
		["NODE_OPTIONS", "--max-old-space-size=100"],
		["node_options", "--allow-child-process"],
		["BASH_ENV", "/tmp/rc"],
	])("stays unconfined when the environment sets %s=%s", (key, value) => {
		const command = "node --permission --no-experimental-sqlite --allow-fs-read=* -e 'x'";
		expect(unconfinedInterpreter(command, {})).toBeUndefined();
		expect(unconfinedInterpreter(command, { [key]: "" })).toBeUndefined();
		expect(unconfinedInterpreter(command, { [key]: value })).toBe("node");
		// The default is this process's environment: the same check, read when the gate runs.
		vi.stubEnv(key, value);
		expect(unconfinedInterpreter(command)).toBe("node");
	});

	it("holds: confined Node reads a file and cannot write, spawn, reopen it for writing or create a database", () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "in.json"), '{"a":[1,2]}');
		const run = (code: string) =>
			spawnSync(process.execPath, ["--permission", "--no-experimental-sqlite", "--allow-fs-read=*", "-e", code], {
				cwd: dir,
				encoding: "utf8",
				env: { ...process.env, NODE_OPTIONS: "" },
			});
		const read = run('console.log(JSON.parse(require("fs").readFileSync("in.json","utf8")).a.length)');
		expect(read.stdout.trim()).toBe("2");
		for (const code of [
			'require("fs").writeFileSync("out.txt","x")',
			'require("fs").appendFileSync("in.json","x")',
			'require("fs").openSync("out2.txt","w")',
			'require("child_process").execSync("touch out3.txt")',
			`new (require("node:sqlite").DatabaseSync)(${JSON.stringify(path.join(dir, "out4.db"))})`,
			`new (process.getBuiltinModule("node:sqlite").DatabaseSync)(${JSON.stringify(path.join(dir, "out5.db"))})`,
		]) {
			expect(run(code).status, code).not.toBe(0);
		}
		expect(fs.readdirSync(dir)).toEqual(["in.json"]);
		expect(fs.readFileSync(path.join(dir, "in.json"), "utf8")).toBe('{"a":[1,2]}');
	});

	it("probe: the limits are lifted by an option after the code word, by an expanded word, and by NODE_OPTIONS; sqlite bypasses them", () => {
		const dir = tmp();
		const write = (name: string) => `require("fs").writeFileSync("${name}","x")`;
		const node = (args: string[], env: NodeJS.ProcessEnv = {}) =>
			spawnSync(process.execPath, args, {
				cwd: dir,
				encoding: "utf8",
				env: { ...process.env, NODE_OPTIONS: "", ...env },
			});
		node(["--permission", "--allow-fs-read=*", "-e", write("after-code.txt"), "--allow-fs-write=*"]);
		// `node $F --permission …` with F='--allow-fs-write=*': the shell hands Node the same words.
		spawnSync(
			"bash",
			[
				"-c",
				`F='--allow-fs-write=*'; "${process.execPath}" $F --permission --allow-fs-read=* -e '${write("expanded.txt")}'`,
			],
			{
				cwd: dir,
			},
		);
		node(["--permission", "--allow-fs-read=*", "-e", write("env.txt")], { NODE_OPTIONS: "--allow-fs-write=*" });
		// `node:sqlite` creates its file outside the permission model (Node 26.4), which is why the form needs it switched off.
		node([
			"--permission",
			"--allow-fs-read=*",
			"-e",
			`new (require("node:sqlite").DatabaseSync)(${JSON.stringify(path.join(dir, "s.db"))})`,
		]);
		expect(fs.readdirSync(dir).sort()).toEqual(["after-code.txt", "env.txt", "expanded.txt", "s.db"]);
	});
});

describe("the reservation gate for inline interpreter code", () => {
	const stops: Array<() => Promise<unknown>> = [];
	// The gate reads the process environment the bash tool passes on; the developer's own must not decide these cases.
	beforeEach(() => {
		vi.stubEnv("NODE_OPTIONS", "");
		vi.stubEnv("BASH_ENV", "");
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		for (const stop of stops.splice(0)) await stop();
	});

	async function member(db: string, cwd: string, readOnly?: (command: string) => boolean) {
		const fake = fakeHost();
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: db });
		const { reservationGate } = registerCollab(fake.api, team, readOnly ? { shellReadOnly: readOnly } : {});
		const ctx = fakeCtx({ cwd });
		await fake.emit("session_start", {}, ctx);
		stops.push(() => fake.emit("session_shutdown", {}, ctx));
		const lock = (paths: string[]) =>
			fake.tools.get("coordinate").execute("c", { action: "lock", paths, reason: "auth" }, undefined, undefined, ctx);
		const gate = (command: string) => reservationGate({ toolName: "bash", input: { command } } as never, ctx);
		/** The command the call runs once the gate let it through (a blocked call fails the test). */
		const ran = async (command: string) => {
			const input = { command };
			expect(await reservationGate({ toolName: "bash", input } as never, ctx), command).toBeUndefined();
			return input.command;
		};
		return { team, lock, gate, ran };
	}

	it("blocks inline interpreter code while a peer holds a reservation, and only then", async () => {
		const cwd = tmp();
		const db = path.join(tmp(), "team.sqlite");
		const owner = await member(db, cwd);
		const peer = await member(db, cwd, (command) => command.startsWith("cat "));
		const write = "python3 -c \"open('src/b.ts','w').write('x')\"";
		// Nobody holds anything: interpreters run as before.
		expect(await peer.gate(write)).toBeUndefined();
		expect(await peer.gate("node -e 'process.exit(0)'")).toBeUndefined();

		await owner.lock(["src/a.ts"]);
		for (const command of [
			write,
			// The read-only flags would not confine it: Node reads an option after the code.
			"node -e 'x' --inspect",
			"perl -pi -e 's/a/b/' f",
			"python - <<'EOF'\nx\nEOF",
			"deno eval 'x'",
		]) {
			const refused = await peer.gate(command);
			expect(refused, command).toMatchObject({
				block: true,
				reason: expect.stringContaining(`reserved by ${owner.team.id}`),
			});
			expect(refused?.reason).toContain("script file under .octa/code/temp/");
			// The next step it names must work for that interpreter: Node has the permission flag, the others the read tools.
			expect(refused?.reason).toContain(
				command.startsWith("node") ? "--permission --no-experimental-sqlite --allow-fs-read=*" : "read tools",
			);
		}
		// Node that only lacks the read-only flags runs with them added.
		expect(await peer.ran("node -e 'x'")).toBe("node --permission --no-experimental-sqlite --allow-fs-read=* -e 'x'");
		// Commands that run no inline code are unchanged; the holder's own interpreter runs.
		expect(await peer.gate("python3 script.py")).toBeUndefined();
		expect(await peer.gate("cat src/b.ts")).toBeUndefined();
		expect(await owner.gate(write)).toBeUndefined();
	});

	it("lets Node run inline code under --permission while a peer holds a reservation, and still refuses what lifts it", async () => {
		const cwd = tmp();
		const db = path.join(tmp(), "team.sqlite");
		const owner = await member(db, cwd);
		// A peer whose shell parse names no write target: the interpreter rule alone decides.
		const peer = await member(db, cwd);
		await owner.lock(["src/a.ts"]);
		for (const command of [
			"node --permission --no-experimental-sqlite --allow-fs-read=* -e 'console.log(1)'",
			"node --permission --no-experimental-sqlite --allow-fs-read=* - <<'EOF'\nconsole.log(1)\nEOF",
		]) {
			expect(await peer.gate(command), command).toBeUndefined();
		}
		for (const command of [
			"node --permission --allow-fs-write=* -e 'x'",
			"NODE_OPTIONS=--allow-fs-write=* node --permission -e 'x'",
			"node -e 'x' --permission",
			"node --permission --no-experimental-sqlite -p 1; python3 -c 'x'",
			// An option Node reads after the code word.
			"node --permission -e \"require('fs').writeFileSync('src/a.ts','x')\" --allow-fs-write=*",
			// A word the shell expands into a lifting option: nothing in the text names it.
			"F=$(printf -- '--al''low-fs-write=*'); node $F --permission -e \"require('fs').writeFileSync('src/a.ts','x')\"",
			// An indirect environment assignment handed to `env`.
			"V='NODE_OPTIONS=--allow-fs-write=*'; env $V node --permission -e 'x'",
			"env $V node --permission -e 'x'",
		]) {
			expect(await peer.gate(command), command).toMatchObject({
				block: true,
				reason: expect.stringContaining(`reserved by ${owner.team.id}`),
			});
		}
		// Only `--no-experimental-sqlite` is missing: the gate adds the whole set, and Node takes a repeated flag.
		expect(await peer.ran("node --permission --allow-fs-read=* -e 'x'")).toBe(
			"node --permission --no-experimental-sqlite --allow-fs-read=* --permission --allow-fs-read=* -e 'x'",
		);
	});

	it("refuses the confined form when the inherited environment carries NODE_OPTIONS", async () => {
		const cwd = tmp();
		const db = path.join(tmp(), "team.sqlite");
		const owner = await member(db, cwd);
		const peer = await member(db, cwd);
		await owner.lock(["src/a.ts"]);
		const command = "node --permission --no-experimental-sqlite --allow-fs-read=* -e 'console.log(1)'";
		expect(await peer.gate(command)).toBeUndefined();
		vi.stubEnv("NODE_OPTIONS", "--allow-fs-write=*");
		expect(await peer.gate(command)).toMatchObject({
			block: true,
			reason: expect.stringContaining(`reserved by ${owner.team.id}`),
		});
	});

	it("still refuses a write to a reserved path from a command that also runs confined Node", async () => {
		const cwd = tmp();
		const db = path.join(tmp(), "team.sqlite");
		const owner = await member(db, cwd);
		const fake = fakeHost();
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: db });
		const { reservationGate } = registerCollab(fake.api, team, {
			shellWrites: async (command) => (command.includes("> src/a.ts") ? ["src/a.ts"] : []),
		});
		const ctx = fakeCtx({ cwd });
		await fake.emit("session_start", {}, ctx);
		stops.push(() => fake.emit("session_shutdown", {}, ctx));
		await owner.lock(["src/a.ts"]);
		const gate = (command: string) => reservationGate({ toolName: "bash", input: { command } } as never, ctx);
		expect(await gate("node --permission --no-experimental-sqlite --allow-fs-read=* -p 1")).toBeUndefined();
		expect(await gate("node --permission --no-experimental-sqlite --allow-fs-read=* -p 1 > src/a.ts")).toMatchObject({
			block: true,
			reason: expect.stringContaining(`reserved by ${owner.team.id}`),
		});
	});

	it("lets an interpreter command the classifier shows read-only run", async () => {
		const cwd = tmp();
		const db = path.join(tmp(), "team.sqlite");
		const owner = await member(db, cwd);
		const peer = await member(db, cwd, (command) => command === "node -p 1");
		await owner.lock(["src/a.ts"]);
		// The classifier lets `node -p 1` run as written; `node -p 2` goes through the interpreter rule, which adds the flags.
		expect(await peer.ran("node -p 1")).toBe("node -p 1");
		expect(await peer.ran("node -p 2")).toBe("node --permission --no-experimental-sqlite --allow-fs-read=* -p 2");
		expect(await peer.gate("python3 -c 2")).toMatchObject({ block: true });
	});
});
