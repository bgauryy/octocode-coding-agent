import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";

const paths: string[] = [];

function accumulate(chunks: string[], options: ConstructorParameters<typeof OutputAccumulator>[0] = {}) {
	const output = new OutputAccumulator({
		tempFilePrefix: "octocode-smart-trim-test",
		maxLines: 600,
		maxBytes: 24 * 1024,
		smartTrim: true,
		...options,
	});
	for (const chunk of chunks) output.append(Buffer.from(chunk, "utf-8"));
	output.finish();
	const snapshot = output.snapshot({ persistIfTruncated: true });
	if (snapshot.fullOutputPath) paths.push(snapshot.fullOutputPath);
	return snapshot;
}

const numbered = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => `line-${String(from + i).padStart(5, "0")}\n`).join("");

afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { force: true });
});

describe("OutputAccumulator smart trim", () => {
	it("keeps the first 20% and last 80% of the budget and counts every line", () => {
		const snapshot = accumulate([numbered(1, 50_000)]);
		expect(snapshot.truncation).toMatchObject({
			truncated: true,
			totalLines: 50_000,
			headLines: 120,
			tailLines: 480,
			matchedLines: 0,
			elidedLines: 49_400,
		});
		const lines = snapshot.content.split("\n");
		expect(lines[0]).toBe("line-00001");
		expect(lines[119]).toBe("line-00120");
		expect(lines[120]).toBe("[... 49400 lines elided]");
		expect(lines[121]).toBe("line-49521");
		expect(snapshot.content.endsWith("line-50000")).toBe(true);
		expect(Buffer.byteLength(snapshot.content)).toBeLessThanOrEqual(24 * 1024);
	});

	it("salvages failure lines from the elided middle with their line numbers, within 20 lines and 2 KB", () => {
		const chunks: string[] = [];
		for (let i = 1; i <= 20_000; i++) {
			if (i === 1834) chunks.push("src/a.ts(3,4): error TS2322: Type 'string' is not assignable\n");
			else if (i === 9000) chunks.push("  FAILED tests/b.test.ts > does a thing\n");
			else if (i === 150) chunks.push("Traceback (most recent call last):\n");
			else chunks.push(`step ${i} ok\n`);
		}
		const snapshot = accumulate(chunks);
		const text = snapshot.content;
		// The matched block and its marker are paid from the tail's share: 3 lines + 1 fewer tail lines.
		expect(text).toContain(
			"[... 19404 lines elided; 3 lines matching error, fail, panic, exception, traceback, fatal, assert below, then the end of the output]\n",
		);
		expect(text).toContain("\n  150: Traceback (most recent call last):\n");
		expect(text).toContain("\n  1834: src/a.ts(3,4): error TS2322: Type 'string' is not assignable\n");
		expect(text).toContain("\n  9000: FAILED tests/b.test.ts > does a thing\n");
		expect(text.indexOf("  150:")).toBeLessThan(text.indexOf("  1834:"));
		expect(text.indexOf("  9000:")).toBeLessThan(text.indexOf("step 20000 ok"));
		expect(snapshot.truncation.matchedLines).toBe(3);
	});

	it("shows matched lines only from the elided part, never twice", () => {
		const chunks = Array.from({ length: 5000 }, (_, i) => `error ${i + 1}\n`);
		const snapshot = accumulate(chunks);
		const matched = snapshot.content.split("\n").filter((line) => /^ {2}\d+: error /.test(line));
		expect(matched.length).toBeLessThanOrEqual(20);
		expect(Buffer.byteLength(matched.join("\n"))).toBeLessThanOrEqual(2048);
		for (const line of matched) {
			const number = Number(/^ {2}(\d+):/.exec(line)![1]);
			// After the 120 head lines, before the last 480 shown.
			expect(number).toBeGreaterThan(120);
			expect(number).toBeLessThanOrEqual(5000 - 480);
		}
	});

	it("cuts a very long matched line so one line cannot use the allowance", () => {
		const long = `error ${"x".repeat(5000)}\n`;
		const snapshot = accumulate([numbered(1, 300), long, numbered(301, 3000)]);
		const line = snapshot.content.split("\n").find((entry) => entry.startsWith("  301: error"))!;
		expect(line.length).toBeLessThan(200);
		expect(line.endsWith("…")).toBe(true);
	});

	it("does not salvage when the output is not trimmed", () => {
		const snapshot = accumulate(["ok\nerror: boom\nok\n"]);
		expect(snapshot.truncation.truncated).toBe(false);
		expect(snapshot.content).toBe("ok\nerror: boom\nok\n");
	});

	it("collapses runs of three or more identical lines and keeps shorter runs", () => {
		const snapshot = accumulate(["a\n", "tick\n".repeat(312), "b\nb\n", "c\n"]);
		expect(snapshot.truncation.truncated).toBe(false);
		expect(snapshot.content).toBe("a\ntick\n[… repeated 312×]\nb\nb\nc\n");
		expect(snapshot.truncation.totalLines).toBe(316);
	});

	it("shows output that fits the budget once its repeats are collapsed, without calling it trimmed", () => {
		const snapshot = accumulate(["spin\n".repeat(5000)]);
		expect(snapshot.truncation.truncated).toBe(false);
		expect(snapshot.content).toBe("spin\n[… repeated 5000×]\n");
		expect(snapshot.truncation.totalLines).toBe(5000);
	});

	it("keeps the full-output file verbatim", async () => {
		const output = new OutputAccumulator({
			tempFilePrefix: "octocode-smart-trim-test",
			smartTrim: true,
			maxLines: 20,
			maxBytes: 400,
		});
		output.append(Buffer.from("same\n".repeat(100) + numbered(1, 100)));
		output.finish();
		const snapshot = output.snapshot({ persistIfTruncated: true });
		paths.push(snapshot.fullOutputPath!);
		await output.closeTempFile();
		const { content } = await output.readFullOutput(1024 * 1024);
		expect(content.startsWith("same\nsame\nsame\n")).toBe(true);
		expect(content.split("\n")).toHaveLength(201);
	});

	it("leaves plain accumulators alone", () => {
		const snapshot = accumulate(["same\n".repeat(10)], { smartTrim: false });
		expect(snapshot.content).toBe("same\n".repeat(10));
	});
});
