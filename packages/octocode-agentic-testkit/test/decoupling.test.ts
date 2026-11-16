import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

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

const offending = (text: string): string[] =>
	text.split("\n").flatMap((l, i) => (/octocode/i.test(l) ? [`${i + 1}: ${l.trim()}`] : []));

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
		const hits = coreFiles().flatMap((f) => offending(readFileSync(f, "utf8")).map((h) => `${relative(src, f)}:${h}`));
		expect(hits).toEqual([]);
	});
});
