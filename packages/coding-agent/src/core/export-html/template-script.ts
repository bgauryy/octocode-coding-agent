import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The browser script of the HTML export is a set of fragments in `script/`, read in this order and inlined as one
 * script. The fragments share one scope and are not modules: each declares its functions and state at the top level and
 * uses those declared by the others, so the order is also the initialisation order. The package build
 * (`scripts/build/build-coding-agent.mjs`) copies the folder to `dist`, and the compiled binary stages it with the rest of `export-html/`.
 */
export const TEMPLATE_SCRIPT_FRAGMENTS = [
	"data.js",
	"tree-data.js",
	"filter.js",
	"tree-view.js",
	"message-tools.js",
	"message-entry.js",
	"header.js",
	"navigation.js",
	"markdown.js",
	"sidebar.js",
	"controls.js",
] as const;

/** The script the page inlines: the fragments in one strict-mode function, so nothing leaks into the page's globals. */
export function readTemplateScript(templateDir: string): string {
	const fragments = TEMPLATE_SCRIPT_FRAGMENTS.map((name) => readFileSync(join(templateDir, "script", name), "utf-8"));
	return `(function () {\n"use strict";\n\n${fragments.join("\n")}})();\n`;
}
