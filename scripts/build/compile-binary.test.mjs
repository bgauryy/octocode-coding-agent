import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { test } from "node:test";
import { compileOptions } from "./compile-binary.mjs";

test("the binary compiles the source entry, embeds the image worker at the path the runtime starts it by", () => {
	const options = compileOptions("/out/octocode", "bun-linux-x64-baseline");
	for (const entry of options.entrypoints) assert.ok(existsSync(entry), entry);
	// Bun embeds each entry at its path under `root`; `image-resize.ts` starts "./src/utils/image-resize-worker.ts".
	assert.deepEqual(
		options.entrypoints.map((entry) => relative(options.root, entry).replaceAll("\\", "/")),
		["src/bun/cli.ts", "src/utils/image-resize-worker.ts"],
	);
	assert.deepEqual(options.compile, {
		outfile: "/out/octocode",
		autoloadBunfig: false,
		autoloadDotenv: false,
		target: "bun-linux-x64-baseline",
	});
});
