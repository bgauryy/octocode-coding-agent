import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = join(root, "packages/coding-agent/src/octocode/permission/bash-parser");

const require = createRequire(import.meta.url);
export function stageBashParser(target = join(root, "packages/coding-agent/dist/bash-parser")) {
	const grammar = readFileSync(join(source, "tree-sitter-bash.wasm"));
	if (
		createHash("sha256").update(grammar).digest("hex") !==
		"364f0a2cd385c792239423026ef442dbd073d34c396b7bc9e5932426b8e4aa5d"
	)
		throw new Error("Bash grammar asset hash mismatch");
	const runtimeFile = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
	const runtime = readFileSync(runtimeFile);
	if (
		createHash("sha256").update(runtime).digest("hex") !==
		"488beeff7adb7fd7e21e97cc29a43dc6d031977755eda892d6d96c7f456cfdec"
	)
		throw new Error("Bash parser runtime asset hash mismatch");
	mkdirSync(target, { recursive: true });
	for (const name of ["tree-sitter-bash.wasm", "LICENSE.bash", "LICENSE.tree-sitter", "manifest.json"])
		copyFileSync(join(source, name), join(target, name));
	copyFileSync(require.resolve("web-tree-sitter/web-tree-sitter.wasm"), join(target, "tree-sitter.wasm"));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) stageBashParser();
