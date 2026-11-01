import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { renderLatex } from "../src/latex.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

function renderMarkdown(text: string): string {
	return new Markdown(text, 0, 0, defaultMarkdownTheme).render(80).join("\n");
}

describe("LaTeX from untrusted model output", () => {
	it("treats command names that are Object.prototype keys as unknown commands", () => {
		for (const source of [String.raw`x+\constructor`, String.raw`\toString{ab}`, String.raw`\valueOf`]) {
			assert.strictEqual(renderLatex(source), undefined, source);
		}
		// `\not` over a word it has no symbol for strikes the first letter, as for any other word.
		assert.strictEqual(renderLatex(String.raw`\not{constructor}`), "c\u0338onstructor");
		assert.doesNotThrow(() => renderLatex(String.raw`\not\constructor`));
		assert.strictEqual(renderLatex(String.raw`\not\constructor`), undefined);
	});

	it("keeps rendering a message whose math names a prototype key", () => {
		const output = renderMarkdown(String.raw`value $\not\constructor$ end`);
		assert.match(output, /value \$\\not\\constructor\$ end/);
		assert.doesNotMatch(output, /native code/);
	});

	it("does not interpret layout marker characters that arrive in the source", () => {
		const selfReference = "\\frac{\u{f0000}0\u{f0001}}{1}";
		assert.doesNotThrow(() => renderLatex(selfReference, { display: true }));
		assert.strictEqual(renderLatex(selfReference, { display: true }), undefined);
		assert.strictEqual(renderLatex("x\u{f0000}0\u{f0001}+\\frac{a}{b}", { display: true }), undefined);
	});

	it("falls back instead of throwing when nesting exceeds the stack", () => {
		const deep = `${"{".repeat(20000)}x${"}".repeat(20000)}`;
		assert.strictEqual(renderLatex(deep), undefined);
		const output = renderMarkdown(`math $${deep}$ done`);
		assert.match(output.replace(/\s+/g, ""), /^math\$\{+x\}+\$done$/);
	});

	it("renders long spacing runs inside scripts in linear time", () => {
		const started = performance.now();
		assert.strictEqual(renderLatex(`x^{a${"~".repeat(40000)}b}`), "x^(a b)");
		assert.strictEqual(renderLatex(`x_{a${"\\,".repeat(40000)}= b}`), "x_(a=b)");
		assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`);
	});

	it("still removes spaces around script operators", () => {
		assert.strictEqual(renderLatex("x_{i = 0}"), "xᵢ₌₀");
		assert.strictEqual(renderLatex("x^{n - 1}"), "xⁿ⁻¹");
		assert.strictEqual(renderLatex("x^{a~~b}"), "x^(a b)");
	});
});
