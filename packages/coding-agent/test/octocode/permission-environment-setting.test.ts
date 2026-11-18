import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parsedShell } from "../../src/octocode/permission/shell/commands.ts";
import { reservationTargets, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { readOnlyCommand } from "../../src/octocode/permission/shell/read-only.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { onlyAllowedReaders } from "../../src/octocode/team/reservation-readers.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

// A variable the shell or a program reads (`PATH`, `HOME`, `LD_PRELOAD`, `IFS`) set anywhere in a line changes which
// program the reader after it runs: `PATH=/tmp/x; cat f` runs `/tmp/x/cat`. So does a `-v` test whose subscript bash
// expands (`[[ -v 'a[$(cmd)]' ]]` runs `cmd`).
const readers = async (command: string): Promise<boolean> => onlyAllowedReaders(await parsedShell(command));

beforeAll(async () => {
	await shellParserReady();
});

describe("a line that sets a program-facing variable is not read-only", () => {
	it.each([
		"PATH=/tmp/x; cat a.ts",
		"PATH=/tmp/x cat a.ts",
		"PATH=/tmp/x && cat a.ts",
		"HOME=/tmp/x; git log",
		"LD_PRELOAD=/tmp/x.so; cat a.ts",
		"BASH_ENV=/tmp/x; cat a.ts",
		"IFS=/; cat a.ts",
		"echo $(PATH=/tmp/x; cat a.ts)",
		"NODE_OPTIONS=--require=/tmp/x.js; cat a.ts",
		"RIPGREP_CONFIG_PATH=/tmp/x rg a src",
		"[[ -v 'a[$(touch /tmp/p)]' ]] && cat a.ts",
	])("%s", (command) => {
		expect(readOnlyCommand(command)).toBe(false);
	});

	it("a name already in the inherited environment is exported, so setting it reaches the programs after it", () => {
		const line = "OCTOCODE_TEST_EXPORTED=/tmp/x; cat a.ts";
		expect(readOnlyCommand(line)).toBe(true);
		vi.stubEnv("OCTOCODE_TEST_EXPORTED", "1");
		try {
			expect(readOnlyCommand(line)).toBe(false);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it.each([
		'f=a.ts; cat "$f"',
		'n=3; head -n "$n" a.ts',
		"D=/tmp/out; cat a.ts",
		"LC_ALL=C sort a.ts",
		"GIT_PAGER=cat git log",
		"GIT_PAGER=cat; git log",
	])("%s stays read-only", (command) => {
		expect(readOnlyCommand(command)).toBe(true);
	});
});

describe("the reservation reader check refuses hidden environment changes and subscript tests", () => {
	it.each([
		'PATH=/tmp/x; cat "$f"',
		"PATH=5; cat a.ts",
		"IFS=5; cat a.ts",
		"HOME=0; git log",
		'export PATH=/tmp/x; cat "$f"',
		'export f=a.ts; cat "$f"',
		'declare -x f=a.ts; cat "$f"',
		'declare -n r=PATH; r=/tmp/x; cat "$f"',
		'local PATH=/tmp/x; cat "$f"',
		'readonly PATH=/tmp/x; cat "$f"',
		"{ PATH=/tmp/x; cat a.ts; }",
		"if true; then PATH=/tmp/x; fi; cat a.ts",
		"unset PATH; cat a.ts",
		"[[ -v 'a[$(touch /tmp/p)]' ]] && cat a.ts",
		"[[ -v a[$x] ]] && cat a.ts",
		"[[ -v $name ]] && cat a.ts",
		"[ -v 'a[$(touch /tmp/p)]' ] && cat a.ts",
	])("%s", async (command) => {
		expect(await readers(command)).toBe(false);
	});

	it.each([
		'f=a.ts; cat "$f"',
		'X=a Y=b; cat "$f"',
		'files=$(rg -l x); head "$files"',
		"LC_ALL=C; sort a.ts",
		"GIT_PAGER=cat; git log",
		"export GIT_PAGER=cat; git log",
		"N=3; cat a.ts",
		'S=$((1 + 2)); cat "$f"',
		"declare -a list; cat a.ts",
		"unset tmp; cat a.ts",
		'[[ -f "$f" ]] && cat "$f"',
		"[[ -v name ]] && cat a.ts",
		"[[ -v a[0] ]] && cat a.ts",
		"[ -v 'a[@]' ] && cat a.ts",
	])("%s stays allowed", async (command) => {
		expect(await readers(command)).toBe(true);
	});
});

describe("reservation gate: environment set before a reader", () => {
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

	it("refuses a line that swaps the program a reader runs while a peer holds a reservation", async () => {
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const owner = await member(db, cwd);
		const peer = await member(db, cwd);
		await owner.lock(["src/a.ts"]);
		for (const command of [
			'PATH=/tmp/x; cat "$f"',
			"PATH=/tmp/x; cat a.ts",
			"PATH=/tmp/x cat a.ts",
			"[[ -v 'a[$(touch /tmp/p)]' ]] && cat a.ts",
		])
			expect(await peer.gate(command), command).toMatchObject({
				block: true,
				reason: expect.stringContaining(`reserved by ${owner.team.id}`),
			});
		for (const command of ['f=a.ts; cat "$f"', "LC_ALL=C sort a.ts"])
			expect(await peer.gate(command), command).toBeUndefined();
	});
});
