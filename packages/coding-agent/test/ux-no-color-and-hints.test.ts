import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { generateDiffString } from "../src/core/tools/edit-diff.ts";
import { renderDiff } from "../src/theme/diff.ts";
import { hintLine, hintText } from "../src/modes/interactive/components/keybinding-hints.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { renderHorizontalViewport } from "../src/modes/interactive/components/tree-selector/viewport.ts";
import { noticeLine } from "../src/modes/interactive/interactive-mode/display.ts";
import { initTheme, theme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/** Any SGR that sets or resets a color: 30-37, 38, 39, 40-47, 48, 49, 90-97, 100-107. */
const COLOR_SGR = /\x1b\[(?:[34][0-9]|9[0-7]|10[0-7])[;m]/;

const fakeTui = { requestRender: () => {} } as never;

function withEnv(overrides: Record<string, string | undefined>): () => void {
	const saved = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]));
	for (const [name, value] of Object.entries(overrides)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	return () => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

function renderSelector(): string[] {
	const selector = new OAuthSelectorComponent(
		"sign-in",
		[{ id: "anthropic", name: "Anthropic", authType: "api_key" }],
		() => {},
		() => {},
	);
	return selector.render(80);
}

describe.each([
	["NO_COLOR", { NO_COLOR: "1", TERM: "xterm-256color" }],
	["TERM=dumb", { NO_COLOR: undefined, TERM: "dumb" }],
])("%s", (_name, env) => {
	let restore: () => void;
	beforeAll(() => {
		restore = withEnv(env);
		initTheme("dark");
	});
	afterAll(() => restore());

	test("the theme writes no color sequence and keeps text attributes", () => {
		expect(theme.getColorMode()).toBe("none");
		expect(theme.fg("accent", "x")).toBe("x");
		expect(theme.bg("selectedBg", "x")).toBe("x");
		expect(theme.getFgAnsi("accent")).toBe("");
		expect(theme.getBgAnsi("selectedBg")).toBe("");
		expect(theme.bold("x")).toBe("\x1b[1mx\x1b[22m");
		expect(theme.underline("x")).toBe("\x1b[4mx\x1b[24m");
		expect(theme.inverse("x")).toBe("\x1b[7mx\x1b[27m");
	});

	test("notices keep their glyph and words without color", () => {
		for (const kind of ["success", "warning", "error"] as const) {
			const rendered = noticeLine(kind, "Something happened", 1).render(80).join("\n");
			expect(rendered).not.toMatch(COLOR_SGR);
			expect(stripAnsi(rendered)).toContain("Something happened");
		}
	});

	test("a tool row renders without color", () => {
		const component = new ToolExecutionComponent("tool", "id", { path: "a.ts" }, {}, undefined, fakeTui, process.cwd());
		component.updateResult({ content: [{ type: "text", text: "all good" }], isError: false });
		const rendered = component.render(80).join("\n");
		expect(stripAnsi(rendered)).toContain("all good");
		expect(rendered).not.toMatch(COLOR_SGR);
	});

	test("a diff is marked by its signs, with no tint", () => {
		const { diff } = generateDiffString("let a = 1;\n", "let b = 1;\n");
		const rendered = renderDiff(diff, { filePath: "a.js" });
		expect(stripAnsi(rendered)).toContain("+1 let b = 1;");
		expect(rendered).not.toMatch(COLOR_SGR);
	});

	test("a selector renders without color", () => {
		expect(renderSelector().join("\n")).not.toMatch(COLOR_SGR);
	});
});

describe("with color available", () => {
	let restore: () => void;
	beforeAll(() => {
		restore = withEnv({ NO_COLOR: undefined, TERM: "xterm-256color" });
		initTheme("dark");
	});
	afterAll(() => restore());

	test("an empty NO_COLOR does not turn color off", () => {
		const undo = withEnv({ NO_COLOR: "" });
		try {
			initTheme("dark");
			expect(theme.fg("accent", "x")).toMatch(COLOR_SGR);
		} finally {
			undo();
		}
	});
});

describe("key hint lines", () => {
	beforeAll(() => initTheme("dark"));

	test("hintText and hintLine share one `key verb \u00b7 key verb` format", () => {
		const pairs = [
			["enter", "select"],
			["esc", "cancel"],
		] as const;
		expect(hintText(pairs)).toBe("enter select \u00b7 esc cancel");
		expect(stripAnsi(hintLine(pairs))).toBe("enter select \u00b7 esc cancel");
	});

	test("the /providers provider picker ends with the key hints the other selectors show", () => {
		const text = renderSelector().map(stripAnsi).join("\n");
		expect(text).toMatch(/enter select \u00b7 \S+ cancel/);
		expect(text).not.toContain("\u2191\u2193");
		// The selected row uses the shared cursor glyph.
		expect(text).toContain("\u203a Anthropic");
		expect(text).not.toContain("\u2192");
	});
});

describe("tree selector horizontal viewport", () => {
	test("closes only the styles a clipped body leaves open, never a full reset", () => {
		const body = `\x1b[44m\x1b[1m${"x".repeat(40)}\x1b[22m\x1b[49m`;
		const [line] = renderHorizontalViewport(
			[{ gutter: "> ", body, anchorCol: 30, bodyWidth: 40, isSelected: true }],
			20,
		);
		expect(stripAnsi(line)).toBe(`> ${"x".repeat(18)}`);
		expect(line).not.toContain("\x1b[0m");
		expect(line.endsWith("\x1b[22;49m")).toBe(true);
	});
});
