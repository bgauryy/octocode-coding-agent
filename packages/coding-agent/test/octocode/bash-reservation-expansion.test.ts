import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parsedShell } from "../../src/octocode/permission/shell/commands.ts";
import { reservationTargets, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { readOnlyCommand } from "../../src/octocode/permission/shell/read-only.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * A write path spelled with a variable is checked on its expansion when the line fixes it (an assignment or loop word in
 * the same line, `$HOME`, `~`): outside every reservation the command runs. A path the line cannot fix (an unset
 * variable, a substitution, a glob) stays refused, and so does an expansion into a reserved path.
 */
const ALLOWED = [
	"for c in a b; do rg x . > .octocode/agent/tmp/test-$c.log; done",
	"for c in a b; do rg x $c.md > .octocode/agent/tmp/test-$c.log; done",
	"for c in a b; do for d in x y; do rg q docs/${c}-${d}.md > .octocode/agent/tmp/${c}-${d}.log; done; done",
	"F=docs/a.md; sort -u $F > .octocode/agent/tmp/o.log",
	"OUT=.octocode/agent/tmp/o.log; rg x . > $OUT",
	'D=docs; for f in a b; do cat "$D/$f.md" > "$D/$f.out"; done',
	"rg x $HOME/notes",
	"rg x ~/notes",
];
const KEPT: Array<[string, string]> = [
	["sort $UNSET list", "$UNSET"],
	["for f in $(ls); do sort $f list > out.txt; done", "$f"],
	["for f in *.md; do sort $f list > out.txt; done", "$f"],
	["for c in a b; do rg x $c.md; c=-o; sort $c list; done", "$c"],
	["HOME=-o; sort $HOME list", "HOME"],
];
const RESERVED = [
	"for c in a b; do rg x . > src/$c.ts; done",
	"F=src/a.ts; rg x . > $F",
	"for c in a b; do sed -i s/x/y/ src/$c.ts; done",
	"D=src; touch $D/a.ts",
	"F=--output=src/a.ts; git log $F",
];

beforeAll(() => shellParserReady());

describe("the reservation gate with variable-spelled write paths while a peer holds src/a.ts", () => {
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

	it.each(ALLOWED)("runs %j when the expanded path is outside every reservation", async (command) => {
		const { peer } = await peerOfHolder();
		expect(await peer.gate(command)).toBeUndefined();
	});

	it.each(KEPT)("refuses %j, naming what it cannot expand", async (command, why) => {
		const { peer } = await peerOfHolder();
		const refusal = await peer.gate(command);
		expect(refusal, command).toMatchObject({ block: true });
		expect(refusal?.reason, command).toContain(why);
	});

	it.each(RESERVED)("refuses %j: it expands into the reserved path", async (command) => {
		const { owner, peer } = await peerOfHolder();
		const refusal = await peer.gate(command);
		expect(refusal, command).toMatchObject({ block: true });
		expect(refusal?.reason, command).toContain(`reserved by ${owner.team.id}`);
		expect(refusal?.reason, command).toContain("src/a.ts");
	});
});
