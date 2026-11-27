import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parsedShell } from "../../src/octocode/permission/shell/commands.ts";
import { reservationTargets, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { readOnlyCommand } from "../../src/octocode/permission/shell/read-only.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

// Arithmetic contexts evaluate a named variable's value as an expression, subscripts and command substitution included
// (bash manual, "Shell Arithmetic"): a name whose value the line does not show is code the parse cannot read, like `eval $x`.
const opaque = async (command: string): Promise<boolean> =>
	(await parsedShell(command))?.commands.some((entry) => entry.opaque === true) ?? true;

beforeAll(async () => {
	await shellParserReady();
});

describe("arithmetic on a variable whose value the line does not show is opaque to the team gate", () => {
	it.each([
		"echo $((x))",
		"echo $(( x + 1 ))",
		"((x))",
		"echo $[x]",
		"let y=x",
		"declare -i n=x",
		"echo ${a[x]}",
		"echo ${s:x:1}",
		"[[ x -eq 1 ]]",
		"[[ $n -gt 3 ]] && echo big",
		"x=$1; echo $((x))",
		"read n; echo $((n + 1))",
		"for i in $(cat list); do echo $((i * 2)); done",
	])("%s", async (command) => {
		expect(await opaque(command)).toBe(true);
	});
});

describe("reservation gate: hidden arithmetic", () => {
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

	it("lets the reservation gate ignore hidden arithmetic, which the permission policy still treats as not read-only", async () => {
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const owner = await member(db, cwd);
		const peer = await member(db, cwd);
		await owner.lock(["src/a.ts"]);
		for (const command of ['x="$1"; echo $((x))', "echo ${a[n]}"]) {
			expect(await peer.gate(command), command).toBeUndefined();
			expect(readOnlyCommand(command), command).toBe(false);
		}
		// The arithmetic is no longer the cause, but a stage that is no reader (`read` assigns) still is.
		expect(await peer.gate("read n; echo ${a[n]}")).toMatchObject({
			block: true,
			reason: expect.stringContaining(`reserved by ${owner.team.id}`),
		});
		for (const command of ["i=0; while [ $i -lt 3 ]; do i=$((i+1)); done", "echo $((1 + 2))"])
			expect(await peer.gate(command), command).toBeUndefined();
	});
});

describe("arithmetic on numbers and on names the line gives numbers stays readable", () => {
	it.each([
		"echo $((1 + 2))",
		"echo $((0x1F * 2))",
		"i=0; i=$((i+1)); echo $i",
		"i=0; while [ $i -lt 3 ]; do i=$((i+1)); done",
		"for ((i=0; i<3; i++)); do echo $i; done",
		"for i in 1 2 3; do echo $((i * 2)); done",
		"n=5; ((n++)); echo $n",
		"echo $((RANDOM % 10))",
		"[[ $# -gt 0 ]] && echo args",
		"echo ${arr[0]} ${#arr[@]}",
		"echo $(( $(wc -l < notes.txt) + 1 ))",
		"echo ${name:-default}",
	])("%s", async (command) => {
		expect(await opaque(command)).toBe(false);
	});
});
