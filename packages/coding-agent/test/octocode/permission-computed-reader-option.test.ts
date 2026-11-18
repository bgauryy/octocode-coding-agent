import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
 * A reader with a writing option (`sort -o`, `rg --pre`, `find -delete`, `git log --output`) given a word the line does not
 * spell out (`$X`, `"$X"`, `$"x"`) before `--` may receive that option at run time. While a peer holds a reservation the team
 * gate refuses such a line, unless the word cannot become an option: it starts with a literal character and has no unquoted
 * `$` or backtick (a glob or a quoted expansion does not split), or it is a quoted value right after a value-taking option.
 * Workspace mode is unchanged: it runs these unasked, like inline interpreter code.
 */
const REFUSED = [
	"sort $X in",
	'sort "$X" in',
	'rg "$PAT" src',
	'rg "$PAT" src/*.ts',
	'find "$DIR" -name x',
	"uniq in $OUT",
	'git log "$REF"',
	'git diff "$BASE"...HEAD',
	"git show $BASE:src/a.ts",
	"tree $D",
	'sort $"x" in',
	'sort a$"x" in',
	"rg x src/$X",
	"sort *.txt",
	"sort {-o,x} in",
	'sort "$@"',
	"sort ${X:--o} in",
	'rg x "$X"/y',
	"date -v-${m}M",
	"sort ~x in",
	'git log --output="$X"',
	'sort -n"$X" in',
	'rg x ""$X',
];
/**
 * The entries of `REFUSED` the gate now lets run (RFC 2026-11-11 core tools, step B4): a line made only of readers with
 * no write form (`files/bash/reservation-readers.ts`). Plan mode still reads them as not read-only.
 */
const ALLOWED_READERS = new Set([
	'rg "$PAT" src',
	'rg "$PAT" src/*.ts',
	'git log "$REF"',
	'git diff "$BASE"...HEAD',
	"git show $BASE:src/a.ts",
	"rg x src/$X",
	'rg x "$X"/y',
	'rg x ""$X',
]);
const GATE_REFUSED = REFUSED.filter((command) => !ALLOWED_READERS.has(command));
const RUNS = [
	'rg -n "needle" src/*.ts',
	'rg -e "$PAT" src/*.ts',
	'rg -- "$PAT" src/*.ts',
	'sort -- "$F"',
	"rg x src/*.ts",
	'find . -name "$N"',
	'find src -name "*.ts" -newer "$REF"',
	'git log --since "$D" --author "$A"',
	'git log --since="$D"',
	'cat "$F" | sort',
	'grep "$PAT" -r src',
	'wc -l "$F"',
	'rg x ./"$F"',
	'rg x "src/$X"',
	"find src/{a,b} -name x",
	'echo $"hello"',
	'rg x ."$X"',
	'git log --author="$A" -- src',
];

beforeAll(() => shellParserReady());

describe("team reservation gate: computed words given to readers with a writing option", () => {
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

	async function peerOfHolder() {
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const owner = await member(db, cwd);
		const peer = await member(db, cwd);
		await owner.lock(["src/a.ts"]);
		return { owner, peer };
	}

	it("refuses a computed word that may become a writing option, and names the word and the respelling", async () => {
		const { owner, peer } = await peerOfHolder();
		expect(GATE_REFUSED).toHaveLength(REFUSED.length - ALLOWED_READERS.size);
		for (const command of GATE_REFUSED)
			expect(await peer.gate(command), command).toMatchObject({
				block: true,
				reason: expect.stringContaining(`reserved by ${owner.team.id}`),
			});
		const refusal = await peer.gate("sort $X in");
		expect(refusal?.reason).toContain("`$X`");
		expect(refusal?.reason).toContain("--");
	});

	it("runs everyday reads whose computed words cannot become an option", async () => {
		const { peer } = await peerOfHolder();
		for (const command of RUNS) expect(await peer.gate(command), command).toBeUndefined();
	});

	it("runs a line of allowed readers even with a computed word", async () => {
		const { peer } = await peerOfHolder();
		for (const command of ALLOWED_READERS) expect(await peer.gate(command), command).toBeUndefined();
	});

	it("runs every one of them when no peer holds a reservation", async () => {
		const cwd = tmp();
		const alone = await member(path.join(tmp(), "team.sqlite"), cwd);
		for (const command of REFUSED) expect(await alone.gate(command), command).toBeUndefined();
	});
});

describe("plan mode reads the same rule", () => {
	it.each(REFUSED)("%s is not read-only", (command) => {
		expect(readOnlyCommand(command)).toBe(false);
	});
	it.each(RUNS.filter((command) => !command.includes("|")))("%s is read-only", (command) => {
		expect(readOnlyCommand(command)).toBe(true);
	});
});

describe('$"…" is a computed word', () => {
	it("parsedShell gives no literal for a translated string, standalone or joined", async () => {
		for (const command of ['sort $"x" in', 'sort a$"x" in']) {
			const entry = (await parsedShell(command))?.commands[0];
			expect(entry?.literals[1], command).toBeUndefined();
			expect(entry?.words[1], command).toMatch(/^a?\$"x"$/);
		}
		const escaped = (await parsedShell('sort \\$"x" in'))?.commands[0];
		expect(escaped?.literals[1]).toBe("$x");
	});
});

describe("workspace mode is unchanged", () => {
	it.each(["sort $X in", 'rg "$PAT" src', 'sort $"x" in'])("runs %j unasked", async (command) => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".git"));
		const permission = new Permission({
			api: fakeHost().api,
			env: { [PERMISSION_ENV]: "workspace" },
			isSubagent: false,
		});
		const ctx = fakeCtx({ cwd, hasUI: false });
		permission.start(ctx);
		const gate = permissionGate({ permission, provenance: { check: () => undefined }, powershell: async () => false });
		expect(
			await gate({ type: "tool_call", toolCallId: "q", toolName: "bash", input: { command } }, ctx),
		).toBeUndefined();
	});
});
