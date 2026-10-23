import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Parser, Language } from "web-tree-sitter";
import { stageBashParser } from "./stage-bash-parser.mjs";
test("staged parser assets independently parse Bash and retain source licenses", async () => {
	const target = mkdtempSync(join(tmpdir(), "bash-parser-assets-"));
	let parser, tree;
	try {
		stageBashParser(target);
		await Parser.init({
			wasmBinary: readFileSync(join(target, "tree-sitter.wasm")),
		});
		parser = new Parser();
		parser.setLanguage(await Language.load(readFileSync(join(target, "tree-sitter-bash.wasm"))));
		tree = parser.parse('printf "$(printf nested)"');
		assert.equal(tree.rootNode.hasError, false);
		assert.match(tree.rootNode.toString(), /command_substitution/);
		for (const name of ["LICENSE.bash", "LICENSE.tree-sitter"])
			assert.match(readFileSync(join(target, name), "utf8"), /Permission is hereby granted/);
		assert.equal(JSON.parse(readFileSync(join(target, "manifest.json"), "utf8")).runtime.version, "0.25.10");
	} finally {
		tree?.delete();
		parser?.delete();
		rmSync(target, { recursive: true, force: true });
	}
});
