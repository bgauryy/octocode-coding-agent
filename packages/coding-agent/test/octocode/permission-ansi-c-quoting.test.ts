import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { recordShellMutation } from "../../src/octocode/files/bash/mutation.ts";
import { currentMutationRevision } from "../../src/octocode/files/feedback/revisions.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { parsedShell } from "../../src/octocode/permission/shell/commands.ts";
import { reservationTargets, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { planReadOnly } from "../../src/octocode/permission/shell/plan-reads.ts";
import { readOnlyCommand } from "../../src/octocode/permission/shell/read-only.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { AGENT_SCRATCH_ENV, PERMISSION_ENV, READ_ONLY_ENV, SUBAGENT_ENV } from "../../../common/src/env.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * Bash's ANSI-C quoting (`$'…'`, where `\'` is a literal quote) and a `#` comment holding a quote end a quoted string
 * where a naive scan of quotes keeps it open. A command between two such words then looks like quoted text: the
 * read-only shortcut must not decide alone, so the line is checked as bash runs it (bash ran every hidden command here).
 */
const OUTSIDE = path.join(os.homedir(), ".fr1-never-written");
const HIDDEN = [
	`echo $'\\'' ; rm -rf ${OUTSIDE} ; echo $'\\''`,
	`echo $'\\'' ; cp a ${OUTSIDE} ; echo $'\\''`,
	`echo a #'\nrm -rf ${OUTSIDE}\necho b #'`,
	`echo "\${ rm -rf ${OUTSIDE}; }"`,
];
const ORDINARY = [
	"printf $'a\\tb\\n'",
	"grep $'\\t' file",
	"cut -d $'\\t' -f1 file",
	"echo $'it\\'s'",
	'echo $"hello"',
];

beforeAll(() => shellParserReady());

function workspaceGate() {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	const permission = new Permission({ api: fakeHost().api, env: { [PERMISSION_ENV]: "workspace" }, isSubagent: false });
	const ctx = fakeCtx({ cwd, hasUI: false });
	permission.start(ctx);
	const gate = permissionGate({ permission, provenance: { check: () => undefined }, powershell: async () => false });
	let id = 0;
	return (command: string) =>
		gate({ type: "tool_call", toolCallId: `q${id++}`, toolName: "bash", input: { command } }, ctx);
}

describe("ANSI-C quoting in workspace mode", () => {
	it.each(HIDDEN)("asks before %j", async (command) => {
		expect((await workspaceGate()(command))?.block, command).toBe(true);
	});

	it.each(ORDINARY)("runs %j unasked", async (command) => {
		expect(await workspaceGate()(command)).toBeUndefined();
	});

	it("names the write a quote-hidden command makes, for reservations", () => {
		expect(reservationTargets("echo $'\\'' ; echo x > src/r.ts ; echo $'\\''")).toContain("src/r.ts");
		expect(reservationTargets("echo a #'\necho x > src/r.ts\necho b #'")).toContain("src/r.ts");
	});
});

describe("the read-only classifier (plan mode, the team gate, PowerShell callers)", () => {
	it.each([
		...HIDDEN,
		"x='a[$(rm -rf /tmp/x)]'; echo $((x))",
		"sort $'-o' out in",
		"sort $'\\x2do' out in",
		'sort $"-o" out in',
	])("is not read-only: %j", (command) => {
		expect(readOnlyCommand(command)).toBe(false);
		expect(planReadOnly(command)).toBe(false);
	});

	it.each(ORDINARY)("is read-only: %j", (command) => {
		expect(planReadOnly(command)).toBe(true);
	});

	it("reads a PowerShell line by PowerShell's escapes and comments, not bash's", async () => {
		const hidden = "echo a <#' #> ; Remove-Item x ; #'";
		expect(readOnlyCommand(hidden, "powershell")).toBe(false);
		expect(readOnlyCommand("echo `' ; Remove-Item x ; echo `'", "powershell")).toBe(false);
		expect(readOnlyCommand("ls", "powershell")).toBe(true);
		const id = "fr1-powershell";
		const before = currentMutationRevision(id);
		await recordShellMutation(hidden, tmp(), id, true);
		expect(currentMutationRevision(id)).not.toBe(before);
	});

	it("stales verification receipts after a quote-hidden write", async () => {
		const id = "fr1-bash";
		const before = currentMutationRevision(id);
		await recordShellMutation("echo $'\\'' ; echo x > out.txt ; echo $'\\''", tmp(), id);
		expect(currentMutationRevision(id)).not.toBe(before);
	});
});

describe("a read-only role", () => {
	it("refuses a write hidden behind ANSI-C quoting, and runs ordinary $'…' reads", async () => {
		const cwd = fs.realpathSync(tmp());
		execSync("git init -q", { cwd });
		fs.mkdirSync(path.join(cwd, "src"));
		fs.writeFileSync(path.join(cwd, "src/a.ts"), "original");
		const env = {
			[SUBAGENT_ENV]: "1",
			[READ_ONLY_ENV]: "1",
			[AGENT_SCRATCH_ENV]: path.join(cwd, ".octocode/tmp/agents/rev-1"),
			[PERMISSION_ENV]: "full",
		};
		const ctx = fakeCtx({ cwd, hasUI: false });
		const permission = new Permission({ api: fakeHost().api, env, isSubagent: true });
		permission.start(ctx);
		const gate = permissionGate({ permission, provenance: { check: () => undefined }, env });
		const run = async (command: string) => {
			const verdict = await gate({ type: "tool_call", toolCallId: command, toolName: "bash", input: { command } }, ctx);
			if (!verdict?.block) execSync(command, { cwd, stdio: "ignore", shell: "/bin/bash" });
			return verdict;
		};
		const refused = await run("echo $'\\'' ; echo changed > src/a.ts ; echo $'\\''");
		expect(refused).toMatchObject({ block: true, reason: expect.stringContaining("read-only role") });
		expect(fs.readFileSync(path.join(cwd, "src/a.ts"), "utf8")).toBe("original");
		expect(await run("grep $'\\t' src/a.ts || true")).toBeUndefined();
	});
});

describe("reservation gate: a command hidden behind ANSI-C quoting", () => {
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
		const gate = (command: string, toolName = "bash") =>
			reservationGate({ toolName, input: { command } } as never, ctx);
		return { team, lock, gate };
	}

	it("refuses hidden inline code and hidden writes while a peer holds a reservation", async () => {
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const owner = await member(db, cwd);
		const peer = await member(db, cwd);
		await owner.lock(["src/a.ts"]);
		const inline = await peer.gate(`echo $'\\'' ; python3 -c "open('src/a.ts','w')" ; echo $'\\''`);
		expect(inline).toMatchObject({ block: true, reason: expect.stringContaining(`reserved by ${owner.team.id}`) });
		expect(inline?.reason).toContain("runs python3 on inline code");
		expect(await peer.gate("echo $'\\'' ; echo x > src/a.ts ; echo $'\\''")).toMatchObject({
			block: true,
			reason: expect.stringContaining(`reserved by ${owner.team.id}`),
		});
		expect(await peer.gate("echo a <#' #> ; Remove-Item src/a.ts ; #'", "powershell")).toMatchObject({ block: true });
		for (const command of ORDINARY) expect(await peer.gate(command), command).toBeUndefined();
		expect(await peer.gate("ls", "powershell")).toBeUndefined();
	});
});
