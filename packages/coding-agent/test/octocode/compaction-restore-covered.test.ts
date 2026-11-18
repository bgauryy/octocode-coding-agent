import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deliverRestoredFiles, RESTORE_TOTAL_CHARS } from "../../src/octocode/compaction/restore.ts";
import { tmp } from "./helpers.ts";
import { asSetup } from "./fake-host.ts";

const call = (id: string, args: Record<string, unknown>) => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name: "read", arguments: args }],
});
const result = (id: string, timestamp: number) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [{ type: "text", text: "" }],
	isError: false,
	timestamp,
});

/** Restores `file` after a compaction whose kept tail holds `reads` (each an offset and limit of one read). */
function restoreAfter(file: string, dir: string, reads: Array<{ offset: number; limit: number }>) {
	const stat = fs.statSync(file);
	const at = Math.max(stat.mtimeMs, stat.ctimeMs) + 1_000;
	const kept = reads.flatMap((read, index) => [call(`r${index}`, { path: file, ...read }), result(`r${index}`, at)]);
	const ctx = {
		cwd: dir,
		sessionManager: {
			getBranch: () => [],
			buildSessionProjection: () => ({
				entries: kept.map((message, index) => ({ sourceEntry: { id: `k${index}` }, messages: [message] })),
			}),
		},
	};
	const sent: unknown[] = [];
	const api = asSetup({ sendMessage: (message: unknown) => void sent.push(message) });
	return { pending: deliverRestoredFiles(api, [{ file }], ctx as never, RESTORE_TOTAL_CHARS), sent };
}

describe("a file the kept tail's partial reads cover", () => {
	const lines = (count: number) => Array.from({ length: count }, (_, i) => `row ${i + 1} ${"x".repeat(40)}\n`).join("");

	it("is not restored when two reads together cover a small file", () => {
		const dir = tmp();
		const file = path.join(dir, "small.ts");
		fs.writeFileSync(file, lines(100));
		const { pending, sent } = restoreAfter(file, dir, [
			{ offset: 1, limit: 50 },
			{ offset: 51, limit: 50 },
		]);
		expect(pending).toBeUndefined();
		expect(sent).toHaveLength(0);
	});

	it("is not restored when the tail shows the lines the restore would show of a long file", () => {
		const dir = tmp();
		const file = path.join(dir, "long.ts");
		fs.writeFileSync(file, lines(3_000));
		const { pending, sent } = restoreAfter(file, dir, [{ offset: 1, limit: 2_500 }]);
		expect(pending).toBeUndefined();
		expect(sent).toHaveLength(0);
	});

	it("is still restored when the tail's read leaves lines out that the restore shows", () => {
		const dir = tmp();
		const file = path.join(dir, "gap.ts");
		fs.writeFileSync(file, lines(3_000));
		const { pending } = restoreAfter(file, dir, [{ offset: 1, limit: 5 }]);
		expect(pending?.files.map((entry) => entry.file)).toEqual([file]);
	});
});
