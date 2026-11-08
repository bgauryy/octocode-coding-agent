import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bashSyntax } from "../../src/octocode/permission/bash-syntax.ts";
import { parsedShell } from "../../src/octocode/permission/shell/commands.ts";
import { reservationTargets } from "../../src/octocode/permission/shell/mutation.ts";
import { plainReader, readOnlyCommand } from "../../src/octocode/permission/shell/read-only.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * This file never loads the bash parser, so every command comes back unparsed: the state a loaded machine puts a command in
 * when the parse runs out of its time budget. The reservation gate then falls back to the words of the line.
 */
describe("the reservation fallback for a command the bash parse could not read", () => {
	it("has no parse here", () => {
		expect(bashSyntax("ls a.ts").incomplete).toBe(true);
		expect(readOnlyCommand("ls a.ts")).toBe(false);
	});

	it.each([
		"ls a.ts",
		"ls -la src/a.ts",
		"stat a.ts",
		"rg x a.ts",
		"rg 'two words' src/a.ts",
		'grep -n "x" a.ts',
		"cat a.ts",
		"head -n 5 a.ts",
		"wc -l a.ts",
		"sed -n '1,5p' a.ts",
		"sed -n 3p a.ts",
		"sed -n '10,$p' a.ts",
		"git diff a.ts",
		"git log -n 3 a.ts",
	])("does not take the words of %j as write targets", (command) => {
		expect(plainReader(command)).toBe(true);
		expect(reservationTargets(command)).toEqual([]);
	});

	it.each([
		"echo x > a.ts",
		"echo x >> a.ts",
		"cat b > a.ts",
		"cat a.ts > b",
		"tee a.ts",
		"rm a.ts",
		"cp b a.ts",
		"mv b a.ts",
		"touch a.ts",
		"sed -i s/a/b/ a.ts",
		"sed -i.bak s/a/b/ a.ts",
		"sed -n '1,5p' -i a.ts",
		"sed -n '1,5w a.ts' b",
		"sed -n '1,5p;w a.ts' b",
		"sed -n -f a.ts b",
		"sed s/a/b/ a.ts",
		"sort -o a.ts b",
		"sort --output=a.ts b",
		"sort --out a.ts b",
		"uniq b a.ts",
		"find . -name a.ts -delete",
		"find . -fprint a.ts",
		"rg --pre a.ts x b",
		"tree -o a.ts",
		"git diff --output=a.ts",
		"git checkout a.ts",
		"git -c core.pager=x log a.ts",
		"ls a.ts; rm a.ts",
		"ls a.ts && rm a.ts",
		"ls a.ts | tee a.ts",
		"ls a.ts\nrm a.ts",
		"ls $(rm a.ts)",
		"ls `rm a.ts`",
		"FOO=1 ls a.ts",
		"xargs rm a.ts",
		"sudo rm a.ts",
		"sh -c 'rm a.ts'",
		"./ls a.ts",
		"ls a.ts &",
	])("still takes the words of %j as write targets", (command) => {
		expect(plainReader(command)).toBe(false);
		expect(reservationTargets(command)).toContain("a.ts");
	});

	it("does not read an expansion, a glob or an escape as a plain word", () => {
		for (const command of ["ls $F", 'cat "$F"', "ls *.ts", "ls a\\ b", "cat !x", 'echo "a!b"', "ls ~/a #x"])
			expect(plainReader(command), command).toBe(false);
	});
});

describe("the reservation gate for a command the bash parse could not read", () => {
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
		// As index.ts wires it, but without the parser load (`shellParserReady`), so every parse is incomplete.
		const { reservationGate } = registerCollab(fake.api, team, {
			shellCommands: parsedShell,
			shellReadOnly: readOnlyCommand,
			shellWrites: async (command) => reservationTargets(command),
		});
		const ctx = fakeCtx({ cwd });
		await fake.emit("session_start", {}, ctx);
		stops.push(() => fake.emit("session_shutdown", {}, ctx));
		const lock = (paths: string[]) =>
			fake.tools.get("coordinate").execute("c", { action: "lock", paths, reason: "edit" }, undefined, undefined, ctx);
		const gate = (command: string) => reservationGate({ toolName: "bash", input: { command } } as never, ctx);
		return { team, lock, gate };
	}

	it("lets a peer read a reserved file and still refuses its writes", async () => {
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const owner = await member(db, cwd);
		const peer = await member(db, cwd);
		await owner.lock(["src/a.ts"]);
		for (const read of ["ls src/a.ts", "stat src/a.ts", "rg x src/a.ts", "sed -n '1,5p' src/a.ts"])
			expect(await peer.gate(read), read).toBeUndefined();
		for (const write of ["echo x > src/a.ts", "sed -i s/a/b/ src/a.ts", "ls src/a.ts; rm src/a.ts"])
			expect(await peer.gate(write), write).toMatchObject({
				block: true,
				reason: expect.stringContaining(`reserved by ${owner.team.id}`),
			});
	});
});
