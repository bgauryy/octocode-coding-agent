import { describe, expect, it } from "vitest";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { resultBlock } from "../../src/octocode/shared/render.ts";

describe("result state colors", () => {
	it("applies a semantic summary color after sanitizing text", () => {
		initTheme("octocode-dark", false);
		const rendered = resultBlock(theme, {}, { summary: "Waiting\x1b[31m for approval", summaryColor: "warning" })
			.render(80)
			.join("\n");
		expect(rendered).toContain(theme.fg("warning", "Waiting for approval"));
		expect(rendered).not.toContain("\x1b[31m");
	});

	it("preserves error priority over a requested summary color", () => {
		initTheme("octocode-dark", false);
		const rendered = resultBlock(theme, { isError: true }, { summary: "Failed to connect", summaryColor: "accent" })
			.render(80)
			.join("\n");
		expect(rendered).toContain(theme.fg("error", "Failed to connect"));
	});
});
