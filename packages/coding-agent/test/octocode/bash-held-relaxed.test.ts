import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parsedShell } from "../../src/octocode/permission/shell/commands.ts";
import { reservationTargets, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { readOnlyCommand } from "../../src/octocode/permission/shell/read-only.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** Lines that run while a peer holds src/a.ts, and lines that stay refused, through the real reservation gate. */
const RUNS = [
	"rg foo *.ts",
	"rg foo $(git ls-files)",
	"rg foo $(git ls-files src) | head -3",
	"env HOME=/tmp/x node script.js",
	"HOME=/tmp/x node script.js",
	"env TMPDIR=/tmp/x rg foo .",
	"env FOO=1 node script.js",
];
const REFUSED = [
	// A computed word may become an option that writes or runs a program.
	'find "$DIR" -name x',
	// HOME is read for configuration by programs that run commands from it.
	"env HOME=/tmp/x git fetch",
	"HOME=/tmp/x yarn install",
	// The assignments that swap which program runs stay refused, whatever the command.
	"env PATH=/tmp/x node script.js",
	"env LD_PRELOAD=/tmp/x.so node script.js",
	// A writing command is judged by the command, not by the wrapper.
	"env HOME=/tmp/x sed -i s/a/b/ src/a.ts",
	"env HOME=/tmp/x tee src/a.ts",
	"rg foo $(git ls-files) > src/a.ts",
	'rg foo $(git checkout "$REF")',
];

beforeAll(() => shellParserReady());

describe("the reservation gate while a peer holds src/a.ts", () => {
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

	it.each(RUNS)("runs %j", async (command) => {
		expect(await (await peer()).gate(command)).toBeUndefined();
	});

	it.each(REFUSED)("refuses %j", async (command) => {
		expect(await (await peer()).gate(command)).toMatchObject({ block: true });
	});
});
