import { readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { registerSecretValue } from "@octocodeai/octocode-common/sanitize";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";

const paths: string[] = [];

function accumulate(chunks: string[], options: ConstructorParameters<typeof OutputAccumulator>[0] = {}) {
	const output = new OutputAccumulator({ tempFilePrefix: "octocode-accumulator-test", ...options });
	for (const chunk of chunks) output.append(Buffer.from(chunk, "utf-8"));
	output.finish();
	const snapshot = output.snapshot({ persistIfTruncated: true });
	if (snapshot.fullOutputPath) paths.push(snapshot.fullOutputPath);
	return { output, snapshot };
}

const numbered = (count: number, width = 4) =>
	Array.from({ length: count }, (_, i) => `line-${String(i + 1).padStart(width, "0")}\n`).join("");

afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { force: true });
});

describe("OutputAccumulator head and tail", () => {
	it("keeps all output that fits the budget", () => {
		const { snapshot } = accumulate([numbered(2000)]);
		expect(snapshot.truncation.truncated).toBe(false);
		expect(snapshot.content).toBe(numbered(2000));
		expect(snapshot.truncation.headLines).toBeUndefined();
	});

	it("shows the first 20% and the last 80% of the line budget with an elision marker", async () => {
		const { snapshot, output } = accumulate([numbered(3000)]);
		await output.closeTempFile();
		const lines = snapshot.content.split("\n");
		const marker = lines.findIndex((line) => line.startsWith("[... "));

		expect(snapshot.truncation).toMatchObject({
			truncated: true,
			truncatedBy: "lines",
			totalLines: 3000,
			headLines: 400,
			elidedLines: 1000,
			outputLines: 2000,
		});
		expect(marker).toBe(400);
		expect(lines[0]).toBe("line-0001");
		expect(lines[399]).toBe("line-0400");
		expect(lines[marker]).toBe(`[... 1000 lines elided; full output: ${snapshot.fullOutputPath}]`);
		expect(lines[marker + 1]).toBe("line-1401");
		expect(lines.at(-1)).toBe("line-3000");
		expect(lines).toHaveLength(2000 + 1);
		expect(readFileSync(snapshot.fullOutputPath!, "utf-8")).toBe(numbered(3000));
	});

	it("splits by bytes when lines are long", () => {
		const row = (i: number) => `row-${String(i).padStart(3, "0")} ${"x".repeat(990)}\n`;
		const rows = Array.from({ length: 200 }, (_, i) => row(i + 1)); // 200 KB, 200 lines
		const { snapshot } = accumulate([rows.join("")]);
		const { truncation } = snapshot;

		expect(truncation.truncatedBy).toBe("bytes");
		expect(truncation.headLines).toBe(10); // 10 KB head budget / 1 KB lines
		expect(truncation.headBytes).toBeLessThanOrEqual(10 * 1024);
		expect(truncation.outputBytes).toBeLessThanOrEqual(50 * 1024);
		expect(snapshot.content.startsWith("row-001 ")).toBe(true);
		expect(snapshot.content).toContain("row-010 ");
		expect(snapshot.content).not.toContain("row-011 ");
		expect(snapshot.content.trimEnd().endsWith("x")).toBe(true);
		expect(snapshot.content).toContain("row-200 ");
		expect(truncation.totalLines).toBe(200);
		expect(truncation.elidedLines).toBe(200 - 10 - (truncation.outputLines - 10));
		expect(snapshot.content).toContain(`${truncation.elidedLines} lines elided`);
	});

	it("gives a single huge line only its end, without a marker", () => {
		const { snapshot, output } = accumulate([`${"a".repeat(60 * 1024)}END`]);
		expect(snapshot.truncation).toMatchObject({
			truncated: true,
			truncatedBy: "bytes",
			lastLinePartial: true,
			totalLines: 1,
		});
		expect(snapshot.truncation.headLines).toBeUndefined();
		expect(snapshot.content.endsWith("aaaEND")).toBe(true);
		expect(snapshot.content).not.toContain("elided");
		expect(Buffer.byteLength(snapshot.content)).toBeLessThanOrEqual(50 * 1024);
		expect(output.getLastLineBytes()).toBe(60 * 1024 + 3);
	});

	it("marks a cut huge last line after the head", () => {
		const { snapshot } = accumulate(["first\nsecond\n", `${"b".repeat(80 * 1024)}END`]);
		expect(snapshot.truncation).toMatchObject({ lastLinePartial: true, headLines: 2, elidedLines: 0, totalLines: 3 });
		expect(snapshot.content.startsWith(`first\nsecond\n[... start of line 3 elided; full output: `)).toBe(true);
		expect(snapshot.content.endsWith("bbbEND")).toBe(true);
	});

	it("produces the same snapshot however the output is chunked", () => {
		const text = numbered(3000);
		const whole = accumulate([text]).snapshot;
		const sizes = [1, 7, 4096, 33333];
		for (const size of sizes) {
			const chunks: string[] = [];
			for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
			const split = accumulate(chunks).snapshot;
			expect(split.truncation.totalLines).toBe(3000);
			expect(split.truncation.headLines).toBe(400);
			// The marker holds a per-run temp path; compare around it.
			expect(split.content.replace(split.fullOutputPath!, "P")).toBe(whole.content.replace(whole.fullOutputPath!, "P"));
		}
	});

	it("does not cut the head or the tail inside a multi-byte character", () => {
		const line = `${"é".repeat(500)}\n`; // 1001 bytes
		const { snapshot } = accumulate([line.repeat(100)]);
		expect(snapshot.content).not.toContain("\uFFFD");
		expect(snapshot.truncation.headLines).toBeGreaterThan(0);
	});

	it("keeps the full-output file and the rolling tail bounded while streaming", () => {
		const output = new OutputAccumulator({ tempFilePrefix: "octocode-accumulator-test" });
		const line = `${"z".repeat(99)}\n`;
		for (let i = 0; i < 20_000; i++) output.append(Buffer.from(line));
		output.finish();
		const snapshot = output.snapshot({ persistIfTruncated: true });
		paths.push(snapshot.fullOutputPath!);
		expect(snapshot.truncation).toMatchObject({ totalLines: 20_000, headLines: 102 });
		expect((output as unknown as { head: { buffer: string } }).head.buffer.length).toBeLessThanOrEqual(10 * 1024 + 1);
		expect((output as unknown as { tailText: string }).tailText.length).toBeLessThanOrEqual(2 * 2 * 50 * 1024 + 100);
	});

	it("respects custom limits", () => {
		const { snapshot } = accumulate([numbered(100)], { maxLines: 10, maxBytes: 10_000 });
		const lines = snapshot.content.split("\n");
		expect(snapshot.truncation).toMatchObject({ headLines: 2, outputLines: 10, elidedLines: 90 });
		expect(lines.slice(0, 2)).toEqual(["line-0001", "line-0002"]);
		expect(lines.at(-1)).toBe("line-0100");
	});

	it("readFullOutput still returns the whole output", async () => {
		const { output } = accumulate([numbered(3000)]);
		await output.closeTempFile();
		const full = await output.readFullOutput(10 * 1024 * 1024);
		// The saved file's path comes with it, so a caller can refer to the output instead of copying it.
		expect(full).toEqual({ content: numbered(3000), truncated: false, path: expect.any(String) });
	});
});

describe("OutputAccumulator carriage returns", () => {
	it("shows only the final state of a rewritten line", () => {
		const { snapshot } = accumulate(["50%\r100%\n"]);
		expect(snapshot.content).toBe("100%\n");
		expect(snapshot.truncation.totalLines).toBe(1);
		expect(snapshot.truncation.totalBytes).toBe(5);
	});

	it("keeps CRLF as a newline", () => {
		const { snapshot } = accumulate(["one\r\ntwo\r\n"]);
		expect(snapshot.content).toBe("one\ntwo\n");
		expect(snapshot.truncation.totalLines).toBe(2);
	});

	it("handles a carriage return split from its line feed", () => {
		const { snapshot } = accumulate(["one\r", "\ntwo\r", "\n"]);
		expect(snapshot.content).toBe("one\ntwo\n");
	});

	it("handles a carriage return at the end of a chunk followed by a rewrite", () => {
		const { snapshot } = accumulate(["Downloading 10%\r", "Downloading 55%\r", "Downloading 100%", "\ndone\n"]);
		expect(snapshot.content).toBe("Downloading 100%\ndone\n");
	});

	it("handles a progress bar split at every byte", () => {
		const text = "[#   ] 25%\r[##  ] 50%\r[### ] 75%\r[####] 100%\r\nok\r\n";
		const { snapshot } = accumulate(text.split(""));
		expect(snapshot.content).toBe("[####] 100%\nok\n");
	});

	it("keeps the last rewrite when the output ends without a newline", () => {
		const before = new OutputAccumulator({ tempFilePrefix: "octocode-accumulator-test" });
		before.append(Buffer.from("a\n10%\r20%"));
		// Streaming view before the line ends.
		expect(before.snapshot().content).toBe("a\n20%");
		before.append(Buffer.from("\r"));
		expect(before.snapshot().content).toBe("a\n20%");
		before.finish();
		expect(before.snapshot().content).toBe("a\n20%");
	});

	it("keeps a trailing carriage return from erasing the line", () => {
		const { snapshot } = accumulate(["abc\r\r\n", "x\r\r"]);
		expect(snapshot.content).toBe("abc\nx");
	});

	it("does not count collapsed redraws toward the truncation limits", () => {
		const redraws = Array.from({ length: 5000 }, (_, i) => `progress ${i}%\r`).join("");
		const { snapshot } = accumulate([`${redraws}done\n`]);
		expect(snapshot.truncation.truncated).toBe(false);
		expect(snapshot.content).toBe("done\n");
	});

	it("keeps raw bytes in the spill file and in readFullOutput", async () => {
		const raw = `${"x".repeat(60 * 1024)}\n50%\r100%\r\n`;
		const { output, snapshot } = accumulate([raw]);
		await output.closeTempFile();
		expect(snapshot.content.endsWith("100%")).toBe(true);
		expect(snapshot.content).not.toContain("50%");
		expect(readFileSync(output.snapshot().fullOutputPath!, "utf-8")).toBe(raw);
		expect((await output.readFullOutput(10 * 1024 * 1024)).content).toBe(raw);
	});
});

describe("OutputAccumulator secret redaction", () => {
	it("redacts a registered secret in the spill file, also when chunks split it", async () => {
		const secret = "zq-sly-tide-secret-value-91827364";
		expect(registerSecretValue(secret)).toBe(true);
		const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
		const { output, snapshot } = accumulate([
			`${lines}\nkey=${secret.slice(0, 10)}`,
			`${secret.slice(10)}\ntail=${secret}`,
		]);
		await output.closeTempFile();
		const saved = readFileSync(snapshot.fullOutputPath!, "utf-8");
		expect(saved).not.toContain(secret);
		expect(saved).not.toContain(secret.slice(0, 10));
		expect(saved.startsWith("line 0\n")).toBe(true);
		expect(saved).toContain("line 2999\n");
		expect(saved.endsWith("tail=" + saved.slice(saved.lastIndexOf("tail=") + 5))).toBe(true);
	});
});

describe("OutputAccumulator spill cap", () => {
	const lines = numbered(200_000, 6);

	it("gives the model the same view with the cap on, and only the file changes", async () => {
		const free = accumulate([lines], { spillMaxBytes: 0, smartTrim: true });
		const capped = accumulate([lines], { spillMaxBytes: 100_000, smartTrim: true });
		await Promise.all([free.output.closeTempFile(), capped.output.closeTempFile()]);

		expect(capped.snapshot.content).toBe(free.snapshot.content);
		expect(capped.snapshot.truncation).toEqual(free.snapshot.truncation);
		expect(free.output.spillDroppedBytes).toBe(0);
		expect(readFileSync(free.snapshot.fullOutputPath!, "utf8")).toBe(lines);

		const dropped = capped.output.spillDroppedBytes;
		expect(dropped).toBeGreaterThan(lines.length - 100_000 - 1);
		const saved = readFileSync(capped.snapshot.fullOutputPath!, "utf8");
		expect(saved.length).toBeLessThan(100_000 + 300);
		expect(saved.startsWith(lines.slice(0, 50_000))).toBe(true);
		expect(saved.endsWith(lines.slice(-25_000))).toBe(true);
		expect(saved).toMatch(/\[\.\.\. [\d.]+ [KM]B dropped here: .*bash\.spillMaxBytes cap \(0 lifts it\)/);
	});

	it("leaves a file under the cap untouched and defaults to a cap far above ordinary output", async () => {
		const below = accumulate([lines], { spillMaxBytes: lines.length });
		const unset = accumulate([lines]);
		await Promise.all([below.output.closeTempFile(), unset.output.closeTempFile()]);
		for (const { snapshot, output } of [below, unset]) {
			expect(readFileSync(snapshot.fullOutputPath!, "utf8")).toBe(lines);
			expect(output.spillDroppedBytes).toBe(0);
		}
	});

	it("reads structured output from the capped file like any other", async () => {
		const { output } = accumulate([lines], { spillMaxBytes: 100_000 });
		await output.closeTempFile();
		const full = await output.readFullOutput(1_000);
		expect(full.truncated).toBe(true);
		expect(full.content.startsWith("line-000001\n")).toBe(true);
		expect(full.content.endsWith("line-200000\n")).toBe(true);
	});
});
