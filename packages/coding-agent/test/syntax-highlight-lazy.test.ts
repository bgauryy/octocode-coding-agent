import { describe, expect, it, vi } from "vitest";

/** A fresh copy of the highlighter: which languages are registered is module state. */
async function freshHighlighter() {
	vi.resetModules();
	const hljs = (await import("highlight.js/lib/core")).default;
	const module = await import("../src/utils/syntax-highlight.ts");
	return { hljs, ...module };
}

const until = (condition: () => boolean) =>
	vi.waitFor(() => {
		if (!condition()) throw new Error("not yet");
	});

describe("syntax grammars beyond the common set", () => {
	it("load only when shown code names one, and then tell the view to redraw it highlighted", async () => {
		const { hljs, resolveLanguage, highlight, onHighlightLanguagesLoaded } = await freshHighlighter();
		let redraws = 0;
		onHighlightLanguagesLoaded(() => redraws++);
		// Common languages never load the rest.
		expect(resolveLanguage("typescript")).toBe("typescript");
		// Long enough for a load started now to finish (it takes tens of milliseconds).
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(hljs.getLanguage("ada")).toBeUndefined();

		// Code in an uncommon language renders plain first, then the view is told once its grammar is there.
		expect(resolveLanguage("ada")).toBeUndefined();
		await until(() => redraws === 1);
		expect(resolveLanguage("ada")).toBe("ada");
		const code = "procedure Hello is begin null; end Hello;";
		expect(highlight(code, { language: "ada", theme: { keyword: (text) => `[${text}]` } })).toContain("[procedure]");
	});

	it("does not redraw when the names asked for are not languages at all", async () => {
		const { resolveLanguage, loadAllHighlightLanguages, onHighlightLanguagesLoaded } = await freshHighlighter();
		let redraws = 0;
		onHighlightLanguagesLoaded(() => redraws++);
		expect(resolveLanguage("not-a-language")).toBeUndefined();
		await expect(loadAllHighlightLanguages()).resolves.toBe(false);
		expect(redraws).toBe(0);
	});
});
