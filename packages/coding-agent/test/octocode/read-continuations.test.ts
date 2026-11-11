import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	clearReadContinuations,
	rememberReadContinuations,
	snapshotReadCall,
} from "../../src/octocode/files/read-continuations.ts";
import { completedLocalReads, type snapshotLocalReads } from "../../src/octocode/shared/local-reads.ts";
import { RESEARCH, useResearchRoles } from "./fake-research-roles.ts";
import { tmp } from "./helpers.ts";

describe("paged reader receipts", () => {
	useResearchRoles();
	async function fixture() {
		const cwd = fs.realpathSync(tmp());
		const file = path.join(cwd, "notes.txt");
		fs.writeFileSync(file, "one\ntwo\nthree\nfour\n");
		const calls = new Map<string, Awaited<ReturnType<typeof snapshotLocalReads>>>();
		const snapshots = await snapshotReadCall(calls, RESEARCH.reader, { queries: [{ path: file }] }, cwd);
		const output = {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						results: [{ data: { path: file, content: "1\tone\n2\ttwo" } }],
						responsePagination: { next: { kind: "continue", tool: "read_file", input: { cursor: "page-two" } } },
					}),
				},
			],
		};
		rememberReadContinuations(calls, RESEARCH.reader, cwd, snapshots, output);
		return { cwd, file, calls };
	}
	it("credits a cursor-only continuation against the original unchanged file", async () => {
		const { cwd, file, calls } = await fixture();
		const input = { cursor: "page-two" };
		const snapshots = await snapshotReadCall(calls, RESEARCH.reader, input, cwd);
		const output = { structuredContent: { path: file, content: "3\tthree\n4\tfour" } };
		expect(await completedLocalReads(snapshots, output, cwd, input)).toMatchObject([
			{ file, whole: false, lines: [3, 4] },
		]);
		clearReadContinuations(calls);
		expect((await snapshotReadCall(calls, RESEARCH.reader, input, cwd)).size).toBe(0);
	});
	it("refuses credit after a change between pages, even when the new page matches disk", async () => {
		const { cwd, file, calls } = await fixture();
		fs.writeFileSync(file, "one\ntwo\nchanged\nfour\n");
		const snapshots = await snapshotReadCall(calls, RESEARCH.reader, { cursor: "page-two" }, cwd);
		expect(
			await completedLocalReads(snapshots, { structuredContent: { path: file, content: "3\tchanged\n4\tfour" } }, cwd),
		).toEqual([]);
	});
	it("scopes opaque cursors to their session, reader and working directory", async () => {
		const { cwd, calls } = await fixture();
		const input = { cursor: "page-two" };
		for (const [state, tool, directory] of [
			[new Map(), RESEARCH.reader, cwd],
			[calls, RESEARCH.search, cwd],
			[calls, RESEARCH.other, cwd],
			[calls, RESEARCH.reader, path.dirname(cwd)],
		] as const)
			expect((await snapshotReadCall(state, tool, input, directory)).size).toBe(0);
	});

	it("expires retained file identities rather than retaining them indefinitely", async () => {
		const { cwd, calls } = await fixture();
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000 + 1);
		try {
			expect((await snapshotReadCall(calls, RESEARCH.reader, { cursor: "page-two" }, cwd)).size).toBe(0);
		} finally {
			clock.mockRestore();
		}
	});
});
