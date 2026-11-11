import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { onlyAllowedReaders } from "../../src/octocode/team/reservation-readers.ts";
import { parsedShell } from "../../src/octocode/permission/shell/commands.ts";
import { reservationTargets, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { readOnlyCommand } from "../../src/octocode/permission/shell/read-only.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * RFC 2026-11-11 core tools, step B4: while a peer holds a path, a line made only of readers with no write form (`rg`,
 * `grep`, `ls`, `cat`, `wc`, `fd`, `git log`, `git diff`, `git show`) runs even when an argument is a variable or a glob.
 * A redirection to a file, a `$(…)`, an option that writes or runs a program, or any command off the list keeps the refusal.
 */
const ALLOWED = [
	'rg -n foo "$dir"',
	"rg -n foo $dir",
	'grep -rn "$PAT" "$dir"',
	'ls -la "$dir"',
	'cat "$f"',
	'wc -l "$f"',
	'fd -e ts . "$dir"',
	'git log --oneline "$REF"',
	'git diff "$BASE"...HEAD',
	"git show $BASE:src/a.ts",
	'rg -n foo "$dir" | wc -l',
	'rg -n foo "$dir" 2>/dev/null',
	'rg -n foo "$dir" 2>&1 | grep -v "$skip"',
	'rg foo -- "$X" --pre',
];
const KEPT = [
	// A redirection to a file.
	'rg foo "$dir" > out.txt',
	'rg foo "$dir" >> out.txt',
	'cat "$f" 2> err.txt',
	// A word that runs another command.
	'rg foo "$(cat list)" "$dir"',
	'rg foo `cat list` "$dir"',
	// A command off the list, anywhere on the line.
	'python3 -c "open(\\"src/a.ts\\", \\"w\\")"',
	'cd "$dir" && rg foo "$X"',
	'rg foo "$dir" | head -n 5',
	'rg foo "$dir" | sort "$X"',
	'sort "$X" in',
	'find "$DIR" -name x',
	// An assignment before the program, a git global option, another git subcommand.
	'GIT_EXTERNAL_DIFF=x git diff "$BASE"',
	'git -c core.pager=x log "$REF"',
	'git checkout "$REF"',
	'git "$SUB" x',
	// An option that writes a file or runs a program, spelled out.
	'git log --output="$X"',
	'git diff --output=out.patch "$BASE"',
	'rg --pre "$X" foo',
	'rg --pre=cat foo "$dir"',
	'fd -x rm "$dir"',
	'fd --exec rm -- "$dir"',
	'fd -X "$CMD" . "$dir"',
];

beforeAll(() => shellParserReady());

describe("the readers the reservation gate allows with a computed word", () => {
	it.each(ALLOWED)("allows %j", async (command) => {
		expect(onlyAllowedReaders(await parsedShell(command))).toBe(true);
	});
	it.each(KEPT)("does not allow %j", async (command) => {
		expect(onlyAllowedReaders(await parsedShell(command))).toBe(false);
	});
	it("never allows a line that was not parsed, or an empty one", () => {
		expect(onlyAllowedReaders(undefined)).toBe(false);
		expect(onlyAllowedReaders({ commands: [], functions: [] })).toBe(false);
	});
	it("does not allow a line that defines a function, which may rename a reader", async () => {
		expect(onlyAllowedReaders(await parsedShell('rg() { rm -rf "$1"; }; rg "$dir"'))).toBe(false);
	});
});

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

	it("runs an allowed reader given a variable or a glob (V7)", async () => {
		const { peer } = await peerOfHolder();
		for (const command of ALLOWED) expect(await peer.gate(command), command).toBeUndefined();
	});

	it("refuses inline interpreter code that names the held path, naming the holder and the path (V8)", async () => {
		const { owner, peer } = await peerOfHolder();
		const refusal = await peer.gate("python3 -c \"open('src/a.ts', 'w')\"");
		expect(refusal).toMatchObject({ block: true });
		expect(refusal?.reason).toContain(`reserved by ${owner.team.id}`);
		expect(refusal?.reason).toContain("src/a.ts");
	});

	it("keeps the refusal for a computed word beside a file redirection, naming the holder and the path (V15)", async () => {
		const { owner, peer } = await peerOfHolder();
		for (const command of ['rg foo "$dir" > out.txt', 'cd "$dir" && rg foo "$X"', 'rg foo "$dir" | sort "$X"']) {
			const refusal = await peer.gate(command);
			expect(refusal, command).toMatchObject({ block: true });
			expect(refusal?.reason, command).toContain(`reserved by ${owner.team.id}`);
			expect(refusal?.reason, command).toContain("src/a.ts");
		}
	});

	it("still refuses a spelled-out write to the held path, and a redirection into it", async () => {
		const { peer } = await peerOfHolder();
		expect(await peer.gate("rg foo src > src/a.ts")).toMatchObject({ block: true });
		expect(await peer.gate('git diff --output=src/a.ts "$BASE"')).toMatchObject({ block: true });
	});
});
