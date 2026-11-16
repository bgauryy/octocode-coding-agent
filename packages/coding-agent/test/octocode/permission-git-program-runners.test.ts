import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { readOnlyRoleRefusal } from "../../src/octocode/permission/read-only-role.ts";
import { parsedShell } from "../../src/octocode/permission/shell/commands.ts";
import { reservationTargets, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { readOnlyCommand } from "../../src/octocode/permission/shell/read-only.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { PERMISSION_ENV, READ_ONLY_ENV, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * git forms that run a program or write where no option names a file. `cat-file --filters` runs the configured
 * `filter.<driver>` programs like `--textconv`; `format-patch` without `-o`/`--stdout` writes its patches into the
 * directory it runs in (`git -C`'s repository). A program named on the command line (`archive --exec`, `-c core.pager=…`,
 * `--upload-pack`, `GIT_SSH_COMMAND=…`) is not judged in workspace mode (R1-10), but the team reservation gate refuses it
 * while a peer holds a reservation; settings whose value cannot run anything (`color.ui`, `user.name`, `GIT_PAGER=cat`) run.
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
		gate({ type: "tool_call", toolCallId: `g${id++}`, toolName: "bash", input: { command } }, ctx);
}

const outside = path.join(os.homedir(), ".octocode-fr2c-never-written");
const readOnlyRole = (command: string) =>
	readOnlyRoleRefusal({ toolName: "bash", input: { command } }, tmp(), { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" });

describe("git cat-file --filters runs filter programs like --textconv", () => {
	it.each(["git cat-file --filters HEAD:a.txt", "git cat-file --batch --filters", "git cat-file --filt HEAD:a.txt"])(
		"`%s` is not read-only, asks in workspace mode and is refused to a read-only role",
		async (command) => {
			await shellParserReady();
			expect(readOnlyCommand(command)).toBe(false);
			expect(await workspace()(command)).toMatchObject({ block: true });
			expect(readOnlyRole(command)).toContain("read-only role");
		},
	);

	it("keeps `git cat-file -p` read-only", async () => {
		await shellParserReady();
		expect(readOnlyCommand("git cat-file -p HEAD:a.txt")).toBe(true);
		expect(await workspace()("git cat-file -p HEAD:a.txt")).toBeUndefined();
	});
});

describe("git format-patch without an output option writes into the directory it runs in", () => {
	it.each(["git format-patch -3", "git -C sub format-patch HEAD~1", "git format-patch --std -1"])(
		"a read-only role is refused `%s`",
		async (command) => {
			await shellParserReady();
			expect(readOnlyRole(command)).toContain("git format-patch");
		},
	);

	it.each([`cd ${outside} && git format-patch -3`, `git -C ${outside} format-patch -1`])(
		"workspace mode asks for `%s`, which writes outside",
		async (command) => {
			await shellParserReady();
			expect(await workspace()(command)).toMatchObject({ block: true });
		},
	);

	it.each(["git format-patch -3", "git -C sub format-patch HEAD~1", "git format-patch --stdout -3"])(
		"workspace mode runs `%s` unasked",
		async (command) => {
			await shellParserReady();
			expect(await workspace()(command)).toBeUndefined();
		},
	);

	it("lets a read-only role print patches with --stdout", async () => {
		await shellParserReady();
		expect(readOnlyRole("git format-patch --stdout -3")).toBeUndefined();
	});
});

describe("plan mode: a variable through which git runs a program", () => {
	it.each([
		"GIT_PAGER='touch x' git log",
		"PAGER=x git log",
		"GIT_EXTERNAL_DIFF=x git diff",
		"GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=x git log",
		"GIT_CONFIG_GLOBAL=evil.cfg git log",
		"env GIT_PAGER=x git log",
	])("`%s` is not read-only", async (command) => {
		await shellParserReady();
		expect(readOnlyCommand(command)).toBe(false);
	});

	it.each([
		"GIT_PAGER=cat git log",
		"GIT_PAGER= git log",
		"GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git status",
	])("`%s` stays read-only", async (command) => {
		await shellParserReady();
		expect(readOnlyCommand(command)).toBe(true);
	});
});

describe("workspace mode does not judge programs a git command line names (R1-10)", () => {
	it.each([
		"git -c core.pager='touch x' log",
		"GIT_SSH_COMMAND='ssh -i k' git fetch",
		"git fetch --upload-pack=x origin",
		"git archive --remote=r --exec=x HEAD",
	])("runs `%s` unasked", async (command) => {
		await shellParserReady();
		expect(await workspace()(command)).toBeUndefined();
	});
});

describe("team reservation gate: git forms that run a program the command line names", () => {
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
		return { lock, gate };
	}

	async function peer() {
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const owner = await member(db, cwd);
		const other = await member(db, cwd);
		await owner.lock(["src/a.ts"]);
		return other;
	}

	it.each([
		["archive --exec", "git archive --remote=r --exec='touch src/a.ts' HEAD"],
		["archive --exec as two words", "git archive --remote r --exec x HEAD"],
		["archive --exec abbreviated", "git archive --ex=x --remote=r HEAD"],
		["-c core.pager", "git -c core.pager='touch src/a.ts' log"],
		["-c alias with !", "git -c alias.x='!touch src/a.ts' x"],
		["-c in another letter case", "git -c CORE.SSHCOMMAND=x fetch"],
		["-c diff.external", "git -c diff.external=x diff"],
		["-c filter driver", "git -c filter.x.smudge=x checkout ."],
		["-c include.path", "git -c include.path=evil.cfg log"],
		["-c core.hooksPath", "git -c core.hooksPath=h commit -m x"],
		["-c credential.helper", "git -c credential.helper='!x' fetch"],
		["-c with a computed setting", 'git -c "$K" log'],
		["-c after -C", "git -C sub -c gpg.program=x log"],
		["--config-env=", "git --config-env=core.pager=P log"],
		["--config-env as two words", "git --config-env core.pager=P log"],
		["--exec-path=", "git --exec-path=bin x"],
		["fetch --upload-pack", "git fetch --upload-pack=x origin"],
		["fetch --upload-pack abbreviated, two words", "git fetch --upload x origin"],
		["pull --upload-pack", "git pull --upload-pack=x"],
		["clone -u", "git clone -u x r d"],
		["clone --template", "git clone --template=t r d"],
		["clone -c", "git clone -c core.fsmonitor=x r d"],
		["clone --config", "git clone --config core.hooksPath=h r"],
		["ls-remote --upload-pack", "git ls-remote --upload-pack=x ."],
		["ls-remote --exec", "git ls-remote --exec=x ."],
		["push --receive-pack", "git push --receive-pack=x origin"],
		["push --exec", "git push --exec x origin"],
		["rebase --exec", "git rebase -x 'touch src/a.ts' HEAD~2"],
		["submodule foreach", "git submodule foreach 'touch x'"],
		["bisect run", "git bisect run ./t.sh"],
		["difftool --extcmd", "git difftool --extcmd=x"],
		["GIT_SSH_COMMAND=", "GIT_SSH_COMMAND='touch src/a.ts' git fetch"],
		["GIT_SSH=", "GIT_SSH=x git fetch"],
		["GIT_PAGER=", "GIT_PAGER=x git log"],
		["GIT_EDITOR=", "GIT_EDITOR=x git commit"],
		["GIT_EXTERNAL_DIFF=", "GIT_EXTERNAL_DIFF=x git diff"],
		["GIT_CONFIG_KEY_0=", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=x git log"],
		["GIT_CONFIG_PARAMETERS=", `GIT_CONFIG_PARAMETERS="'core.pager'='x'" git log`],
		["GIT_CONFIG_GLOBAL= a file", "GIT_CONFIG_GLOBAL=evil.cfg git log"],
		["env GIT_SSH_COMMAND=", "env GIT_SSH_COMMAND=x git fetch"],
		["an exported variable", "export GIT_SSH_COMMAND=x; git fetch"],
		["a computed value", 'GIT_PAGER="$P" git log'],
	])("refuses %s while a peer holds a reservation", async (_why, command) => {
		const other = await peer();
		expect(await other.gate(command), command).toMatchObject({
			block: true,
			reason: expect.stringMatching(/runs a program|run a program/),
		});
	});

	it.each([
		"git -c color.ui=always log",
		"git -c user.name=x -c user.email=y commit -m m",
		"git -c commit.gpgsign=false commit -m m",
		"git -c core.pager=cat log",
		"git fetch",
		"git fetch -u origin",
		"git push -u origin main",
		"git log",
		"git --no-pager log",
		"git -C sub log",
		"GIT_PAGER=cat git log",
		"GIT_EDITOR=true git rebase --continue",
		"GIT_TERMINAL_PROMPT=0 git fetch",
		"GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git status",
		"git archive -o out.tar HEAD",
		"git cat-file -p HEAD:a.txt",
		"git format-patch --stdout -1",
		"git format-patch -1",
	])("runs %j while a peer holds a reservation", async (command) => {
		const other = await peer();
		expect(await other.gate(command), command).toBeUndefined();
	});
});
