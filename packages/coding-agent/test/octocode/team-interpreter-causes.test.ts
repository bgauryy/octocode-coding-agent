import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsedShell } from "../../src/octocode/permission/shell/commands.ts";
import { interpreterRefusal } from "../../src/octocode/team/interpreter.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const CONFINED = "node --permission --no-experimental-sqlite --allow-fs-read=*";

/** The confined form with the words `export` and `alias` where they are only data: Node's code, a path or an argument. */
const DATA_WORDS = [
	`${CONFINED} -e 'console.log(require("fs").readdirSync(".octocode/code/temp/agents/x/export"))'`,
	`${CONFINED} -e "export const alias = 1"`,
	`${CONFINED} -e 'x' .octocode/export/alias.json`,
	`${CONFINED} -e 'x' > out/export.txt`,
	`node --permission --no-experimental-sqlite --allow-fs-read=/repo/export -p '[1].alias'`,
];

/** A shell word that runs `export` or `alias`, beside the confined form: each can change what the next command is or reads. */
const SHELL_WORDS: Array<[string, string]> = [
	[`export X=1; ${CONFINED} -e 'x'`, "export"],
	[`export NODE_OPTIONS=--allow-fs-write=*; ${CONFINED} -e 'x'`, "NODE_OPTIONS"],
	[`alias node=cat; ${CONFINED} -e 'x'`, "alias"],
	[`alias ll='ls -l' && ${CONFINED} -e 'x'`, "alias"],
	[`'export' X=1; ${CONFINED} -e 'x'`, "export"],
	[`"alias" ll=ls; ${CONFINED} -e 'x'`, "alias"],
	[`ex''port X=1; ${CONFINED} -e 'x'`, "export"],
	[`ex"po"rt X=1; ${CONFINED} -e 'x'`, "export"],
	[`\\export X=1; ${CONFINED} -e 'x'`, "export"],
	[`{ export X=1; }; ${CONFINED} -e 'x'`, "export"],
	[`if true; then export X=1; fi; ${CONFINED} -e 'x'`, "export"],
	[`builtin export X=1; ${CONFINED} -e 'x'`, "export"],
	[`${CONFINED} -e 'x'; export X=1`, "export"],
	[`${CONFINED} -e 'x' export`, "export"],
	[`${CONFINED} -e 'export x'; export F=1`, "export"],
];

describe("the confined node form and the words export and alias", () => {
	beforeEach(() => {
		vi.stubEnv("NODE_OPTIONS", "");
		vi.stubEnv("BASH_ENV", "");
	});
	afterEach(() => vi.unstubAllEnvs());

	it.each(DATA_WORDS)("stays confined with export or alias as data: %j", async (command) => {
		expect(interpreterRefusal(command, process.env, await parsedShell(command)), "parsed").toBeUndefined();
		expect(interpreterRefusal(command), "tokenizer").toBeUndefined();
	});

	it.each(SHELL_WORDS)("refuses a shell word beside the confined form and names it: %j", async (command, trigger) => {
		for (const parsed of [await parsedShell(command), undefined]) {
			const refusal = interpreterRefusal(command, process.env, parsed);
			expect(refusal?.name, command).toBe("node");
			expect(refusal?.cause).toContain(trigger);
		}
	});

	it.each([
		["node -e 'x'", "needs both `--permission`"],
		["node --permission --allow-fs-read=* -e 'x'", "--no-experimental-sqlite"],
		[`${CONFINED} -e 'x' --allow-fs-write=*`, "`--allow-fs-write`"],
		[`${CONFINED} -e 'x' --other`, "`--other` after the code"],
		[`${CONFINED} -e "$(date)"`, "`$` outside single quotes"],
		[`${CONFINED} -e 'x' \`ls\``, "outside single quotes"],
		[`FOO=1 ${CONFINED} -e 'x'`, "`FOO=1` before node"],
		["./node --permission -e 'x'", "`./node` is not plain"],
		[`${CONFINED} -r ./p.js -e 'x'`, "`-r` between node and its code"],
		["python3 -c 'x'", "python3 has no read-only form"],
		["node() { :; }; node --permission -p 1", "function, alias"],
		[`PATH=/tmp ${CONFINED} -e 'x'`, "`PATH=`"],
	])("names why %j is not confined", async (command, cause) => {
		expect(interpreterRefusal(command, process.env, await parsedShell(command))?.cause).toContain(cause);
	});

	it("names the environment as the cause", () => {
		expect(interpreterRefusal(`${CONFINED} -e 'x'`, { NODE_OPTIONS: "--max-old-space-size=1" })?.cause).toContain(
			"NODE_OPTIONS",
		);
	});
});

describe("the reservation gate's refusal of inline code", () => {
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
		const { reservationGate } = registerCollab(fake.api, team, { shellCommands: parsedShell });
		const ctx = fakeCtx({ cwd });
		await fake.emit("session_start", {}, ctx);
		stops.push(() => fake.emit("session_shutdown", {}, ctx));
		const lock = (paths: string[]) =>
			fake.tools.get("coordinate").execute("c", { action: "lock", paths, reason: "auth" }, undefined, undefined, ctx);
		// Inline code is held back only when its text names a reserved path: a trailing comment names it.
		const gate = (command: string, input = { command: `${command}\n# src/a.ts` }) =>
			reservationGate({ toolName: "bash", input } as never, ctx);
		return { lock, gate };
	}

	it("runs the confined form that mentions export, and refuses a real export with the cause named", async () => {
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const owner = await member(db, cwd);
		const peer = await member(db, cwd);
		await owner.lock(["src/a.ts"]);
		for (const command of DATA_WORDS) expect(await peer.gate(command), command).toBeUndefined();
		const refused = await peer.gate(`export NODE_OPTIONS=--allow-fs-write=*; ${CONFINED} -e 'x'`);
		expect(refused).toMatchObject({ block: true });
		expect(refused?.reason).toContain("(`NODE_OPTIONS` appears in the line");
		// A bare node only lacks the flags: the gate adds them rather than refusing with that cause.
		const bare = { command: `node -e 'x'\n# src/a.ts` };
		expect(await peer.gate(bare.command, bare)).toBeUndefined();
		expect(bare.command).toBe(`${CONFINED} -e 'x'\n# src/a.ts`);
		const lifted = await peer.gate(`export X=1; node -e 'x'`);
		expect(lifted?.reason).toContain("`export` appears in the line");
		expect(lifted?.reason).toContain("reserved by");
	});
});
