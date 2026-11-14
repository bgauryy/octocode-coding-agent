import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const imageCalls = vi.hoisted(() => ({ active: 0, max: 0 }));

vi.mock("../src/utils/image-process.js", () => ({
	processImage: vi.fn(async (bytes: Uint8Array, mimeType: string) => {
		imageCalls.active++;
		imageCalls.max = Math.max(imageCalls.max, imageCalls.active);
		await new Promise((resolve) => setTimeout(resolve, 15));
		imageCalls.active--;
		return { ok: true, data: Buffer.from(bytes).toString("base64"), mimeType, hints: [] };
	}),
}));

import { processFileArguments } from "../src/cli/file-processor.ts";

const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	"base64",
);

describe("processFileArguments concurrency", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "file-processor-concurrency-"));
		imageCalls.active = 0;
		imageCalls.max = 0;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("overlaps image processing up to its own limit and keeps argument order", async () => {
		const paths: string[] = [];
		for (let i = 0; i < 6; i++) {
			const image = join(dir, `image-${i}.png`);
			writeFileSync(image, Buffer.concat([TINY_PNG, Buffer.from([i])]));
			paths.push(image);
			const text = join(dir, `text-${i}.txt`);
			// The first text file is the largest, so its read tends to finish last.
			writeFileSync(text, `text ${i} ${"x".repeat(i === 0 ? 4_000_000 : 10)}`);
			paths.push(text);
		}

		const result = await processFileArguments(paths, { autoResizeImages: false });

		expect(imageCalls.max).toBe(3);
		const names = [...result.text.matchAll(/<file name="([^"]+)">/g)].map((match) => match[1]);
		expect(names).toEqual(paths);
		expect(result.images.map((image) => Buffer.from(image.data, "base64").at(-1))).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it("reports the first failing argument in argument order", async () => {
		const present = join(dir, "present.txt");
		writeFileSync(present, "here");
		const firstMissing = join(dir, "first-missing.txt");
		const secondMissing = join(dir, "second-missing.txt");
		const errors: string[] = [];
		vi.spyOn(console, "error").mockImplementation((message: string) => void errors.push(message));
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`exit ${code}`);
		}) as typeof process.exit);

		await expect(processFileArguments([present, firstMissing, secondMissing])).rejects.toThrow("exit 1");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain(firstMissing);
	});

	it("skips empty files without failing", async () => {
		const empty = join(dir, "empty.txt");
		writeFileSync(empty, "");
		const text = join(dir, "text.txt");
		writeFileSync(text, "body");

		const result = await processFileArguments([empty, text]);

		expect(result.text).toBe(`<file name="${text}">\nbody\n</file>\n`);
	});
});
