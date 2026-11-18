import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFileTool } from "../../src/octocode/native/tools/file/tool.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { changeNote } from "../../src/octocode/team/edits.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

/** A file tool over a temp workspace, the guard having read `content` of `a.ts` as it is now. */
function setup(content: string, name = "a.ts") {
	const cwd = fs.realpathSync(tmp());
	const file = path.join(cwd, name);
	fs.writeFileSync(file, content);
	const guard = new FileGuard();
	guard.record(file, { sha256: sha256(content), size: Buffer.byteLength(content) });
	const { api, tools } = fakeHost();
	registerFileTool(api, guard, fakePermission());
	const run = (query: Record<string, unknown>) =>
		tools
			.get("file")
			.execute("c", { reason: "r", queries: [{ path: name, ...query }] }, undefined, undefined, fakeCtx({ cwd }));
	return { cwd, file, guard, run };
}

describe("a write is checked on disk after it lands", () => {
	it("fails a write whose content is not on disk after the rename, and demands a fresh read", async () => {
		const { file, guard, run } = setup("const a = 1;\n");
		const rename = fs.promises.rename.bind(fs.promises);
		// Another process (or a torn filesystem) leaves different bytes behind right after the write lands.
		vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
			await rename(from, to);
			if (to === file) fs.writeFileSync(file, "scrambled\n");
		});
		// The change was committed, so the outcome is an error result (not a throw) that says the file was changed.
		const result = await run({ type: "write", content: "const a = 2;\n" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(
			/checking it after the write found a different size \(10 bytes, expected 13\)[\s\S]*The file was changed; inspect it before retrying/,
		);
		vi.restoreAllMocks();
		expect(fs.readFileSync(file, "utf8")).toBe("scrambled\n");
		// The guard does not trust what it recorded for the write: the next change needs a read.
		expect(guard.check(file, "write", "a.ts")).toMatch(/no longer in your context/);
	});

	it("reports an edit that did not land the same way", async () => {
		const { file, run } = setup("one\ntwo\n");
		const rename = fs.promises.rename.bind(fs.promises);
		vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
			await rename(from, to);
			if (to === file) fs.rmSync(file);
		});
		const result = await run({ type: "edit", edits: [{ oldText: "two", newText: "2" }] });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/checking it after the write found no file/);
	});

	it("stays silent when the bytes landed", async () => {
		const { file, run } = setup("one\n");
		await run({ type: "edit", edits: [{ oldText: "one", newText: "1" }] });
		expect(fs.readFileSync(file, "utf8")).toBe("1\n");
	});
});

describe("an oldText mismatch shows the file's actual line", () => {
	it("shows a tab where spaces were sent", async () => {
		const { file, run } = setup("function f() {\n\tconst x = 1;\n}\n");
		await expect(
			run({ type: "edit", edits: [{ oldText: "function f() {\n  const x = 1;\n}", newText: "y" }] }),
		).rejects.toThrow(/Line 2 of the file is "\\tconst x = 1;"; oldText has "  const x = 1;"\./);
		expect(fs.readFileSync(file, "utf8")).toBe("function f() {\n\tconst x = 1;\n}\n");
	});

	it("names a copied line-number prefix", async () => {
		const { run } = setup("alpha\nbeta\ngamma\n");
		await expect(run({ type: "edit", edits: [{ oldText: "2\tbeta\n3\tgamma", newText: "x" }] })).rejects.toThrow(
			/matches line 2 of the file once the line-number prefix of each line is removed/,
		);
	});

	it("names one extra leading tab on every line, and does not apply the guess", async () => {
		const { file, run } = setup("alpha\n\n  beta\ngamma\n");
		const extraTab = /one extra leading tab on each line, likely the line-number separator copied from a read/;
		await expect(
			run({ type: "edit", edits: [{ oldText: "\talpha\n\n\t  beta", newText: "\tx\n\n\t  y" }] }),
		).rejects.toThrow(extraTab);
		// A tab-only line stands for a blank line of the read.
		await expect(run({ type: "edit", edits: [{ oldText: "\talpha\n\t\n\t  beta", newText: "x" }] })).rejects.toThrow(
			extraTab,
		);
		expect(fs.readFileSync(file, "utf8")).toBe("alpha\n\n  beta\ngamma\n");
	});

	it("does not name an extra tab when the text without it is ambiguous or some line has none", async () => {
		const { run } = setup("alpha\nbeta\nalpha\nbeta\ngamma\n");
		const ambiguous = await run({ type: "edit", edits: [{ oldText: "\talpha\n\tbeta", newText: "x" }] }).catch(
			(error: Error) => error,
		);
		expect(String(ambiguous.message)).not.toMatch(/extra leading tab/);
		const mixed = await run({ type: "edit", edits: [{ oldText: "\tbeta\ngamma", newText: "x" }] }).catch(
			(error: Error) => error,
		);
		expect(String(mixed.message)).not.toMatch(/extra leading tab/);
	});

	it("adds nothing when no line of the file is close", async () => {
		const { run } = setup("alpha\n");
		const failure = await run({ type: "edit", edits: [{ oldText: "zebra", newText: "x" }] }).catch(
			(error: Error) => error,
		);
		expect(String(failure.message)).toMatch(
			/Could not find the exact text in a\.ts\. The old text must match exactly[^]*$/,
		);
		expect(String(failure.message)).not.toMatch(/Line \d+ of the file/);
	});
});

describe("a changed-on-disk refusal names who changed the file", () => {
	async function teamSetup() {
		const built = setup("export const a = 1;\n");
		fs.mkdirSync(path.join(built.cwd, ".git"));
		const fake = fakeHost();
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") });
		registerCollab(fake.api, team, {});
		const ctx = fakeCtx({ cwd: built.cwd });
		await fake.emit("session_start", {}, ctx);
		const me = team.join("mine").id;
		built.guard.modifiedBy = (file) => changeNote(team.editLog(), file, team.id);
		return { ...built, team, me, stop: () => fake.emit("session_shutdown", {}, ctx) };
	}

	it("names another agent that edited it, with its tool", async () => {
		const t = await teamSetup();
		try {
			fs.writeFileSync(t.file, "export const a = 2;\n");
			t.team.editLog()!.record("calm-prawn", "file", [t.file]);
			await expect(t.run({ type: "write", content: "x\n" })).rejects.toThrow(
				/changed on disk since you last read it\.[^]*Last recorded change: calm-prawn \(file, \d+s ago\)\./,
			);
			fs.writeFileSync(t.file, "export const a = 3;\n");
			await expect(t.run({ type: "edit", edits: [{ oldText: "a = 1", newText: "a = 9" }] })).rejects.toThrow(
				/edits\[0\] \(oldText "a = 1"\) is no longer in it[^]*Last recorded change: calm-prawn/,
			);
		} finally {
			await t.stop();
		}
	});

	it("says when no agent change is recorded, so another process wrote it", async () => {
		const t = await teamSetup();
		try {
			fs.writeFileSync(t.file, "export const a = 2;\n");
			await expect(t.run({ type: "write", content: "x\n" })).rejects.toThrow(
				/No agent change to it is recorded in the last hour, so an editor, git, a formatter or another process wrote it/,
			);
		} finally {
			await t.stop();
		}
	});

	it("reads the session's own recorded change as its own", async () => {
		const t = await teamSetup();
		try {
			fs.writeFileSync(t.file, "export const a = 2;\n");
			t.team.editLog()!.record(t.me, "bash", [t.file]);
			await expect(t.run({ type: "write", content: "x\n" })).rejects.toThrow(
				/Its last recorded change is this session's own \(bash, \d+s ago\)/,
			);
		} finally {
			await t.stop();
		}
	});

	it("adds nothing without a change log", async () => {
		const { file, run } = setup("one\n");
		fs.writeFileSync(file, "two!\n");
		// No research server is connected here, so the guard names its default reader, `bash` (`BASH_READER`).
		await expect(run({ type: "write", content: "x\n" })).rejects.toThrow(
			/changed on disk since you last read it\. Read it again with `bash` before modifying it\.$/,
		);
	});
});
