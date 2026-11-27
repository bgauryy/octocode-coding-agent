import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getExportTemplateDir } from "../src/config.ts";
import { readTemplateScript } from "../src/core/export-html/template-script.ts";
import { getResolvedThemeColors } from "../src/theme/theme.ts";

const read = (name: string) => readFileSync(new URL(`../src/core/export-html/${name}`, import.meta.url), "utf-8");

describe("export HTML tool reason row", () => {
	it("defines --toolReason in every bundled theme's variable mapping, and falls back to muted in the stylesheet", () => {
		for (const name of ["dark", "light", "octocode-dark", "octocode-light"]) {
			expect(getResolvedThemeColors(name).toolReason, name).toMatch(/^#[0-9a-f]{6}$/i);
		}
		expect(read("template.css")).toMatch(/\.tool-reason \{\s*color: var\(--toolReason, var\(--muted\)\);/);
	});

	it("shows a bash call's reason from two words on, as the terminal does", () => {
		const js = readTemplateScript(getExportTemplateDir());
		expect(js).toMatch(/reason\.trim\(\)\.split\(\/\\s\+\/\)\.length >= 2/);
		expect(js).toContain('<div class="tool-reason">↳ ${escapeHtml(reason.trim())}</div>');
	});
});
