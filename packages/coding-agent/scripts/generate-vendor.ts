#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const vendorDirectory = resolve(packageDirectory, "src/core/export-html/vendor");
const require = createRequire(import.meta.url);

/**
 * `marked` is a declared dependency; `highlight.js-browser` is the same package pinned to the 11.x line the
 * browser export needs (the terminal highlighter uses `highlight.js` 10.x).
 */
const HIGHLIGHT_PACKAGE = "highlight.js-browser";

export interface VendorFile {
	/** File name inside `src/core/export-html/vendor/`. */
	name: string;
	content: string;
}

function packageRoot(name: string): string {
	return dirname(require.resolve(`${name}/package.json`));
}

/** The UMD build `marked` ships, which sets `globalThis.marked` when loaded as a plain script. */
function renderMarked(): VendorFile {
	return { name: "marked.min.js", content: readFileSync(resolve(packageRoot("marked"), "lib/marked.umd.js"), "utf8") };
}

/** highlight.js's common-language build as one classic script that defines the global `hljs`. */
async function renderHighlight(): Promise<VendorFile> {
	const root = packageRoot(HIGHLIGHT_PACKAGE);
	const version = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }).version;
	const entry = "\0highlight-entry";
	const bundle = await rolldown({
		input: entry,
		platform: "browser",
		plugins: [
			{
				name: "highlight-entry",
				resolveId: (source) => (source === entry ? entry : undefined),
				load: (id) =>
					id === entry ? `import hljs from "${HIGHLIGHT_PACKAGE}/lib/common";\nexport default hljs;` : undefined,
			},
		],
		logLevel: "warn",
	});
	try {
		const { output } = await bundle.generate({
			format: "iife",
			name: "hljs",
			exports: "default",
			minify: true,
			comments: { legal: false },
		});
		const banner = `/*! Highlight.js v${version} (BSD-3-Clause) https://highlightjs.org */\n`;
		// The script is inlined into HTML, so a literal closing tag in the code must not end the element.
		return { name: "highlight.min.js", content: banner + output[0].code.replace(/<\/script/gi, "<\\/script") };
	} finally {
		await bundle.close();
	}
}

/** The vendored browser scripts the HTML export inlines, built from the installed dependencies. */
export async function renderVendorFiles(): Promise<VendorFile[]> {
	return [renderMarked(), await renderHighlight()];
}

async function generateVendor(): Promise<void> {
	for (const file of await renderVendorFiles()) {
		writeFileSync(resolve(vendorDirectory, file.name), file.content, "utf-8");
		console.log(`Generated packages/coding-agent/src/core/export-html/vendor/${file.name}`);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await generateVendor();
}
