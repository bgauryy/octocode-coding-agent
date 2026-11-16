import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyEditsToNormalizedContent, normalizeToLF } from "../../src/core/tools/edit-diff.ts";
import { resolveAnchoredEdits } from "../../src/octocode/files/tool/anchored.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { registerFileTool } from "../../src/octocode/files/tool.ts";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { fakeCtx, fakePermission, fakeHost } from "./fake-host.ts";

describe("optional anchored edit adapter", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	function fixture(source: string, partial = false) {
		const dir = mkdtempSync(join(tmpdir(), "anchored-edit-"));
		dirs.push(dir);
		const file = join(dir, "source.txt");
		const bytes = Buffer.from(source);
		writeFileSync(file, bytes);
		const guard = new FileGuard();
		guard.record(file, { sha256: sha256(bytes), size: bytes.length }, partial, partial ? [1, 1] : undefined);
		const edit = (line: number, oldText: string, newText: string, sourceSha256 = sha256(bytes)) => ({
			type: "edit" as const,
			path: file,
			reason: "fixture",
			edits: [{ line, sourceSha256, oldText, newText }],
		});
		return { file, bytes, guard, edit };
	}

	it("chooses a repeated line by exact unique context, preserving the other occurrence", () => {
		const { file, bytes, guard, edit } = fixture(
			"function first() {\n  return null;\n}\nfunction second() {\n  return null;\n}\n",
		);
		const resolved = resolveAnchoredEdits(edit(5, "  return null;", "  return 42;"), bytes, guard, file);
		const result = applyEditsToNormalizedContent(bytes.toString(), resolved.edits!, file);
		expect(result.newContent).toBe("function first() {\n  return null;\n}\nfunction second() {\n  return 42;\n}\n");
	});

	it("requires exact full-source identity and complete read coverage", () => {
		const partial = fixture("one\ntwo\n", true);
		expect(() =>
			resolveAnchoredEdits(partial.edit(2, "two", "TWO"), partial.bytes, partial.guard, partial.file),
		).toThrow(/Read the complete file/);
		const complete = fixture("one\ntwo\n");
		expect(() =>
			resolveAnchoredEdits(
				complete.edit(2, "two", "TWO", "0".repeat(64)),
				complete.bytes,
				complete.guard,
				complete.file,
			),
		).toThrow(/stale/);
		complete.guard.forget(complete.file);
		expect(() =>
			resolveAnchoredEdits(complete.edit(2, "two", "TWO"), complete.bytes, complete.guard, complete.file),
		).toThrow(/Read the complete file/);
	});

	it("refuses changed, renamed and competing sources even when the target line still exists", () => {
		const f = fixture("keep\ntarget\n");
		writeFileSync(f.file, "other\ntarget\n");
		const changed = readFileSync(f.file);
		expect(() => resolveAnchoredEdits(f.edit(2, "target", "new"), changed, f.guard, f.file)).toThrow(/stale/);
		f.guard.stale(f.file);
		expect(() => resolveAnchoredEdits(f.edit(2, "target", "new"), f.bytes, f.guard, f.file)).toThrow(/stale/);
	});

	it("does not select a mismatched line or ambiguous substring", () => {
		const f = fixture("aaa\naaa\n");
		expect(() => resolveAnchoredEdits(f.edit(3, "aaa", "BBB"), f.bytes, f.guard, f.file)).toThrow(/ambiguous/);
		expect(() => resolveAnchoredEdits(f.edit(2, "aaa ", "BBB"), f.bytes, f.guard, f.file)).toThrow(/ambiguous/);
	});

	it("bounds context expansion on a large repeated-line source", () => {
		const f = fixture("same\n".repeat(2_000));
		expect(() => resolveAnchoredEdits(f.edit(1_000, "same", "new"), f.bytes, f.guard, f.file)).toThrow(
			/ambiguous or stale/,
		);
	});

	it("keeps BOM, CRLF and Unicode selection exact", () => {
		const f = fixture("\ufeffα\r\nβ\r\nα\r\n");
		const resolved = resolveAnchoredEdits(f.edit(3, "α", "Ω"), f.bytes, f.guard, f.file);
		const normalized = normalizeToLF(f.bytes.toString().slice(1));
		const result = applyEditsToNormalizedContent(normalized, resolved.edits!, f.file);
		expect(result.newContent.replace(/\n/g, "\r\n")).toBe("α\r\nβ\r\nΩ\r\n");
		expect(f.bytes.toString().startsWith("\ufeff")).toBe(true);
	});

	it("refuses mixed line endings, invalid UTF-8, normalized mismatches and conflicting anchors", () => {
		const mixed = fixture("one\r\ntwo\n");
		expect(() => resolveAnchoredEdits(mixed.edit(2, "two", "TWO"), mixed.bytes, mixed.guard, mixed.file)).toThrow(
			/stale/,
		);
		const unicode = fixture("é\n");
		expect(() =>
			resolveAnchoredEdits(unicode.edit(1, "e\u0301", "E"), unicode.bytes, unicode.guard, unicode.file),
		).toThrow(/ambiguous/);
		const invalid = fixture("one\n");
		const bad = Buffer.from([0xff]);
		writeFileSync(invalid.file, bad);
		invalid.guard.record(invalid.file, { sha256: sha256(bad), size: bad.length });
		expect(() =>
			resolveAnchoredEdits(invalid.edit(1, "one", "two", sha256(bad)), bad, invalid.guard, invalid.file),
		).toThrow(/stale/);
		const conflict = fixture("a\nb\na\n");
		const query = conflict.edit(1, "a", "A");
		query.edits.push({ ...query.edits[0], line: 3 });
		const resolved = resolveAnchoredEdits(query, conflict.bytes, conflict.guard, conflict.file);
		expect(() => applyEditsToNormalizedContent(conflict.bytes.toString(), resolved.edits!, conflict.file)).toThrow(
			/overlap/,
		);
	});

	it("passes through the registered guarded file writer and refuses a stale competing write", async () => {
		const f = fixture("first\nreturn null\nsecond\nreturn null\n");
		const api = fakeHost();
		registerFileTool(api.api, f.guard, fakePermission());
		const tool = api.tools.get("file")!;
		const run = (query: ReturnType<typeof f.edit>) =>
			tool.execute("anchored", { queries: [query] }, undefined, undefined, fakeCtx({ cwd: join(f.file, "..") }));
		const result = await run(f.edit(4, "return null", "return 42"));
		expect(result.content[0].text).toContain("OK edit");
		expect(readFileSync(f.file, "utf8")).toBe("first\nreturn null\nsecond\nreturn 42\n");
		writeFileSync(f.file, "theirs\nreturn null\nsecond\nreturn 42\n");
		await expect(run(f.edit(4, "return 42", "return 43"))).rejects.toThrow(
			/anchored edit source or line is ambiguous or stale/,
		);
		expect(readFileSync(f.file, "utf8")).toContain("theirs\n");
	});

	it("reports the new digest after an edit, so the next anchored edit needs no re-read", async () => {
		const f = fixture("a\nreturn null\nb\nreturn null\n");
		const api = fakeHost();
		registerFileTool(api.api, f.guard, fakePermission());
		const tool = api.tools.get("file")!;
		const run = (query: ReturnType<typeof f.edit>) =>
			tool.execute("chained", { queries: [query] }, undefined, undefined, fakeCtx({ cwd: join(f.file, "..") }));
		const first = await run(f.edit(4, "return null", "return 42"));
		const after = readFileSync(f.file);
		expect(first.content[0].text).toContain(`sourceSha256=${sha256(after)}`);
		await run(f.edit(2, "return null", "return 1", sha256(after)));
		expect(readFileSync(f.file, "utf8")).toBe("a\nreturn 1\nb\nreturn 42\n");
	});

	it("accepts the digest of the read after this tool's own edits, shifting the line, and refuses replaced lines", async () => {
		const f = fixture("a\nreturn null\nb\nreturn null\nc\n");
		const api = fakeHost();
		registerFileTool(api.api, f.guard, fakePermission());
		const tool = api.tools.get("file")!;
		const run = (query: ReturnType<typeof f.edit>) =>
			tool.execute("chain", { queries: [query] }, undefined, undefined, fakeCtx({ cwd: join(f.file, "..") }));
		// The read's digest stays usable: the first edit adds a line above line 4.
		await run(f.edit(1, "a", "a\na2"));
		await run(f.edit(4, "return null", "return 42"));
		expect(readFileSync(f.file, "utf8")).toBe("a\na2\nreturn null\nb\nreturn 42\nc\n");
		// Line 4 was replaced by this tool: its old text cannot anchor any more.
		await expect(run(f.edit(4, "return null", "return 43"))).rejects.toThrow(/stale/);
		// An outside change ends the chain.
		writeFileSync(f.file, "a\na2\nreturn null\nb\nreturn 42\nc\nd\n");
		await expect(run(f.edit(5, "c", "C"))).rejects.toThrow(/stale/);
		expect(readFileSync(f.file, "utf8")).toBe("a\na2\nreturn null\nb\nreturn 42\nc\nd\n");
	});

	it("commits a BOM and CRLF source through the guarded writer without changing unrelated bytes", async () => {
		const f = fixture("\ufeffα\r\nβ\r\nα\r\n");
		const api = fakeHost();
		registerFileTool(api.api, f.guard, fakePermission());
		const result = await api.tools
			.get("file")!
			.execute(
				"anchored-crlf",
				{ queries: [f.edit(3, "α", "Ω")] },
				undefined,
				undefined,
				fakeCtx({ cwd: join(f.file, "..") }),
			);
		expect(result.content[0].text).toContain("OK edit");
		expect(readFileSync(f.file, "utf8")).toBe("\ufeffα\r\nβ\r\nΩ\r\n");
	});

	it("names the malformed field of a mis-shaped anchored edit instead of asking for a re-read", async () => {
		const f = fixture("one\ntwo\n");
		const api = fakeHost();
		registerFileTool(api.api, f.guard, fakePermission());
		const tool = api.tools.get("file")!;
		const good = { line: 2, sourceSha256: sha256(f.bytes), oldText: "two", newText: "TWO" };
		const cases: [Record<string, unknown>, RegExp][] = [
			[{ replaceAll: true }, /replaceAll cannot be combined with line/],
			[{ oldText: "one\ntwo" }, /oldText must be the single complete line/],
			[{ newText: "T\rWO" }, /newText must not contain a carriage return/],
			[{ sourceSha256: undefined }, /line needs sourceSha256/],
			[{ line: undefined }, /sourceSha256 needs line/],
			[{ sourceSha256: "abc" }, /sourceSha256 must be 64 lowercase hex/],
			[{ line: 0 }, /line must be an integer of at least 1/],
		];
		for (const [patch, expected] of cases) {
			const run = tool.execute(
				"anchored-shape",
				{ queries: [{ type: "edit", path: f.file, reason: "fixture", edits: [{ ...good, ...patch }] }] },
				undefined,
				undefined,
				fakeCtx({ cwd: join(f.file, "..") }),
			);
			const error = await run.then(
				() => undefined,
				(e: Error) => e,
			);
			expect(error?.message).toMatch(expected);
			expect(error?.message).not.toMatch(/Read the complete file again/);
		}
		expect(readFileSync(f.file, "utf8")).toBe("one\ntwo\n");
	});
});
