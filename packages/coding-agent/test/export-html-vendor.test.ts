import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { expect, it } from "vitest";
import { getExportTemplateDir } from "../src/config.ts";
import { renderVendorFiles } from "../scripts/generate-vendor.ts";

const vendorDir = join(getExportTemplateDir(), "vendor");

it("keeps the vendored export scripts equal to what the installed dependencies generate", async () => {
	for (const file of await renderVendorFiles()) {
		expect(
			readFileSync(join(vendorDir, file.name), "utf8"),
			`vendor/${file.name} is stale: run \`yarn workspace @octocodeai/octocodecode run generate:vendor\``,
		).toBe(file.content);
	}
});

// The export inlines both files as classic scripts and the template calls `marked.parse` and `hljs.highlight`.
it("loads the vendored scripts as browser globals the export template uses", () => {
	const page = vm.createContext({});
	vm.runInContext(readFileSync(join(vendorDir, "marked.min.js"), "utf8"), page);
	vm.runInContext(readFileSync(join(vendorDir, "highlight.min.js"), "utf8"), page);
	const run = (code: string): unknown => vm.runInContext(code, page);
	expect(run('marked.parse("**bold**")')).toBe("<p><strong>bold</strong></p>\n");
	expect(run('hljs.getLanguage("typescript") !== undefined')).toBe(true);
	expect(run('hljs.highlight("const a = 1", { language: "typescript" }).value')).toContain(
		'<span class="hljs-keyword">const</span>',
	);
	expect(run('typeof hljs.highlightAuto("def f(): pass").value')).toBe("string");
});
