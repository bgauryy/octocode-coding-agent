import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTextWindow } from "../src/core/tools/read-text.ts";
import { truncateHead } from "../src/core/tools/truncate.ts";
import { createLsTool } from "../src/core/tools/ls.ts";
import { createReadTool } from "../src/core/tools/read.ts";

const dirs: string[] = [];
function fixture(text: string) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-window-"));
	dirs.push(dir);
	const file = path.join(dir, "data.txt");
	fs.writeFileSync(file, text);
	return file;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("streamed text windows", () => {
	it("preserves exact truncation and counts across UTF-8 chunks, empty lines and range boundaries", async () => {
		for (const text of ["", "a\n", "\n\n", "a\r\nb\r\n", "🙂é文".repeat(30_000) + "\nend", "line\n".repeat(10_000)]) {
			const file = fixture(text);
			const lines = text.split("\n");
			for (const [offset, limit] of [
				[1, undefined],
				[1, 1],
				[2, 3],
				[2001, 5],
			] as const) {
				const result = await readTextWindow(file, offset, limit);
				const selected = lines.slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit).join("\n");
				expect(result.truncation).toEqual(truncateHead(selected));
				expect(result.totalFileLines).toBe(lines.length);
			}
		}
	});
	it("cancels an active read and rejects invalid ranges", async () => {
		const file = fixture("line\n".repeat(1_000_000));
		const controller = new AbortController();
		const pending = readTextWindow(file, 1, 1, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow();
		const read = createReadTool(path.dirname(file));
		for (const params of [{ offset: 0 }, { offset: 1.5 }, { limit: -1 }])
			await expect(read.execute("read", { path: file, ...params })).rejects.toThrow(/positive integer/);
	});
});

describe("directory continuations", () => {
	it("pages through the byte cap without dropping or repeating entries", async () => {
		const entries = Array.from({ length: 400 }, (_, i) => `${i.toString().padStart(4, "0")}-${"x".repeat(180)}`);
		const tool = createLsTool("/", {
			operations: {
				exists: () => true,
				stat: () => ({ isDirectory: () => false }),
				readdir: () => entries,
			},
		});
		// The root is a directory, while each entry is a file.
		const directoryTool = createLsTool("/", {
			operations: {
				exists: () => true,
				stat: (file) => ({ isDirectory: () => file === "/" }),
				readdir: () => entries,
			},
		});
		const first = await directoryTool.execute("ls", { limit: 400 });
		const next = first.details!.nextOffset!;
		expect(next).toBeGreaterThan(0);
		expect(next).toBeLessThan(400);
		const second = await directoryTool.execute("ls", { offset: next, limit: 400 });
		const text = (result: typeof first) => (result.content[0] as { text: string }).text.split("\n\n[")[0].split("\n");
		expect([...text(first), ...text(second)]).toEqual(entries);
		await expect(tool.execute("ls", { offset: -1 })).rejects.toThrow(/non-negative integer/);
	});
});
