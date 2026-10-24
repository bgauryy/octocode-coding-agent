import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bashReads } from "../../src/octocode/files/bash-reads.ts";
import { registerFileTool } from "../../src/octocode/files/tool.ts";
import { fakeCtx, fakePermission } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";
import { BASH_READER, FileGuard, LOCAL_FETCH_READER } from "../../src/octocode/files/tool/guard.ts";

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

	it.each([
		"cat a.txt | head -3",
		"cat a.txt > b.txt",
		"cat a.txt && rm a.txt",
		"cat a.txt; ls",
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

describe("the file tool while Octocode's local readers are unavailable", () => {
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
			{
				registerTool: (t: typeof tool) => (tool = t),
				on: (name: string, handler: never) => handlers.set(name, handler),
			} as never,
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
					{ queries: [{ reasoning: "r", path: "a.txt", ...query }] },
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
		const outcome = await change({ type: "edit", edits: [{ oldText: "two", newText: "2" }] });
		expect(outcome.ok).toBe(false);
		expect(outcome.message).toMatch(/was not read in this session\. Read it with `bash`/);
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

	it("asks for a new read once the file changed after the bash read", async () => {
		const { file, bash, change } = setup();
		await bash("cat a.txt");
		fs.writeFileSync(file, "different\ncontent\nhere\nnow\n");
		const refused = await change({ type: "delete" });
		expect(refused.message).toMatch(/changed on disk since you last read it\. Read it again with `bash`/);
		await bash("cat a.txt");
		expect(await change({ type: "delete" })).toMatchObject({ ok: true });
	});

	it("does not credit what cannot be proven: pipes, background jobs, failures and nested calls", async () => {
		const { bash, change } = setup();
		await bash("cat a.txt | head -2");
		await bash("cat a.txt", { input: { command: "cat a.txt", background: true } });
		await bash("cat a.txt", { isError: true });
		await bash("cat a.txt", { parentToolCallId: "script" });
		const outcome = await change({ type: "edit", edits: [{ oldText: "two", newText: "2" }] });
		expect(outcome.message).toMatch(/was not read in this session/);
	});

	it("counts a cut output as a partial read: an edit may follow, a full write needs the lines", async () => {
		const { bash, change } = setup();
		await bash("cat a.txt", { details: { truncation: { truncated: true }, fullOutputPath: "/tmp/full" } });
		expect(await change({ type: "write", content: "x" })).toMatchObject({ ok: false });
		expect(await change({ type: "edit", edits: [{ oldText: "two", newText: "2" }] })).toMatchObject({ ok: true });
	});

	it("leaves bash out of the guard while the Octocode readers are available", async () => {
		const { bash, change } = setup(LOCAL_FETCH_READER);
		await bash("cat a.txt");
		const outcome = await change({ type: "edit", edits: [{ oldText: "two", newText: "2" }] });
		expect(outcome.message).toMatch(/was not read in this session\. Read it with `localFetch`/);
	});
});
