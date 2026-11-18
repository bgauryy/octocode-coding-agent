import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bashReads } from "../../src/octocode/files/bash-reads.ts";
import { registerFileTool } from "../../src/octocode/native/tools/file/tool.ts";
import { fakeCtx, fakePermission, asSetup } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { BASH_READER, FileGuard, mcpReader } from "../../src/octocode/files/tool/guard.ts";

/** A role-configured research server's reader; the guard names it without its argument syntax. */
const MCP_READER = mcpReader("mcp__codesearch__readFile");

const CWD = "/work";
const abs = (name: string) => path.join(CWD, name);

describe("bashReads", () => {
	it("credits cat as a whole read of each file", () => {
		expect(bashReads("cat a.txt", CWD)).toEqual([{ file: abs("a.txt"), whole: true }]);
		expect(bashReads("cat -n a.txt 'b c.txt'", CWD)).toEqual([
			{ file: abs("a.txt"), whole: true },
			{ file: abs("b c.txt"), whole: true },
		]);
		expect(bashReads('cat "/etc/hosts"', CWD)).toEqual([{ file: "/etc/hosts", whole: true }]);
	});

	it("credits head, tail -n +N and sed -n ranges as the lines they print", () => {
		expect(bashReads("head -n 20 a.txt", CWD)).toEqual([{ file: abs("a.txt"), whole: false, lines: [1, 20] }]);
		expect(bashReads("head -5 a.txt", CWD)).toEqual([{ file: abs("a.txt"), whole: false, lines: [1, 5] }]);
		expect(bashReads("head a.txt", CWD)).toEqual([{ file: abs("a.txt"), whole: false, lines: [1, 10] }]);
		expect(bashReads("tail -n +30 a.txt", CWD)).toEqual([
			{ file: abs("a.txt"), whole: false, lines: [30, Number.POSITIVE_INFINITY] },
		]);
		expect(bashReads("sed -n '10,20p' a.txt", CWD)).toEqual([{ file: abs("a.txt"), whole: false, lines: [10, 20] }]);
		expect(bashReads("sed -n '7p' a.txt", CWD)).toEqual([{ file: abs("a.txt"), whole: false, lines: [7, 7] }]);
		expect(bashReads("sed -n '5,$p' a.txt", CWD)).toEqual([
			{ file: abs("a.txt"), whole: false, lines: [5, Number.POSITIVE_INFINITY] },
		]);
	});

	it("counts a truncated view as seen in part, never whole and without known lines", () => {
		expect(bashReads("cat a.txt", CWD, true)).toEqual([{ file: abs("a.txt"), whole: false }]);
		expect(bashReads("sed -n '1,9000p' a.txt", CWD, true)).toEqual([{ file: abs("a.txt"), whole: false }]);
	});

	it("resolves files against literal cd steps before the printer", () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, "sub", "deep"), { recursive: true });
		const sub = path.join(cwd, "sub");
		expect(bashReads("cd ./sub && cat a.txt", cwd)).toEqual([{ file: path.join(sub, "a.txt"), whole: true }]);
		expect(bashReads("cd './sub' ; sed -n '2,3p' a.txt", cwd)).toEqual([
			{ file: path.join(sub, "a.txt"), whole: false, lines: [2, 3] },
		]);
		expect(bashReads(`cd "${sub}" && head -n 4 a.txt`, "/elsewhere")).toEqual([
			{ file: path.join(sub, "a.txt"), whole: false, lines: [1, 4] },
		]);
		expect(bashReads("cd ./sub && cd ./deep && cat a.txt", cwd)).toEqual([
			{ file: path.join(sub, "deep", "a.txt"), whole: true },
		]);
		expect(bashReads("cd . && cat a.txt", cwd)).toEqual([{ file: path.join(cwd, "a.txt"), whole: true }]);
		expect(bashReads("cd ./sub && cat /etc/hosts", cwd)).toEqual([{ file: "/etc/hosts", whole: true }]);
		expect(bashReads("cd ./sub && cat a.txt", cwd, true)).toEqual([{ file: path.join(sub, "a.txt"), whole: false }]);
	});

	it.each([
		"cd $DIR && cat a.txt",
		"cd $(pwd) && cat a.txt",
		"cd su* && cat a.txt",
		"cd ~/sub && cat a.txt",
		"cd - && cat a.txt",
		"cd && cat a.txt",
		"cd ./sub || cat a.txt",
		"cd ./sub & cat a.txt",
		"(cd ./sub && cat a.txt)",
		"cd ./sub && cat a.txt | head",
		"cd ./missing; cat a.txt",
		// A bare name goes through CDPATH, and `..` is followed on the spelling, not the real directories (symlinks).
		"cd sub && cat a.txt",
		"cd sub/deep && cat a.txt",
		"cd 'sub' ; cat a.txt",
		"cd .. && cat a.txt",
		"cd ../sub && cat a.txt",
		"cd ./sub/.. && cat a.txt",
		"cd ./sub/../sub && cat a.txt",
	])("credits nothing for the cd form %s", (command) => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, "sub"));
		expect(bashReads(command, cwd)).toEqual([]);
	});

	it.each([
		"cat a.txt | head -3",
		"cat a.txt > b.txt",
		"cat a.txt && rm a.txt",
		"cat a.txt; sed -i 's/a/b/' a.txt",
		"cat $(echo a.txt)",
		"cat `echo a.txt`",
		"cat *.txt",
		"cat ~/a.txt",
		'cat "$HOME/a.txt"',
		"cat < a.txt",
		"cat -x a.txt",
		"cat",
		"head -c 20 a.txt",
		"head a.txt b.txt",
		"sed -n '/foo/p' a.txt",
		"sed -i 's/a/b/' a.txt",
		"sed -n '1,5p;9p' a.txt",
		"sed -n '9,5p' a.txt",
		"tail -n 5 a.txt",
		"grep foo a.txt",
		"less a.txt",
		"cat 'unterminated",
	])("credits nothing for %s", (command) => {
		expect(bashReads(command, CWD)).toEqual([]);
	});
});

describe("the file tool and plain bash prints", () => {
	function setup(reader = BASH_READER) {
		const cwd = tmp();
		const file = path.join(cwd, "a.txt");
		fs.writeFileSync(file, "one\ntwo\nthree\nfour\n");
		const guard = new FileGuard();
		guard.reader = reader;
		let tool: {
			execute: (...args: unknown[]) => Promise<{ details: { outcomes: Array<{ ok: boolean; message: string }> } }>;
		};
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
		registerFileTool(
			asSetup({
				registerTool: (t: typeof tool) => (tool = t),
				on: (name: string, handler: never) => handlers.set(name, handler),
			}) as never,
			guard,
			fakePermission(),
		);
		const bash = (command: string, extra: Record<string, unknown> = {}) =>
			handlers.get("tool_result")!(
				{ toolName: "bash", toolCallId: "b", input: { command }, content: [], details: {}, isError: false, ...extra },
				{ cwd },
			);
		// A batch whose changes all fail throws its outcomes; a case reads the message either way.
		const change = async (query: Record<string, unknown>) => {
			try {
				const result = await tool.execute(
					"f",
					{ queries: [{ reason: "r", path: "a.txt", ...query }] },
					undefined,
					undefined,
					fakeCtx({ cwd, hasUI: false }),
				);
				return result.details.outcomes[0];
			} catch (error) {
				return { ok: false, message: (error as Error).message };
			}
		};
		return { cwd, file, guard, bash, change };
	}

	it("refuses an unread file and names bash as the reader", async () => {
		const { change } = setup();
		const outcome = await change({ type: "edit", edits: [{ oldText: "absent", newText: "2" }] });
		expect(outcome.ok).toBe(false);
		expect(outcome.message).toMatch(/was not read in this session\. Read it first: bash `sed -n '1,200p' a\.txt`/);
	});

	it("lets an existing file be edited after a bash cat, and written after the rest was read", async () => {
		const { file, bash, change } = setup();
		await bash("cat a.txt");
		expect(await change({ type: "edit", edits: [{ oldText: "two", newText: "2" }] })).toMatchObject({ ok: true });
		expect(fs.readFileSync(file, "utf8")).toBe("one\n2\nthree\nfour\n");
		expect(await change({ type: "write", content: "replaced\n" })).toMatchObject({ ok: true });
	});

	it("counts a sed range toward an edit, and asks for the rest with sed before a full write", async () => {
		const { bash, change } = setup();
		await bash("sed -n '1,2p' a.txt");
		const refused = await change({ type: "write", content: "replaced\n" });
		expect(refused.ok).toBe(false);
		expect(refused.message).toMatch(
			/seen lines 1–2 of its 4 lines\. Read the rest with `bash` \(sed -n '3,4p' <file>\)/,
		);
		await bash("sed -n '3,4p' a.txt");
		expect(await change({ type: "write", content: "replaced\n" })).toMatchObject({ ok: true });
	});

	it.each([[undefined], [MCP_READER]])(
		"tells a delete that ran beside a bash read of the file that the read counts after it finishes (%#)",
		async (reader) => {
			const { file, bash, change } = setup(reader);
			// One assistant message runs its calls in parallel: `file` checks before the sibling `bash` reports its result.
			const refused = await change({ type: "delete" });
			expect(refused.ok).toBe(false);
			expect(refused.message).toMatch(/was not read in this session/);
			expect(refused.message).toMatch(
				/neither does one made by a parallel call of this message until that call finishes: read first, then call `file` again in a later message/,
			);
			expect(fs.existsSync(file)).toBe(true);
			await bash("sed -n '1,200p' a.txt");
			expect(await change({ type: "delete" })).toMatchObject({ ok: true });
			expect(fs.existsSync(file)).toBe(false);
		},
	);

	it("asks for a new read once the file changed after the bash read", async () => {
		const { file, bash, change } = setup();
		await bash("cat a.txt");
		fs.writeFileSync(file, "different\ncontent\nhere\nnow\n");
		const refused = await change({ type: "delete" });
		expect(refused.message).toMatch(/changed on disk since you last read it\. Read it again with `bash`/);
		await bash("cat a.txt");
		expect(await change({ type: "delete" })).toMatchObject({ ok: true });
	});

	it("credits plain reads chained with `;` or `&&`, one segment at a time", async () => {
		expect(bashReads("sed -n '1,5p' a.txt; sed -n '9,12p' b.txt", CWD)).toEqual([
			{ file: abs("a.txt"), whole: false, lines: [1, 5] },
			{ file: abs("b.txt"), whole: false, lines: [9, 12] },
		]);
		expect(bashReads("echo '--- a ---' && cat a.txt && cat b.txt;", CWD)).toEqual([
			{ file: abs("a.txt"), whole: true },
			{ file: abs("b.txt"), whole: true },
		]);
		expect(bashReads("cat a.txt; ls", CWD)).toEqual([{ file: abs("a.txt"), whole: true }]);
		// A `;` inside quotes is part of the word, not a separator.
		expect(bashReads("cat 'a;b.txt'", CWD)).toEqual([{ file: abs("a;b.txt"), whole: true }]);
	});

	it("does not credit a chained segment that is piped, redirected, mixed with another operator or after a state change", () => {
		expect(bashReads("cat a.txt | head -2; cat b.txt", CWD)).toEqual([]);
		// One unprovable segment voids the list: it may change what an earlier print showed.
		expect(bashReads("cat a.txt; cat b.txt > out.txt", CWD)).toEqual([]);
		expect(bashReads("cat a.txt; cat b.txt || cat c.txt", CWD)).toEqual([]);
		expect(bashReads("cat a.txt; rm a.txt", CWD)).toEqual([]);
		// `a && b; c` succeeds when `a` failed, so `b` may not have run.
		expect(bashReads("cat a.txt && cat b.txt; cat c.txt", CWD)).toEqual([]);
		expect(bashReads("PATH=/x; cat a.txt", CWD)).toEqual([]);
		expect(bashReads("source env.sh; cat a.txt", CWD)).toEqual([]);
		expect(bashReads("cat $F; cat a.txt", CWD)).toEqual([]);
	});

	it("does not credit what cannot be proven: pipes, background jobs, failures and nested calls", async () => {
		const { bash, change } = setup();
		await bash("cat a.txt | head -2");
		await bash("cat a.txt", { input: { command: "cat a.txt", background: true } });
		await bash("cat a.txt", { isError: true });
		await bash("cat a.txt", { parentToolCallId: "script" });
		const outcome = await change({ type: "edit", edits: [{ oldText: "absent", newText: "2" }] });
		expect(outcome.message).toMatch(/was not read in this session/);
	});

	it("counts a cut output as a partial read: an edit may follow, a full write needs the lines", async () => {
		const { bash, change } = setup();
		await bash("cat a.txt", { details: { truncation: { truncated: true }, fullOutputPath: "/tmp/full" } });
		expect(await change({ type: "write", content: "x" })).toMatchObject({ ok: false });
		expect(await change({ type: "edit", edits: [{ oldText: "two", newText: "2" }] })).toMatchObject({ ok: true });
	});

	it("credits a bash print too while the Octocode readers are available", async () => {
		const { file, bash, change } = setup(MCP_READER);
		await bash("sed -n '2,3p' a.txt");
		expect(await change({ type: "edit", edits: [{ oldText: "two", newText: "2" }] })).toMatchObject({ ok: true });
		expect(fs.readFileSync(file, "utf8")).toBe("one\n2\nthree\nfour\n");
		// Only lines 2-3 were printed, so a whole-file write still names the rest and the MCP reader's line range.
		const refused = await change({ type: "write", content: "replaced\n" });
		expect(refused.message).toMatch(
			/seen lines 2–3 of its 4 lines\. Read the rest with `mcp__codesearch__readFile` \(lines 1-4\)/,
		);
		await bash("cat a.txt");
		expect(await change({ type: "write", content: "replaced\n" })).toMatchObject({ ok: true });
	});

	it("does not credit a pipe or a cut print as a whole read when the Octocode readers are available", async () => {
		const { bash, change } = setup(MCP_READER);
		await bash("cat a.txt | head -2");
		const unread = await change({ type: "edit", edits: [{ oldText: "absent", newText: "2" }] });
		expect(unread.message).toMatch(/was not read in this session/);
		await bash("cat a.txt", { details: { truncation: { truncated: true } } });
		expect(await change({ type: "write", content: "x" })).toMatchObject({ ok: false });
	});

	it("counts `cd DIR && cat rel` toward a write of that file only", async () => {
		const { cwd, bash, change } = setup(MCP_READER);
		fs.mkdirSync(path.join(cwd, "sub"));
		fs.writeFileSync(path.join(cwd, "sub", "b.txt"), "x\ny\n");
		await bash("cd ./sub && cat b.txt");
		expect(await change({ type: "write", path: "sub/b.txt", content: "z\n" })).toMatchObject({ ok: true });
		// The same name at the workspace root was never printed.
		fs.writeFileSync(path.join(cwd, "b.txt"), "other\n");
		expect(await change({ type: "write", path: "b.txt", content: "z\n" })).toMatchObject({ ok: false });
	});

	it("refusal says what counts as a read, naming the MCP reader or a plain bash print", async () => {
		const edit = { type: "edit", edits: [{ oldText: "absent", newText: "2" }] };
		const local = await setup(MCP_READER).change(edit);
		expect(local.message).toMatch(
			/Read it first with `mcp__codesearch__readFile`\. A plain `cat` or `sed -n` print in bash also counts\. A read piped or redirected/,
		);
		const bash = await setup().change(edit);
		expect(bash.message).toMatch(
			/Read it first: bash `sed -n '1,200p' a\.txt` \(a plain `cat` or `sed -n` print counts, alone or chained/,
		);
	});
});
