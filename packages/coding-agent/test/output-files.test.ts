import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCappedOutputFile, createOutputFileStream, readOutputFile } from "../src/utils/output-files.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { force: true });
});

it("reads completed owned output with a byte limit, without exposing partially written files", async () => {
	const output = createOutputFileStream("octocode-output-test", ".log");
	paths.push(output.path);
	output.stream.write("hello π");
	expect(readOutputFile(output.path, 100)).toBeUndefined();
	await output.close();
	expect(readOutputFile(output.path, 8)).toBe("hello π");
	expect(() => readOutputFile(output.path, 7)).toThrow("byte limit");
	expect(readOutputFile(output.path, 8)).toBe("hello π");
});

it("rejects unregistered paths and replacement files at a formerly owned path", async () => {
	const output = createOutputFileStream("octocode-output-test", ".log");
	const replacement = output.path + ".replacement";
	paths.push(output.path, replacement);
	output.stream.write("owned");
	await output.close();
	writeFileSync(replacement, "unregistered");
	expect(readOutputFile(replacement, 100)).toBeUndefined();
	renameSync(replacement, output.path);
	expect(readOutputFile(output.path, 100)).toBeUndefined();
});

describe("capped output file", () => {
	const note = (dropped: number) => `\n[${dropped} bytes dropped]\n`;
	const capped = (maxBytes: number) => {
		const file = createCappedOutputFile("octocode-output-test", ".log", maxBytes, note);
		paths.push(file.path);
		return file;
	};
	const leftovers = (path: string) =>
		readdirSync(dirname(path)).filter((name) => name.startsWith(`${basename(path)}.`));
	const digits = (count: number) => Array.from({ length: count }, (_, i) => String(i % 10)).join("");

	it("keeps output up to the cap byte for byte, whichever pieces it was written in", async () => {
		// Past the head (half), into both tail segments, and exactly at the cap.
		for (const total of [10, 500, 600, 999, 1000]) {
			const file = capped(1000);
			const text = digits(total);
			for (let at = 0; at < total; at += 70) file.write(Buffer.from(text.slice(at, at + 70)));
			await file.close();
			expect(readFileSync(file.path, "utf8")).toBe(text);
			expect(file.droppedBytes).toBe(0);
			expect(leftovers(file.path)).toEqual([]);
		}
	});

	it("past the cap keeps the start and the end around a marker, and says how much went", async () => {
		const file = capped(1000);
		const text = digits(5000);
		for (let at = 0; at < 5000; at += 70) file.write(Buffer.from(text.slice(at, at + 70)));
		await file.close();
		const saved = readFileSync(file.path, "utf8");
		const [start, end] = saved.split(note(file.droppedBytes));
		expect(start).toBe(text.slice(0, 500));
		// The tail runs from a segment start to the last byte: between one and two segments of 250.
		expect(text.endsWith(end)).toBe(true);
		expect(end.length).toBeGreaterThanOrEqual(250);
		expect(end.length).toBeLessThanOrEqual(500);
		expect(start.length + end.length).toBeLessThanOrEqual(1000);
		expect(file.droppedBytes).toBe(5000 - start.length - end.length);
		expect(leftovers(file.path)).toEqual([]);
		expect(readOutputFile(file.path, saved.length)).toBe(saved);
	});

	it("handles one write far larger than the cap", async () => {
		const file = capped(100);
		file.write(Buffer.from(digits(5000)));
		await file.close();
		expect(file.droppedBytes).toBeGreaterThan(4800);
		expect(readFileSync(file.path, "utf8").length).toBeLessThan(100 + note(file.droppedBytes).length + 1);
		expect(leftovers(file.path)).toEqual([]);
	});

	it("keeps everything with a cap of 0", async () => {
		const file = capped(0);
		const text = digits(50_000);
		file.write(Buffer.from(text));
		await file.close();
		expect(readFileSync(file.path, "utf8")).toBe(text);
		expect(file.droppedBytes).toBe(0);
	});

	it("shares one close and ignores a later write", async () => {
		const file = capped(1000);
		file.write(Buffer.from("kept"));
		await Promise.all([file.close(), file.close()]);
		file.write(Buffer.from("late"));
		await file.close();
		expect(readFileSync(file.path, "utf8")).toBe("kept");
	});
});
