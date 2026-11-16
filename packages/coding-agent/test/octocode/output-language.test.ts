import { beforeAll, describe, expect, it } from "vitest";
import { createResultFallback } from "../../src/modes/interactive/components/tool-execution/fallback.ts";
import { resultBlock } from "../../src/octocode/render/tool.ts";
import { colorToolOutput, outputLanguage } from "../../src/theme/output-style.ts";
import { initTheme, theme } from "../../src/theme/theme.ts";

const YAML = "name: octocode\nversion: 1\ntags:\n  - a";
const stripped = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const colored = (text: string) => text !== stripped(text);
const options = { expanded: true, previewLines: 5 };

describe("output language of a result without a file", () => {
	beforeAll(() => initTheme("octocode-dark", false));

	it("detects key lines and JSON, and leaves prose flat", () => {
		expect(outputLanguage(YAML)).toBe("yaml");
		expect(outputLanguage('{"a": [1, 2]}')).toBe("json");
		expect(outputLanguage("Note: this is prose.\nIt has one colon only.\nMore text here.")).toBeUndefined();
		expect(outputLanguage("{ not json\nsecond line")).toBeUndefined();
	});

	it("colors key lines through colorToolOutput without a path", () => {
		const out = colorToolOutput(theme, YAML, options);
		expect(out).toBeDefined();
		expect(stripped(out!)).toBe(YAML);
		expect(colorToolOutput(theme, "Note: one colon\nplain words", options)).toBeUndefined();
	});

	it("colors a resultBlock body that names its language, and keeps prose and errors flat", () => {
		const plain = resultBlock(theme, {}, { summary: "", body: YAML, expanded: true }).render(80).join("\n");
		const light = resultBlock(theme, {}, { summary: "", body: YAML, expanded: true, language: "yaml" })
			.render(80)
			.join("\n");
		expect(stripped(light)).toBe(stripped(plain));
		expect(light).not.toBe(plain);
		const failed = resultBlock(theme, { isError: true }, { summary: "", body: YAML, expanded: true, language: "yaml" })
			.render(80)
			.join("\n");
		expect(failed).toBe(
			resultBlock(theme, { isError: true }, { summary: "", body: YAML, expanded: true }).render(80).join("\n"),
		);
	});

	it("colors the plain fallback of a tool with no renderer", () => {
		const out = createResultFallback(YAML, true)!.render(80).join("\n");
		expect(colored(out)).toBe(true);
		const prose = createResultFallback("Note: one colon\nplain words", true)!.render(80).join("\n");
		expect(prose).toContain(theme.fg("toolOutput", "Note: one colon"));
	});
});
