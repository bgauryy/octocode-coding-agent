import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const MB = 1024 * 1024;

// Bundles the host's Mermaid loader into one file with the output options of the shipped bundle, loads it without asking
// for the script, and measures the heap: the bundled Mermaid text (several megabytes) must not sit there until used.
test("the bundled Mermaid script stays off the heap until the host asks for it", async () => {
	const target = mkdtempSync(join(tmpdir(), "mermaid-lazy-"));
	try {
		const file = join(target, "mermaid.mjs");
		const build = await rolldown({
			cwd: repoRoot,
			input: join(repoRoot, "packages/webview/src/mermaid.ts"),
			platform: "node",
			tsconfig: false,
			transform: { target: "node24" },
		});
		try {
			await build.write({
				format: "esm",
				file,
				codeSplitting: false,
				charset: "ascii",
				comments: { legal: false },
				minify: { compress: true, mangle: false, codegen: { removeWhitespace: true } },
			});
		} finally {
			await build.close();
		}
		const probe = `
const used = () => { globalThis.gc(); return process.memoryUsage().heapUsed; };
const before = used();
const { mermaidScript } = await import(${JSON.stringify(new URL(`file://${file}`).href)});
const loaded = used();
const script = await mermaidScript();
console.log(JSON.stringify({ idle: loaded - before, used: used() - before, length: script.length, head: script.slice(0, 40) }));
`;
		const result = JSON.parse(
			execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", probe], { encoding: "utf8" }),
		);
		assert.ok(result.length > 2 * MB, `Mermaid script is ${result.length} chars`);
		assert.match(result.head, /^\/\* Bundled dependency license\nmermaid\n/);
		assert.ok(result.used > result.length / 2, "the probe measures the script once it is used");
		assert.ok(result.idle < MB, `loading the bundle grew the heap by ${(result.idle / MB).toFixed(1)} MB`);
	} finally {
		rmSync(target, { recursive: true, force: true });
	}
});
