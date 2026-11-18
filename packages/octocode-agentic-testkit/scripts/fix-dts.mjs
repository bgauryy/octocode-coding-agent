#!/usr/bin/env node
// After `tsc`: the emitted `.d.ts` files keep the sources' relative `.ts` specifiers (`from "./trace.ts"`), which only
// TypeScript 7 resolves to the declaration files. Rewriting them to `.js` makes `dist` load in every TypeScript from 4.7
// on (NodeNext and Bundler both map `.js` to the `.d.ts` beside it). Prints one summary line.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));
// `from "./x.ts"`, `import("./x.ts")` and `import "./x.ts"`, relative specifiers only.
const SPECIFIER = /((?:from|import)\s*\(?\s*)(["'])(\.{1,2}\/[^"']+?)\.ts\2/g;

let files = 0;
let rewritten = 0;
for (const entry of readdirSync(DIST, { recursive: true, withFileTypes: true })) {
	if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;
	const path = join(entry.parentPath, entry.name);
	const text = readFileSync(path, "utf8");
	let n = 0;
	const out = text.replace(SPECIFIER, (_, head, quote, spec) => {
		n++;
		return `${head}${quote}${spec}.js${quote}`;
	});
	files++;
	if (n === 0) continue;
	rewritten += n;
	writeFileSync(path, out);
}
if (files === 0) throw new Error(`fix-dts: no .d.ts files under ${DIST}; run tsc first`);
process.stdout.write(`fix-dts: ${rewritten} specifiers rewritten to .js in ${files} declaration files\n`);
