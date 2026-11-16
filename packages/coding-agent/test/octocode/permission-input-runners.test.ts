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
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { PERMISSION_ENV } from "@octocodeai/octocode-common/env";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * `xargs` and `parallel` run their command with words read at run time (standard input, an argument file, `:::` lists):
 * each may become an operand or an option (`-delete`, `-o f`), and with a replace string even the program. A program
 * whose writes the guard reads from its words cannot be judged from the visible ones, so workspace mode asks (with no UI
 * an ask is a refusal) and the reservation gate refuses it while a peer holds a path. A program that writes nothing
 * whatever its words (`grep`, `wc`, `cat`) keeps running unasked.
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

const outside = path.join(os.homedir(), ".octocode-fr2-never-written");

/** Commands whose program gets its write target, write option or the program itself from its input. */
const FROM_INPUT: Array<[string, string]> = [
	["uniq takes its output operand from input", `echo ${outside} | xargs uniq /dev/null`],
	["find takes -delete from input", `echo -delete | xargs find ${outside}`],
	["sort takes -o from input", `echo -o ${outside} | xargs sort`],
	["tee takes its file from input", `echo ${outside} | xargs tee`],
	["git takes --output from input", `echo --output=${outside} | xargs git diff`],
	["a path-spelled xargs", `echo ${outside} | /usr/bin/xargs tee`],
	["a shell runs the replaced script", `echo cp a ${outside} | xargs -I{} sh -c {}`],
	["the program is the replaced word", `echo cp | xargs -I{} {} a ${outside}`],
	["a wrapper after xargs runs the input", `echo cp a ${outside} | xargs sudo`],
	["env after xargs runs the input", `echo cp a ${outside} | xargs -n3 env`],
	["parallel appends its input", `echo ${outside} | parallel tee`],
	["parallel runs its input lines", `echo cp a ${outside} | parallel`],
	["parallel runs its ::: arguments", `parallel ::: "cp a ${outside}"`],
	["parallel replaces {} in the program", `parallel {} a ${outside} ::: cp`],
	["a parallel option that writes", `parallel --results ${outside} echo ::: a`],
];

describe("programs behind an input runner ask in workspace mode", () => {
	it.each(FROM_INPUT)("%s", async (_why, command) => {
		await shellParserReady();
		expect(readOnlyCommand(command), command).toBe(false);
		expect(await workspace()(command), command).toMatchObject({ block: true });
	});

	it.each([
		"git ls-files | xargs grep -n foo",
		"find . -name '*.ts' | xargs wc -l",
		"ls | xargs cat",
		"find . -name '*.ts' -print0 | xargs -0 head -n 5",
		"ls | xargs -n1 basename",
		"ls | xargs",
		"xargs -0 grep x",
		"parallel -j4 wc -l ::: a b",
	])("still runs `%s` unasked and read-only", async (command) => {
		await shellParserReady();
		expect(readOnlyCommand(command), command).toBe(true);
		expect(await workspace()(command), command).toBeUndefined();
	});

	it("keeps running a program it does not model, as without xargs", async () => {
		const run = workspace();
		expect(await run("git ls-files | xargs npx prettier --write")).toBeUndefined();
		expect(await run("npx prettier --write a.ts")).toBeUndefined();
	});
});

describe("sed -i '' (BSD sed's empty backup suffix)", () => {
	it.each([
		"sed -i '' s/a/b/ inside.txt",
		'sed -i "" s/a/b/ inside.txt',
		"sed -i '' -e s/a/b/ inside.txt",
		"sed -i '' '/^$/d' inside.txt",
		"sed -i.bak s/a/b/ inside.txt",
		"sed -i -e s/a/b/ inside.txt",
	])("runs `%s` unasked", async (command) => {
		expect(await workspace()(command)).toBeUndefined();
	});

	it.each([
		`sed -i '' s/a/b/ ${outside}`,
		`sed -i '' -e s/a/b/ inside.txt ${outside}`,
		`sed -i.bak -f script.sed ${outside}`,
		"sed -i '' s/a/b/ $FILE",
	])("asks before `%s`", async (command) => {
		expect(await workspace()(command)).toMatchObject({ block: true });
	});
});

describe("a here-string is input, not a target", () => {
	it("judges `cat > f <<< hi` like the heredoc form", async () => {
		const run = workspace();
		expect(await run("cat > file.txt <<'EOF'\nhi\nEOF")).toBeUndefined();
		expect(await run("cat > file.txt <<< hi")).toBeUndefined();
		expect(await run("tr a b > out.txt <<< hi 2>&1")).toBeUndefined();
		expect(reservationTargets("cat > file.txt <<< hi")).toEqual(["file.txt"]);
	});

	it.each([`cat > ${outside} <<< hi`, `cat > out.txt <<< "$(cp a ${outside})"`, `cat > out.txt <<< hi > ${outside}`])(
		"still asks before `%s`",
		async (command) => {
			expect(await workspace()(command)).toMatchObject({ block: true });
		},
	);
});

describe("reservation gate: a program behind an input runner", () => {
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
		"echo src/a.ts | xargs uniq /dev/null",
		"echo src/a.ts | xargs tee",
		"echo -delete | xargs find src/a.ts",
		"echo -o src/a.ts | xargs sort",
		"echo src/a.ts | xargs rm",
		"echo 'cp b.ts src/a.ts' | xargs -I{} sh -c {}",
		"echo src/a.ts | parallel tee",
	])("refuses %j while a peer holds a reservation", async (command) => {
		const { owner, peer } = await held();
		const refused = await peer.gate(command);
		expect(refused, command).toMatchObject({
			block: true,
			reason: expect.stringContaining(`reserved by ${owner.team.id}`),
		});
	});

	it("still runs readers behind xargs and the here-string form", async () => {
		const { peer } = await held();
		expect(await peer.gate("git ls-files | xargs grep -n foo")).toBeUndefined();
		expect(await peer.gate("ls | xargs wc -l")).toBeUndefined();
		expect(await peer.gate("cat > src/b.ts <<< hi")).toBeUndefined();
		expect(await peer.gate("cat > src/a.ts <<< hi")).toMatchObject({ block: true });
	});
});
