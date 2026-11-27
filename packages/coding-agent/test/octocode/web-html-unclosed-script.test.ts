import { describe, expect, it } from "vitest";
import { htmlToText } from "../../src/octocode/web/html.ts";

/**
 * `<script>` and `<style>` hold raw text: a browser reads everything up to their end tag (which may carry whitespace before
 * `>`), or to the end of the document when there is none. Their code must never reach the extracted page text.
 */
describe("htmlToText and raw-text elements", () => {
	it("drops an unclosed script to the end of the document", () => {
		const text = htmlToText(`<p>Hello</p><script>var token = "abc"; document.write("<p>injected</p>")`);
		expect(text).toBe("Hello");
	});

	it("drops an unclosed style to the end of the document", () => {
		const text = htmlToText("<p>Hello</p><style>body { color: red } <p>never shown</p>");
		expect(text).toBe("Hello");
	});

	it("ends a script at an end tag with whitespace before `>`, keeping what follows", () => {
		const text = htmlToText("<p>A</p><script>var x = 1;</script ><p>B</p><script>y()</script\n>");
		expect(text).toBe("A\n\nB");
	});

	it("keeps a custom element whose name only starts like a raw-text one", () => {
		expect(htmlToText("<style-guide>Kept</style-guide><p>After</p>")).toContain("Kept");
	});
});
