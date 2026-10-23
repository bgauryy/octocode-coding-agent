import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { matchHistory } from "../../src/octocode/shared/history-search.ts";
import { tmp } from "./helpers.ts";

function file(text: string): string {
	const name = path.join(tmp(), "history.md");
	fs.writeFileSync(name, text);
	return name;
}

describe("bounded archive search", () => {
	it("matches Unicode and CRLF text with global patterns without dropping subsequent hits", async () => {
		const name = file("שלום needle\r\nNEEDLE\nno match");
		expect(await matchHistory([`${name}.missing`, name], /needle/gi)).toEqual([
			{ index: 1, lines: ["שלום needle\r", "NEEDLE", "no match"], matched: [0, 1] },
		]);
	});

	it("refuses an oversized scan with a narrower-file recovery instruction", async () => {
		const name = file("");
		fs.truncateSync(name, 32 * 1024 * 1024 + 1);
		await expect(matchHistory([name], /needle/)).rejects.toThrow(/exceeds 32 MiB; narrow file/);
	});

	it("aborts a backtracking regex without blocking the event loop and can search again", async () => {
		const name = file(`${"a".repeat(100_000)}!`);
		const controller = new AbortController();
		const reason = new Error("user stopped search");
		const searching = matchHistory([name], /^(a+)+$/, controller.signal);
		const rejected = expect(searching).rejects.toBe(reason);
		const timer = setTimeout(() => controller.abort(reason), 100);
		try {
			await rejected;
		} finally {
			clearTimeout(timer);
		}
		expect(await matchHistory([file("needle")], /needle/)).toMatchObject([{ matched: [0] }]);
	});

	it("ends a pathological regex at its deadline even without a caller abort", async () => {
		await expect(matchHistory([file(`${"a".repeat(100_000)}!`)], /^(a+)+$/)).rejects.toThrow(/exceeded 5 seconds; simplify query/);
	}, 10_000);

	it("rejects an already-aborted call even when there are no files", async () => {
		const controller = new AbortController();
		const reason = new Error("already stopped");
		controller.abort(reason);
		await expect(matchHistory([], /needle/, controller.signal)).rejects.toBe(reason);
	});
});
