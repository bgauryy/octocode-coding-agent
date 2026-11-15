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
 * Filters (`head`, `tail`, `sort`, `uniq`, `cut`, `tr`, `jq`, `cd`, `echo`…) join them in a pipeline, and a `$(…)` runs when
 * every command inside it is such a reader. A redirection to a file, an option that writes or runs a program, or any command off
 * the list keeps the refusal.
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
	// Filters after a reader, and a `cd` before it.
	'rg foo "$dir" | head -n 5',
	'cd "$dir" && rg foo *.md | head -5',
	'rg foo "$dir" | sort | uniq -c | sort -rn | head -20',
	"tail -n 40 .octocode/tmp/log",
	"sort -u list.txt | uniq -d",
	"sort -k 2 -t , list.txt",
	"uniq -c in.txt",
	"uniq -f 2 in.txt",
	"uniq -cf 2 -- in.txt",
	"uniq --skip-fields 2 in.txt",
	"uniq -- in.txt",
	'rg -n foo "$dir" | cut -d: -f1 | tr a-z A-Z | nl | column -t',
	'rg -l foo "$dir" | head -3 | jq -R .',
	'jq .name "$f"',
	'echo "found: $dir"; printf "%s\n" "$dir"; true; pwd',
	'basename "$f"; dirname "$f"',
	"cd packages/coding-agent && rg foo src 2>&1 | head -5",
	// A `$(…)`, backticks or a process substitution whose commands are all allowed.
	"rg pat $(rg -l X test | head -1)",
	'rg pat "$(rg -l X test | head -1)" "$dir"',
	"rg pat `ls test | head -1`",
	"cat <(rg -l foo src | sort)",
	'echo "$(basename "$f")"',
	'rg pat "$(cd "$dir" && pwd)"',
];
const KEPT = [
	// A redirection to a file.
	'rg foo "$dir" > out.txt',
	'rg foo "$dir" >> out.txt',
	'cat "$f" 2> err.txt',
	// A word that runs another command, one of which is not an allowed reader or writes.
	'rg foo "$(sed -i s/a/b/ src/a.ts)" "$dir"',
	'rg foo `sed -i s/a/b/ src/a.ts` "$dir"',
	'rg foo $(sed -n 1p list) "$dir"',
	"cat <(sed -i s/a/b/ src/a.ts)",
	"echo ${x:-$(tee src/a.ts)}",
	'rg foo "$(cat list > out.txt)" "$dir"',
	'rg foo "$(sort -o out.txt list)" "$dir"',
	'rg foo $($CMD) "$dir"',
	"echo hi >(tee src/a.ts)",
	"echo hi | tee src/a.ts",
	"echo hi | xargs rm",
	'rg -l foo "$dir" | xargs sed -i s/a/b/',
	// A command off the list, anywhere on the line.
	'python3 -c "open(\\"src/a.ts\\", \\"w\\")"',
	'sed -i s/a/b/ "$dir"/a.ts',
	'awk "BEGIN{}" "$dir"',
	'rg foo "$dir" | sed -n 1p',
	'rg foo "$dir" | sort "$X"',
	'sort "$X" in',
	'find "$DIR" -name x',
	// A filter with an option or operand that writes a file, or never returns.
	"sort -o out.txt list.txt",
	"sort -ro out.txt list.txt",
	"sort -oout.txt list.txt",
	"sort --output=out.txt list.txt",
	"sort --out out.txt list.txt",
	'sort --output="$X" list.txt',
	"sort --compress-program=sh list.txt",
	'rg foo "$dir" | sort -u -o src/a.ts',
	"uniq in.txt out.txt",
	"uniq -c in.txt out.txt",
	"uniq -f 2 in.txt out.txt",
	"uniq -cf 2 in.txt out.txt",
	"uniq --skip-fields 2 in.txt out.txt",
	"uniq -- in.txt out.txt",
	'uniq in.txt "$X"',
	"sort list.txt | uniq - out.txt",
	"tail -f log",
	"tail -F log",
	"tail -nf 5 log",
	"tail --follow log",
	"tail --fol log",
	'printf -v PATH "%s" /tmp/x',
	"printf -v 'a[$(sed -i s/a/b/ src/a.ts)]' x",
	'printf "$fmt"',
	"printf",
	// An assignment before a filter, a wrapper, a computed program.
	"LC_ALL=C sort list.txt",
	"env sort list.txt",
	'"$CMD" list.txt',
	// A redirection to a file or a here-document.
	"sort list.txt > out.txt",
	"head -n 5 list.txt >> out.txt",
	"echo hi > src/a.ts",
	"cat <<EOF\nhi\nEOF",
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
		for (const command of [
			'rg foo "$dir" > out.txt',
			'cd "$dir" && rg foo "$X" | xargs rm',
			'rg foo "$dir" | sort "$X"',
		]) {
			const refusal = await peer.gate(command);
			expect(refusal, command).toMatchObject({ block: true });
			expect(refusal?.reason, command).toContain(`reserved by ${owner.team.id}`);
			expect(refusal?.reason, command).toContain("src/a.ts");
		}
	});

	it("refuses a reader line whose group, loop or bare redirection writes the held path", async () => {
		const { owner, peer } = await peerOfHolder();
		for (const command of [
			'(cat "$d") > src/a.ts',
			'{ rg x "$d"; } > src/a.ts',
			'rg x "$d"; > src/a.ts',
			'for f in *.md; do cat "$f"; done > src/a.ts',
		]) {
			const refusal = await peer.gate(command);
			expect(refusal, command).toMatchObject({ block: true });
			expect(refusal?.reason, command).toContain(`reserved by ${owner.team.id}`);
		}
		expect(await peer.gate('rg x "$d" src/a.ts')).toBeUndefined();
	});

	it("still refuses a spelled-out write to the held path, and a redirection into it", async () => {
		const { peer } = await peerOfHolder();
		expect(await peer.gate("rg foo src > src/a.ts")).toMatchObject({ block: true });
		expect(await peer.gate('git diff --output=src/a.ts "$BASE"')).toMatchObject({ block: true });
	});
});
