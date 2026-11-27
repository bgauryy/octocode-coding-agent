import { describe, expect, it } from "vitest";
import { renderTemplate } from "../../src/core/prompt-template.ts";

describe("instruction template", () => {
	it("substitutes {{name}} without rescanning the value", () => {
		expect(renderTemplate("Hi {{ who }}, {{n}}.", { who: "{{n}}", n: 3 })).toBe("Hi {{n}}, 3.");
	});

	it("fails on an unknown variable instead of printing nothing", () => {
		expect(() => renderTemplate("{{missing}}", {})).toThrow(/missing/);
		expect(() => renderTemplate("{{#if missing}}x{{/if}}", {})).toThrow(/missing/);
	});

	it("renders inline conditionals with else and unless", () => {
		const text = "a{{#if x}} yes{{else}} no{{/if}}.{{#unless x}} u{{/unless}}";
		expect(renderTemplate(text, { x: true })).toBe("a yes.");
		expect(renderTemplate(text, { x: false })).toBe("a no. u");
	});

	it("treats empty strings, 0 and undefined as false", () => {
		for (const value of ["", 0, undefined, false])
			expect(renderTemplate("{{#if v}}T{{else}}F{{/if}}", { v: value })).toBe("F");
		expect(renderTemplate("{{#if v}}T{{else}}F{{/if}}", { v: "x" })).toBe("T");
	});

	it("leaves no blank line for a block directive on its own line", () => {
		const text = ["one", "{{#if x}}", "two", "{{else}}", "three", "{{/if}}", "four"].join("\n");
		expect(renderTemplate(text, { x: true })).toBe("one\ntwo\nfour");
		expect(renderTemplate(text, { x: false })).toBe("one\nthree\nfour");
		expect(renderTemplate("one\n  {{#unless x}}\ntwo\n  {{/unless}}\nfour", { x: true })).toBe("one\nfour");
	});

	it("keeps a blank line the author wrote", () => {
		expect(renderTemplate("a\n\n{{#if x}}\nb\n{{/if}}\nc", { x: false })).toBe("a\n\nc");
	});

	it("nests blocks", () => {
		const text = "{{#if a}}A{{#if b}}B{{else}}b{{/if}}{{else}}-{{/if}}";
		expect(renderTemplate(text, { a: true, b: true })).toBe("AB");
		expect(renderTemplate(text, { a: true, b: false })).toBe("Ab");
		expect(renderTemplate(text, { a: false, b: true })).toBe("-");
	});

	it("strips HTML comments: whole-line comments vanish with their line, inline ones leave the text", () => {
		const text =
			"one\n<!-- User request (2026-10-30): why\n  spans lines -->\ntwo <!-- inline --> three\n  <!-- x -->  \nfour";
		expect(renderTemplate(text, {})).toBe("one\ntwo  three\nfour");
	});

	it("does not read directives inside comments", () => {
		expect(renderTemplate("a<!-- {{#if x}} -->b", {})).toBe("ab");
	});

	it("removes the newline that ends the file's last line, not a value's own", () => {
		expect(renderTemplate("a\nb\n", {})).toBe("a\nb");
		expect(renderTemplate("a\n{{v}}\n", { v: "x\n" })).toBe("a\nx\n");
		expect(renderTemplate("a\n{{#if x}}\nb\n{{/if}}\n", { x: true })).toBe("a\nb");
		expect(renderTemplate("a\n{{#if x}}\nb\n{{/if}}\n", { x: false })).toBe("a");
	});

	it("rejects unbalanced blocks", () => {
		expect(() => renderTemplate("{{#if x}}a", { x: true })).toThrow(/unclosed/i);
		expect(() => renderTemplate("a{{/if}}", {})).toThrow(/unexpected/i);
		expect(() => renderTemplate("{{#if x}}a{{/unless}}", { x: true })).toThrow(/unexpected/i);
		expect(() => renderTemplate("{{else}}", {})).toThrow(/unexpected/i);
	});
});
