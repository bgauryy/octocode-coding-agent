import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonFile } from "../src/json.ts";

describe("readJsonFile", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "octocode-json-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("parses a file and ignores a leading byte-order mark", () => {
		const file = join(dir, "a.json");
		writeFileSync(file, '\uFEFF{"a":1}');
		expect(readJsonFile(file)).toEqual({ a: 1 });
	});

	it("throws for a missing or invalid file when no fallback is given", () => {
		expect(() => readJsonFile(join(dir, "missing.json"))).toThrow(/ENOENT/);
		const bad = join(dir, "bad.json");
		writeFileSync(bad, "{");
		expect(() => readJsonFile(bad)).toThrow(SyntaxError);
	});

	it("returns the fallback for a missing or invalid file", () => {
		const bad = join(dir, "bad.json");
		writeFileSync(bad, "{");
		expect(readJsonFile(join(dir, "missing.json"), { fallback: {} })).toEqual({});
		expect(readJsonFile(bad, { fallback: null })).toBeNull();
	});
});
