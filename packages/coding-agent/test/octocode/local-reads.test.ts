import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerReadReceipts } from "../../src/octocode/files/read-receipts.ts";
import {
	appendReadDigests,
	completedLocalReads,
	recordedLocalReads,
	snapshotLocalReads,
} from "../../src/octocode/shared/local-reads.ts";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { publishRoles, RESEARCH, RESEARCH_ENTRY, useResearchRoles } from "./fake-research-roles.ts";
import { tmp } from "./helpers.ts";

/** A synthetic server's result shape (no real server's): documents with a `path` and numbered or whole text. */
const wrap = (structuredContent: unknown) => ({ content: [], structuredContent });

function workspace(text = "one\ntwo\nthree\nfour\n") {
	const cwd = fs.realpathSync(tmp());
	const file = path.join(cwd, "notes.txt");
	fs.writeFileSync(file, text);
	return { cwd, file, digest: sha256(Buffer.from(text)) };
}

async function credit(tool: string, input: Record<string, unknown>, output: unknown, cwd: string) {
	return completedLocalReads(await snapshotLocalReads(tool, input, cwd), output, cwd, input);
}

describe("the generic reader contract", () => {
	useResearchRoles();

	it("credits numbered lines that cover the file as a whole read, under the nearest object with a path", async () => {
		const { cwd, file, digest } = workspace();
		const output = wrap({ documents: [{ path: "notes.txt", body: "1\tone\n2\ttwo\n3\tthree\n4\tfour\n" }] });
		const reads = await credit(RESEARCH.reader, { request: { path: "notes.txt" } }, output, cwd);
		expect(reads).toEqual([{ file, sha256: digest, size: 19, whole: true }]);
		const content = [{ type: "text" as const, text: "shown" }];
		expect(appendReadDigests(content, reads).at(-1)).toEqual({
			type: "text",
			text: `Whole-source SHA-256 for optional anchored edits:\nsourceSha256=${digest} path=${JSON.stringify(file)}`,
		});
	});

	it("credits separated groups as partial spans, never the gap between them", async () => {
		const { cwd, file } = workspace();
		const output = wrap({ documents: [{ path: file, body: "1\tone\n--\n3\tthree\n4\tfour" }] });
		const reads = await credit(RESEARCH.reader, { path: file }, output, cwd);
		expect(reads.map((read) => [read.whole, read.lines])).toEqual([
			[false, [1, 1]],
			[false, [3, 4]],
		]);
		expect(appendReadDigests([{ type: "text" as const, text: "x" }], reads)).toHaveLength(1);
	});

	it("credits a string equal to the whole file by its digest, also from a single JSON text block", async () => {
		const { cwd, file } = workspace();
		const block = {
			content: [
				{ type: "text", text: JSON.stringify({ item: { path: "notes.txt", raw: "one\ntwo\nthree\nfour\n" } }) },
			],
		};
		expect(await credit(RESEARCH.reader, { path: "notes.txt" }, block, cwd)).toMatchObject([{ file, whole: true }]);
	});

	it("resolves a relative path against the nearest absolute root, and uses the input's only path when none is named", async () => {
		const { cwd, file } = workspace();
		const sub = fs.mkdtempSync(path.join(cwd, "sub-"));
		const rooted = wrap({ root: cwd, groups: [{ entries: [{ path: "notes.txt", hits: [{ snippet: "2\ttwo" }] }] }] });
		expect(await credit(RESEARCH.reader, { path: file, cwd: sub }, rooted, sub)).toMatchObject([
			{ file, whole: false, lines: [2, 2] },
		]);
		const pathless = wrap({ text: "3\tthree" });
		expect(await credit(RESEARCH.reader, { path: "notes.txt" }, pathless, cwd)).toMatchObject([
			{ file, lines: [3, 3] },
		]);
	});

	it("credits batch rows that leave the path out by the request their index names, and nothing past the batch", async () => {
		const { cwd, file } = workspace();
		const other = path.join(cwd, "other.txt");
		fs.writeFileSync(other, "alpha\nbeta\n");
		const input = { queries: [{ path: "other.txt" }, { path: "notes.txt", ranges: [{ startLine: 2, endLine: 3 }] }] };
		// Rows in reverse order: the index, not the position, names the request.
		const output = wrap({
			results: [
				{ index: 1, data: { content: "2\ttwo\n3\tthree", totalLines: 4 } },
				{ index: 0, data: { content: "1\talpha\n2\tbeta" } },
				{ index: 2, data: { content: "1\tone" } },
			],
		});
		expect(await credit(RESEARCH.reader, input, output, cwd)).toMatchObject([
			{ file, whole: false, lines: [2, 3] },
			{ file: other, whole: true },
		]);
		// A nested `index` under a row that names its file is the server's own field, not a request.
		const nested = wrap({ results: [{ path: "other.txt", hits: [{ index: 1, text: "1\tone" }] }] });
		expect(await credit(RESEARCH.reader, input, nested, cwd)).toEqual([]);
	});

	it("credits a search of a directory for files unchanged since it began", async () => {
		const { cwd, file } = workspace();
		const old = Date.now() / 1000 - 60;
		fs.utimesSync(file, old, old);
		// The change time moved with utimes: let the clock pass it before the search begins.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const output = wrap({ matches: [{ path: "notes.txt", lines: "4\tfour" }] });
		expect(await credit(RESEARCH.search, { path: cwd }, output, cwd)).toMatchObject([{ file, lines: [4, 4] }]);
		// A reader does not snapshot directories, so it cannot credit files it was not asked for.
		expect(await credit(RESEARCH.reader, { path: cwd }, output, cwd)).toEqual([]);
	});

	it("refuses a changed file, a sanitized line and a wrong line number", async () => {
		const { cwd, file } = workspace("token=abc\nplain\n");
		const before = await snapshotLocalReads(RESEARCH.reader, { path: file }, cwd);
		const shown = wrap({ path: file, body: "1\ttoken=abc\n2\tplain\n" });
		fs.writeFileSync(file, "token=abc\nplain\nmore\n");
		expect(await completedLocalReads(before, shown, cwd, { path: file })).toEqual([]);
		const { cwd: other, file: secret } = workspace("token=abc\nplain\n");
		const sanitized = wrap({ path: secret, body: "1\ttoken=[REDACTED]\n2\tplain\n" });
		expect(await credit(RESEARCH.reader, { path: secret }, sanitized, other)).toMatchObject([
			{ whole: false, lines: [2, 2] },
		]);
		const shifted = wrap({ path: secret, body: "2\ttoken=abc\n1\tplain\n" });
		expect(await credit(RESEARCH.reader, { path: secret }, shifted, other)).toEqual([]);
	});

	it("credits nothing from an error, a tool without a reader or search role, or an untrusted project's server", async () => {
		const { cwd } = workspace();
		const output = wrap({ path: "notes.txt", body: "1\tone\n2\ttwo\n3\tthree\n4\tfour" });
		const input = { path: "notes.txt" };
		expect(await credit(RESEARCH.reader, input, { ...output, isError: true }, cwd)).toEqual([]);
		expect(await credit(RESEARCH.readOnly, input, output, cwd)).toEqual([]);
		const claims = { command: "evil", roles: { reader: ["read"], search: ["grep"] } };
		publishRoles([RESEARCH_ENTRY, { name: "evil", config: claims, scope: "project", trusted: false }]);
		expect((await snapshotLocalReads("mcp__evil__read", input, cwd)).size).toBe(0);
		expect(await credit("mcp__evil__read", input, output, cwd)).toEqual([]);
		publishRoles([{ name: "evil", config: claims, scope: "project", trusted: true }]);
		expect(await credit("mcp__evil__read", input, output, cwd)).toMatchObject([{ whole: true }]);
	});

	it("credits a read through the result hook and keeps only valid recorded reads", async () => {
		const { cwd, file } = workspace();
		const fake = fakeHost();
		const snapshots = registerReadReceipts(fake.api);
		const input = { path: "notes.txt" };
		snapshots.set("call-1", await snapshotLocalReads(RESEARCH.reader, input, cwd));
		const event = {
			type: "tool_result",
			toolName: RESEARCH.reader,
			toolCallId: "call-1",
			input,
			content: [{ type: "text", text: "shown" }],
			structuredContent: wrap({ path: "notes.txt", body: "1\tone\n2\ttwo\n3\tthree\n4\tfour\n" }),
			isError: false,
			details: {},
		};
		const result = (await fake.fire("tool_result", event, fakeCtx({ cwd }))) as { details: unknown };
		expect(recordedLocalReads(result.details)).toMatchObject([{ file, whole: true }]);
		expect(snapshots.size).toBe(0);
		expect(recordedLocalReads({ localReads: [{ file: "relative", sha256: "x", size: 1, whole: true }] })).toEqual([]);
	});
});
