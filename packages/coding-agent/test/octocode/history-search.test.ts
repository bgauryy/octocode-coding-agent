import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanHistory } from "../../src/octocode/history/search.ts";
import { tmp } from "./helpers.ts";

function file(text: string): string {
	const name = path.join(tmp(), "history.md");
	fs.writeFileSync(name, text);
	return name;
}

describe("bounded archive search", () => {
	it("matches Unicode and CRLF text with global patterns, with context, without dropping subsequent hits", async () => {
		const name = file("שלום needle\r\nNEEDLE\nno match\nx\ny\nz");
		const scan = await scanHistory([`${name}.missing`, name], /needle/gi, undefined, { context: 1 });
		expect(scan).toEqual({
			results: [{ index: 1, lines: { 0: "שלום needle\r", 1: "NEEDLE", 2: "no match" }, matched: [0, 1] }],
			scanned: 1,
			unreadable: 1,
			skippedLines: 0,
		});
	});

	it("scans a file over 32 MiB line by line instead of refusing it", async () => {
		const name = file("");
		const fd = fs.openSync(name, "w");
		const filler = Buffer.from(`${"filler ".repeat(1000)}\n`);
		for (let written = 0; written <= 33 * 1024 * 1024; written += filler.length) fs.writeSync(fd, filler);
		fs.writeSync(fd, "the needle at the end");
		fs.closeSync(fd);
		const scan = await scanHistory([name], /needle/);
		expect(scan.results).toMatchObject([{ matched: [expect.any(Number)] }]);
		expect(scan.next).toBeUndefined();
	}, 20_000);

	it("stops at its match budget and resumes after the last line it read", async () => {
		const name = file(Array.from({ length: 10 }, (_, i) => `needle ${i}`).join("\n"));
		const first = await scanHistory([name], /needle/, undefined, { maxMatches: 4 });
		expect(first.results[0].matched).toEqual([0, 1, 2, 3]);
		expect(first.next).toMatchObject({ file: 0, line: 4 });
		const rest = await scanHistory([name], /needle/, undefined, { start: first.next, maxMatches: 100 });
		expect(rest.results[0].matched).toEqual([4, 5, 6, 7, 8, 9]);
		expect(rest.next).toBeUndefined();
	});

	it("stops at its time budget and still makes progress through a file", async () => {
		const name = file("needle\nneedle\nneedle");
		const scan = await scanHistory([name], /needle/, undefined, { budgetMs: -1 });
		expect(scan.next).toEqual({ file: 0, offset: 0, line: 0 });
		expect(scan.results).toEqual([]);
	});

	it("skips and counts a line over the line limit without failing", async () => {
		const name = file(`needle first\n${"x".repeat(17 * 1024 * 1024)}needle\nneedle last`);
		const scan = await scanHistory([name], /needle/);
		expect(scan.results[0].matched).toEqual([0, 2]);
		expect(scan.skippedLines).toBe(1);
	}, 20_000);

	it("aborts a backtracking regex without blocking the event loop and can search again", async () => {
		const name = file(`${"a".repeat(100_000)}!`);
		const controller = new AbortController();
		const reason = new Error("user stopped search");
		const searching = scanHistory([name], /^(a+)+$/, controller.signal);
		const rejected = expect(searching).rejects.toBe(reason);
		const timer = setTimeout(() => controller.abort(reason), 100);
		try {
			await rejected;
		} finally {
			clearTimeout(timer);
		}
		expect((await scanHistory([file("needle")], /needle/)).results).toMatchObject([{ matched: [0] }]);
	});

	it("ends a pathological regex at its deadline even without a caller abort", async () => {
		await expect(scanHistory([file(`${"a".repeat(100_000)}!`)], /^(a+)+$/)).rejects.toThrow(
			/exceeded 5 seconds; simplify query/,
		);
	}, 10_000);

	it("rejects an already-aborted call even when there are no files", async () => {
		const controller = new AbortController();
		const reason = new Error("already stopped");
		controller.abort(reason);
		await expect(scanHistory([], /needle/, controller.signal)).rejects.toBe(reason);
	});
});
