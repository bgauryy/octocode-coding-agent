import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/** Names of one specific agent harness; the core must stay harness-neutral. */
const HARNESS_NAME = /claude[ -]?code|\bcodex\b/i;
/** A string literal that reaches into src/adapters from anywhere in the core. */
const ADAPTER_IMPORT = /["'](?:\.{1,2}\/)+adapters(?:\/|["'])/;

function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
	);
}

const coreFiles = (): string[] =>
	files(src).filter((f) => {
		const rel = relative(src, f).split(sep).join("/");
		return !rel.startsWith("adapters/");
	});

const offending = (text: string, pattern: RegExp = /octocode/i): string[] =>
	text.split("\n").flatMap((l, i) => (pattern.test(l) ? [`${i + 1}: ${l.trim()}`] : []));

/** Offending lines across the core files, prefixed with the file they sit in. */
const coreHits = (pattern: RegExp, onlyFiles: (rel: string) => boolean = () => true): string[] =>
	coreFiles().flatMap((f) => {
		const rel = relative(src, f).split(sep).join("/");
		return onlyFiles(rel) ? offending(readFileSync(f, "utf8"), pattern).map((h) => `${rel}:${h}`) : [];
	});

describe("core is decoupled from any one harness", () => {
	it("scans the core files", () => {
		const names = coreFiles().map((f) => relative(src, f));
		for (const core of [
			"trace.ts",
			"context.ts",
			"gateway.ts",
			"mcp.ts",
			"memory.ts",
			"matchers.ts",
			"live.ts",
			"cassette.ts",
		])
			expect(names).toContain(core);
	});

	it("flags the word in a sample (the scan is not vacuous)", () => {
		expect(offending("a\nconst x = 'Octocode';")).toEqual(["2: const x = 'Octocode';"]);
	});

	it("no core file mentions octocode outside src/adapters", () => {
		expect(coreHits(/octocode/i)).toEqual([]);
	});

	it("no core file names a specific harness (Claude Code, Codex) outside src/adapters", () => {
		expect(coreHits(HARNESS_NAME)).toEqual([]);
	});

	it("only src/index.ts imports from src/adapters", () => {
		expect(coreHits(ADAPTER_IMPORT, (rel) => rel !== "index.ts")).toEqual([]);
	});

	it("the harness-name check flags such a line in a sample and not the model id claude-haiku-5-5", () => {
		expect(offending("x\nconst a = 'Claude Code';\nconst b = 'codex';", HARNESS_NAME)).toEqual([
			"2: const a = 'Claude Code';",
			"3: const b = 'codex';",
		]);
		expect(offending('haiku: { model: "claude-haiku-5-5" },', HARNESS_NAME)).toEqual([]);
	});

	it("the adapter-import check flags a relative import of adapters in a sample and not a sibling import", () => {
		expect(
			offending(
				[
					'import { a } from "./adapters/reference/index.ts";',
					'import { b } from "../adapters/x.ts";',
					'import { c } from "./trace.ts";',
				].join("\n"),
				ADAPTER_IMPORT,
			),
		).toEqual(['1: import { a } from "./adapters/reference/index.ts";', '2: import { b } from "../adapters/x.ts";']);
	});
});
