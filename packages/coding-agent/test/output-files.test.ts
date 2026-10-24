import { renameSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { createOutputFileStream, readOutputFile } from "../src/utils/output-files.ts";

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
