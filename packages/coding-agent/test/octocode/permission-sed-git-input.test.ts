import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { parsedShell } from "../../src/octocode/permission/shell/commands.ts";
import { reservationTargets, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { readOnlyCommand } from "../../src/octocode/permission/shell/read-only.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { PERMISSION_ENV } from "@octocodeai/octocode-common/env";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * Two writes the line shows only in part. Behind `xargs`/`parallel`, git's words from input come after the visible
 * subcommand, where git's own option parser (not git's global options) reads them: a subcommand that only touches the
 * index whatever its options (`add`, `ls-files`, `check-ignore`, `rm --cached --`) runs unasked; any other asks. sed
 * writes the files its script names with `w`, `W` and the `w` flag of `s///w`, and runs commands with `e`: a visible
 * target is judged like a redirection, a script the guard cannot read (`-f`, `$S`, `e`) asks.
 *
 * git's output options belong to their subcommand: `ls-files -o` is `--others` and `grep -o` `--only-matching`, both
 * reads, while `diff`/`log --output`, `format-patch -o` and `archive -o` name the file or directory they write. BSD
 * (macOS) sed's `-I EXT` edits in place like `-i`; GNU sed has no `-I` and refuses it.
 */
function workspace() {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	const fake = fakeHost();
	const permission = new Permission({ api: fake.api, env: { [PERMISSION_ENV]: "workspace" }, isSubagent: false });
	const ctx = fakeCtx({ cwd, hasUI: false });
	permission.start(ctx);
	const gate = permissionGate({ permission, provenance: { check: () => undefined }, powershell: async () => false });
	let id = 0;
	return (command: string) =>
		gate({ type: "tool_call", toolCallId: `b${id++}`, toolName: "bash", input: { command } }, ctx);
}

const outside = path.join(os.homedir(), ".octocode-fr2b-never-written");

describe("git behind an input runner", () => {
	it.each([
		"git ls-files -m | xargs git add",
		"git ls-files -z | xargs -0 git add --",
		"git diff --name-only | xargs git add -f",
		"ls | xargs -I{} git add {}",
		"parallel git add ::: a.ts b.ts",
		"echo a.ts | xargs git rm --cached --",
		"echo a.ts | xargs git rm -r --cached --quiet --",
		"ls | xargs git check-ignore",
		"ls | xargs git ls-files --error-unmatch",
	])("runs `%s` unasked", async (command) => {
		await shellParserReady();
		expect(await workspace()(command), command).toBeUndefined();
	});

	it("reads `xargs git ls-files` as read-only, and not `xargs git add`", async () => {
		await shellParserReady();
		expect(readOnlyCommand("ls | xargs git ls-files --error-unmatch")).toBe(true);
		expect(readOnlyCommand("git ls-files -m | xargs git add")).toBe(false);
	});

	it.each([
		["checkout takes its paths from input", `echo ${outside} | xargs git checkout --`],
		["restore", "echo a.ts | xargs git restore"],
		["apply", "echo a.patch | xargs git apply"],
		["archive takes -o from input", `echo -o ${outside} | xargs git archive HEAD`],
		["format-patch takes -o from input", `echo -o ${outside} | xargs git format-patch`],
		["log takes --output from input", `echo --output=${outside} | xargs git log`],
		["diff takes --output from input", `echo --output=${outside} | xargs git diff`],
		["show takes --output from input", `echo --output=${outside} | xargs git show`],
		["grep takes -O from input", "echo -Ovim | xargs git grep x"],
		["plain rm removes files", "echo a.ts | xargs git rm"],
		["rm --cached without -- takes --no-cached from input", "echo --no-cached a.ts | xargs git rm --cached"],
		["rm --cached with input before --", "echo --no-cached | xargs -I{} git rm --cached {} -- a.ts"],
		["a global option from input", "echo core.fsmonitor=x | xargs -I{} git -c {} add ."],
		["the subcommand from input", "echo checkout | xargs -I{} git {} a.ts"],
		["--cached is the replace string", "echo --no-cached | xargs -I--cached git rm --cached -- a.ts"],
	])("asks when %s", async (_why, command) => {
		await shellParserReady();
		expect(readOnlyCommand(command), command).toBe(false);
		expect(await workspace()(command), command).toMatchObject({ block: true });
	});
});

describe("sed's write commands", () => {
	it.each([
		"sed -n 's/a/b/p' f.txt",
		"sed 's/x/y/' f.txt > out.txt",
		"sed -E 's/(a|b)+/x/g' f.txt",
		"sed 's|/usr|/opt|g; /^#/d' f.txt",
		"sed 's/w/W/g' f.txt",
		"sed 'y/abc/xyz/' f.txt",
		"sed -n '$p' f.txt",
		"sed -n '/start/,/end/{s/a/b/;p;}' f.txt",
		"sed -e ':a' -e 'N;$!ba' -e 's/\\n/ /g' f.txt",
		"sed '1i\\\nwrite w here' f.txt",
		"sed '/x/a appended w text' f.txt",
		"sed '# w comment\np' f.txt",
		"sed -n '/x/w /dev/stdout' f.txt",
		"sed 's/a/b/w out.txt' f.txt",
		"sed -n '/err/W errors.txt' f.txt",
		"sed '1r header.txt' f.txt",
		"sed -i '' 's/a/b/' inside.txt",
		"sed 's/\\[//g' f.txt",
		"sed '/^[[:space:]]*$/d' f.txt",
		"sed -n '1~2p;$=' f.txt",
		"sed '0,/x/s//y/I' f.txt",
		"sed -e '/a/{' -e 'N' -e '}' f.txt",
		"sed '\\%/tmp%d' f.txt",
	])("runs `%s` unasked", async (command) => {
		await shellParserReady();
		expect(await workspace()(command), command).toBeUndefined();
	});

	it.each([
		["w command", `sed 'w ${outside}' f.txt`],
		["W command after an address", `sed -n '/x/W ${outside}' f.txt`],
		["s///w flag", `sed -n 's/a/b/w ${outside}' f.txt`],
		["s///gw flags and another delimiter", `sed 's#a#b#gw ${outside}' f.txt`],
		["w after ;", `sed 's/a/b/;w ${outside}' f.txt`],
		["w in a block", `sed '1{\nw ${outside}\n}' f.txt`],
		["w in a second -e", `sed -e p -e 'w ${outside}' f.txt`],
		["w in --expression=", `sed --expression='w ${outside}' f.txt`],
		["w with -i", `sed -i '' 'w ${outside}' inside.txt`],
		["the e flag runs the pattern space", "sed 's/.*/touch x/e' f.txt"],
		["the e command", "sed '1e touch x' f.txt"],
		["a script file", "sed -f script.sed f.txt"],
		["a script from an expansion", 'sed "$S" f.txt'],
		["an unknown command", "sed 'k' f.txt"],
		["w in an abbreviated --expr=", `sed --expr='w ${outside}' f.txt`],
		["w after a custom-delimited address", `sed '\\%x%w ${outside}' f.txt`],
		["its delimiter inside a bracket expression", "sed 's/[/]/x/' f.txt"],
	])("asks for %s", async (_why, command) => {
		await shellParserReady();
		expect(await workspace()(command), command).toMatchObject({ block: true });
	});

	it("names the files sed writes as reservation targets", async () => {
		await shellParserReady();
		expect(reservationTargets("sed -n 's/a/b/w out.txt' f.txt")).toEqual(["out.txt"]);
		expect(reservationTargets("sed -e '/x/w a.txt' -e '/y/W b.txt' f.txt")).toEqual(["a.txt", "b.txt"]);
		expect(reservationTargets("sed -n '/x/w /dev/stdout' f.txt")).toEqual([]);
	});
});

describe("git output options by subcommand", () => {
	it.each([
		"git ls-files -o --exclude-standard",
		"git ls-files -o",
		"git ls-files --others --exclude-standard -z",
		"git grep -o foo",
		"git diff -O order.txt",
		"ls | xargs git ls-files -o",
	])("reads `%s` as read-only, unasked", async (command) => {
		await shellParserReady();
		expect(readOnlyCommand(command), command).toBe(true);
		expect(reservationTargets(command), command).toEqual([]);
		expect(await workspace()(command), command).toBeUndefined();
	});

	it.each([
		["git diff --output=out.txt", ["out.txt"]],
		["git log -p --output out.txt", ["out.txt"]],
		["git -C sub diff --output=out.txt", ["sub/out.txt"]],
		["git format-patch -o patches HEAD~1", ["patches"]],
		["git format-patch -kopatches HEAD~1", ["patches"]],
		["git format-patch --output-directory=patches HEAD~1", ["patches"]],
		["git -C sub format-patch -o patches HEAD~1", ["sub/patches"]],
		["git archive -o out.zip HEAD", ["out.zip"]],
		["git archive --output out.tar HEAD", ["out.tar"]],
	])("names what `%s` writes", async (command, writes) => {
		await shellParserReady();
		expect(readOnlyCommand(command), command).toBe(false);
		expect(reservationTargets(command), command).toEqual(writes);
	});

	it.each([
		["diff --output", `git diff --output=${outside}`],
		["log --output", `git log --output ${outside}`],
		["format-patch -o", `git format-patch -o ${outside} HEAD~1`],
		["format-patch --output-directory", `git format-patch --output-directory ${outside}`],
		["an abbreviated --output-directory", `git format-patch --output-dir=${outside}`],
		["archive -o", `git archive -o ${outside} HEAD`],
		["an attached archive -o", `git archive -o${outside} HEAD`],
		["an abbreviated archive --output", "git archive --out=out.zip HEAD"],
		["grep -O runs a pager", "git grep -Ovim foo"],
		["grep -O clustered after -o", "git grep -oOvim foo"],
	])("asks for %s", async (_why, command) => {
		await shellParserReady();
		expect(readOnlyCommand(command), command).toBe(false);
		expect(await workspace()(command), command).toMatchObject({ block: true });
	});
});

describe("BSD sed -I", () => {
	it.each([
		"sed -I '' s/a/b/ inside.txt",
		"sed -I.bak s/a/b/ inside.txt",
		"sed -I .bak -e s/a/b/ inside.txt",
		"sed -nI '' s/a/b/p inside.txt",
	])("runs `%s` unasked", async (command) => {
		await shellParserReady();
		expect(await workspace()(command), command).toBeUndefined();
	});

	it.each([
		`sed -I '' s/a/b/ ${outside}`,
		`sed -I.bak s/a/b/ ${outside}`,
		`sed -I .bak s/a/b/ ${outside}`,
		`sed -nI '' -e s/a/b/ inside.txt ${outside}`,
	])("asks for `%s`, which rewrites a file outside the workspace", async (command) => {
		await shellParserReady();
		expect(await workspace()(command), command).toMatchObject({ block: true });
	});

	it("names the files -I rewrites, not its extension or script", async () => {
		await shellParserReady();
		expect(reservationTargets("sed -I '' s/a/b/ a.txt b.txt")).toEqual(["a.txt", "b.txt"]);
		expect(reservationTargets("sed -I .bak s/a/b/ a.txt")).toEqual(["a.txt"]);
		expect(reservationTargets("sed -I.bak -e s/a/b/ a.txt")).toEqual(["a.txt"]);
	});
});

describe("reservation gate: sed targets and git behind xargs", () => {
	const stops: Array<() => Promise<unknown>> = [];
	beforeEach(() => {
		vi.stubEnv("NODE_OPTIONS", "");
		vi.stubEnv("BASH_ENV", "");
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		for (const stop of stops.splice(0)) await stop();
	});

	async function member(db: string, cwd: string) {
		const fake = fakeHost();
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: db });
		const { reservationGate } = registerCollab(fake.api, team, {
			shellCommands: parsedShell,
			shellReadOnly: readOnlyCommand,
			shellWrites: (command) => shellParserReady().then(() => reservationTargets(command)),
		});
		const ctx = fakeCtx({ cwd });
		await fake.emit("session_start", {}, ctx);
		stops.push(() => fake.emit("session_shutdown", {}, ctx));
		const lock = (paths: string[]) =>
			fake.tools.get("coordinate").execute("c", { action: "lock", paths, reason: "auth" }, undefined, undefined, ctx);
		const gate = (command: string) => reservationGate({ toolName: "bash", input: { command } } as never, ctx);
		return { team, lock, gate };
	}

	async function held() {
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const owner = await member(db, cwd);
		const peer = await member(db, cwd);
		await owner.lock(["src/a.ts"]);
		return { owner, peer };
	}

	it.each([
		"sed -n 's/a/b/w src/a.ts' src/b.ts",
		"sed '/x/w src/a.ts' src/b.ts",
		"sed -e p -e 'W src/a.ts' src/b.ts",
		"echo src/a.ts | xargs git checkout --",
		"echo src/a.ts | xargs git rm",
		"sed -I '' s/a/b/ src/a.ts",
		"git format-patch -o src/a.ts HEAD~1",
		"git archive -o src/a.ts HEAD",
	])("refuses %j while a peer holds a reservation", async (command) => {
		const { owner, peer } = await held();
		expect(await peer.gate(command), command).toMatchObject({
			block: true,
			reason: expect.stringContaining(`reserved by ${owner.team.id}`),
		});
	});

	it.each([
		"git add src/a.ts",
		"echo src/a.ts | xargs git add",
		"echo src/a.ts | xargs git rm --cached --",
		"sed 's/a/b/' src/a.ts",
		"sed -n 's/a/b/w src/b.ts' src/a.ts",
		"sed -f script.sed src/b.ts",
		"sed -I '' s/a/b/ src/b.ts",
		"git ls-files -o --exclude-standard",
	])("runs %j while a peer holds a reservation", async (command) => {
		const { peer } = await held();
		expect(await peer.gate(command), command).toBeUndefined();
	});
});
