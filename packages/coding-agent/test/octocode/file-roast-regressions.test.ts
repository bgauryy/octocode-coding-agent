import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Checkpoints } from "../../src/octocode/files/checkpoint.ts";
import { journalOf, readJournal } from "../../src/octocode/files/checkpoint-store.ts";
import { nonInteractiveEnv } from "../../src/octocode/files/bash-jobs/shell.ts";
import { registerFileTool } from "../../src/octocode/files/tool.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { sha256 } from "../../src/utils/atomic-file.ts";
import { fakeCtx, fakePermission, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

describe("checkpoint journal validation", () => {
	it("drops malformed digests and paths before direct checkpoint loading", () => {
		const dir = tmp();
		const valid = { turn: 1, path: path.join(dir, "file"), before: null, after: sha256("x"), bytes: 0 };
		const invalid = [
			null,
			[],
			{ ...valid, before: "../../outside" },
			{ ...valid, after: "../outside" },
			{ ...valid, path: 1 },
			{ ...valid, path: "relative" },
			{ ...valid, path: "/x\0y" },
			{ ...valid, bytes: -1 },
			{ ...valid, turn: 1.5 },
		];
		fs.writeFileSync(journalOf(dir), [...invalid, valid].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
		expect(readJournal(dir)).toEqual({ entries: [valid], dirty: true });
		const checkpoints = new Checkpoints();
		checkpoints.open(dir);
		expect(checkpoints.list()).toEqual([valid]);
		expect(readJournal(dir)).toEqual({ entries: [valid], dirty: false });
	});

	it("reports the displaced copy when a concurrent writer takes the rewind path", async () => {
		const dir = tmp();
		const file = path.join(dir, "new.txt");
		const checkpoints = new Checkpoints();
		checkpoints.open(path.join(dir, "checkpoints"));
		checkpoints.beginTurn();
		const capture = await checkpoints.capture(file);
		fs.writeFileSync(file, "agent");
		await checkpoints.settle(file, capture, true);
		const rename = fs.promises.rename.bind(fs.promises);
		vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
			if (from === file) fs.writeFileSync(file, "first concurrent edit");
			await rename(from, to);
			if (from === file) fs.writeFileSync(file, "second concurrent edit");
		});
		const result = await checkpoints.rewind([1]);
		expect(result).toMatchObject({
			restored: [],
			skipped: [file],
			recovery: [{ path: file, savedAt: expect.any(String) }],
		});
		expect(fs.readFileSync(file, "utf8")).toBe("second concurrent edit");
		expect(fs.readFileSync(result.recovery![0].savedAt, "utf8")).toBe("first concurrent edit");
		expect(checkpoints.turns()).toEqual([1]);
	});
});

it("edits an unchanged LF anchor inside a stale CRLF file without overwriting the outside change", async () => {
	const cwd = tmp();
	const file = path.join(cwd, "a.txt");
	const original = "one\r\ntwo\r\nthree\r\n";
	fs.writeFileSync(file, original);
	const guard = new FileGuard();
	guard.record(file, { sha256: sha256(original), size: Buffer.byteLength(original) });
	fs.appendFileSync(file, "outside\r\n");
	const { pi, tools } = fakePi();
	registerFileTool(pi, guard, fakePermission());
	await tools.get("file").execute(
		"edit",
		{
			queries: [
				{
					type: "edit",
					path: "a.txt",
					reason: "fix anchor",
					edits: [{ oldText: "one\ntwo", newText: "one\nsecond" }],
				},
			],
		},
		undefined,
		undefined,
		fakeCtx({ cwd }),
	);
	expect(fs.readFileSync(file, "utf8")).toBe("one\r\nsecond\r\nthree\r\noutside\r\n");
});

it("forces noninteractive Git editors while honoring inherited pager choices", () => {
	const env = nonInteractiveEnv({ GIT_EDITOR: "vim", GIT_SEQUENCE_EDITOR: "vim", PAGER: "less", GIT_PAGER: "more" });
	expect(env.GIT_EDITOR).toContain("No interactive editor");
	expect(env.GIT_SEQUENCE_EDITOR).toBe(env.GIT_EDITOR);
	expect(env.PAGER).toBe("less");
	expect(env.GIT_PAGER).toBe("more");
	expect(env.GIT_TERMINAL_PROMPT).toBe("0");
});
