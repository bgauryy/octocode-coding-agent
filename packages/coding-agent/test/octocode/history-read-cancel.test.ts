import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { paginate, readHistory } from "../../src/octocode/history/transcripts.ts";
import { tmp } from "./helpers.ts";

it("cancels a history file read before opening it", async () => {
	const file = path.join(tmp(), "archive.md");
	fs.writeFileSync(file, "retained text\n");
	const signal = AbortSignal.abort(new Error("cancel history read"));
	await expect(Promise.resolve().then(() => readHistory(file, 1, 1, signal))).rejects.toThrow("cancel history read");
});

it("honors cancellation while reading a large archive without a synchronous file read", async () => {
	const file = path.join(tmp(), "archive.md");
	fs.writeFileSync(file, "archive line\n".repeat(1_000_000));
	const controller = new AbortController();
	const reading = Promise.resolve().then(() => readHistory(file, 1, 1, controller.signal));
	const timer = setTimeout(() => controller.abort(new Error("stop large history read")), 0);
	try {
		await expect(reading).rejects.toThrow("stop large history read");
	} finally {
		clearTimeout(timer);
	}
});

it("honors cancellation during final handle cleanup", async () => {
	const file = path.join(tmp(), "archive.md");
	fs.writeFileSync(file, "retained text\n");
	const handle = await fs.promises.open(file, "r");
	const close = handle.close.bind(handle);
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const open = vi.spyOn(fs.promises, "open").mockResolvedValue(handle);
	const closing = vi.spyOn(handle, "close").mockImplementation(async () => {
		enter();
		await released;
		await close();
	});
	const controller = new AbortController();
	try {
		const reading = readHistory(file, 1, 1, controller.signal);
		const rejected = expect(reading).rejects.toThrow("cancel cleanup");
		await entered;
		controller.abort(new Error("cancel cleanup"));
		release();
		await rejected;
		expect(handle.fd).toBe(-1);
	} finally {
		release();
		open.mockRestore();
		closing.mockRestore();
		await close();
	}
});

it.each([
	["empty", ""],
	["trailing", "first\n"],
	["unterminated", "first\nlast"],
	["CRLF", "first\r\nlast\r\n"],
	["split UTF-8", "😀".repeat(40_000) + "\nlast"],
])("preserves %s lines when clamping past EOF", async (_name, text) => {
	const file = path.join(tmp(), "archive.md");
	fs.writeFileSync(file, text);
	const lines = text.split("\n");
	const read = await readHistory(file, lines.length + 100);
	expect(read).toMatchObject({ first: lines.length, last: lines.length, total: lines.length, page: 1, pages: 1 });
	expect(read?.text).toBe(` ${String(lines.length).padStart(6)}│ ${lines.at(-1)}`);
});

it("returns undefined for a symlink and directory", async () => {
	const dir = tmp();
	const file = path.join(dir, "archive.md");
	const link = path.join(dir, "link.md");
	fs.writeFileSync(file, "retained text");
	fs.symlinkSync(file, link);
	expect(await readHistory(link)).toBeUndefined();
	expect(await readHistory(dir)).toBeUndefined();
});

it("returns every character of selected lines spanning UTF-8 chunks and multiple pages", async () => {
	const file = path.join(tmp(), "archive.md");
	const text = "prefix\n" + "😀".repeat(40_000) + "\r\nlast";
	fs.writeFileSync(file, text);
	const expected = paginate([
		{ lines: text.split("\n").map((line, index) => ` ${String(index + 1).padStart(6)}│ ${line}`) },
	]);
	for (const [index, page] of expected.entries()) {
		const read = await readHistory(file, 1, index + 1);
		expect(read).toMatchObject({ text: page, page: index + 1, pages: expected.length, first: 1, last: 3, total: 3 });
	}
});
