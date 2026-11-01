import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { parsedShell } from "../../src/octocode/permission/shell/commands.ts";
import { reservationTargets, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { readOnlyCommand } from "../../src/octocode/permission/shell/read-only.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { PERMISSION_ENV } from "../../../common/src/env.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * A command whose program name is computed (`$X`, `$(…)`, backticks) hides which program runs, so nothing about its
 * writes can be read. Workspace mode must ask (with no UI an ask is a refusal), like a wrapper whose command cannot be
 * found; the team gate treats it as opaque while a peer holds a reservation. A variable used only as an argument changes
 * nothing.
 */
function workspaceGate() {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	const permission = new Permission({ api: fakeHost().api, env: { [PERMISSION_ENV]: "workspace" }, isSubagent: false });
	const ctx = fakeCtx({ cwd, hasUI: false });
	permission.start(ctx);
	const gate = permissionGate({ permission, provenance: { check: () => undefined }, powershell: async () => false });
	let id = 0;
	return (command: string) =>
		gate({ type: "tool_call", toolCallId: `c${id++}`, toolName: "bash", input: { command } }, ctx);
}

const COMPUTED = [
	"X=cp; $X a ~/.zshrc",
	"$(echo cp) a ~/.zshrc",
	"`echo cp` a ~/.zshrc",
	"${X} a b",
	'"$X" a b',
	"true && $CMD a b",
	"echo x | $CMD out",
	"nohup $X a b",
];

const ARGUMENTS_ONLY = [
	"echo $HOME",
	'cd "$DIR"',
	"npm run $SCRIPT",
	'cat "$FILE"',
	"ls $DIR/src",
	"git log -n $N",
	'[ -f "$F" ] && echo ok',
	'test -n "$X" && echo set',
	"X=1; echo $X",
	"echo $(date) `whoami`",
	'for f in *.ts; do wc -l "$f"; done',
	"./scripts/build.sh $ARG",
	"~/bin/tool --flag $VALUE",
];

describe("a computed program name in workspace mode", () => {
	it.each(COMPUTED)("asks before %j", async (command) => {
		const result = await workspaceGate()(command);
		expect(result?.block, command).toBe(true);
	});

	it.each(ARGUMENTS_ONLY)("runs %j unasked", async (command) => {
		expect(await workspaceGate()(command)).toBeUndefined();
	});
});

describe("reservation gate: a computed program name", () => {
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

	it("refuses a computed program while a peer holds a reservation, and lets argument variables run", async () => {
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const owner = await member(db, cwd);
		const peer = await member(db, cwd);
		await owner.lock(["src/a.ts"]);
		for (const command of ["X=cp; $X b.ts src/a.ts", "$(echo cp) b.ts src/a.ts"]) {
			const refused = await peer.gate(command);
			expect(refused, command).toMatchObject({
				block: true,
				reason: expect.stringContaining(`reserved by ${owner.team.id}`),
			});
			expect(refused?.reason).toContain("computed");
		}
		for (const command of ["npm run $SCRIPT", 'cat "$FILE"', "ls $DIR/src"])
			expect(await peer.gate(command), command).toBeUndefined();
	});
});
