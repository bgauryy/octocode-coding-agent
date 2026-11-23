import { describe, expect, it } from "vitest";
import { describeHtml, staticHtmlNote } from "../../src/octocode/web/html.ts";

/**
 * The empty-mount check reads the page once (S11): the pattern `<div\b[^>]*\bid=…[^>]*>\s*</div>` backtracked over every
 * `id=` of an unclosed tag, and a 512 KiB page of them held the event loop for 16.7 s.
 */
describe("the empty app mount point check", () => {
	const note = (html: string) => staticHtmlNote(html, "") ?? "";

	it("finds a mount point left empty, as the pattern did", () => {
		for (const html of [
			'<div id="root"></div>',
			"<div id=app>\n  </div>",
			"<DIV class='x' ID='__next' data-a=1></DIV>",
			'<p>a</p><div id="other"></div><div id="svelte"></div>',
			'<div<div id="root"></div>',
			"<div id=rootless></div>",
		])
			expect(note(html), html).toMatch(/empty app mount point/);
	});

	it("passes a filled mount point, another id, or an unclosed one", () => {
		for (const html of [
			'<div id="root"><p>x</p></div>',
			'<div id="main"></div>',
			'<div id="root">',
			"<span id=root></span>",
		])
			expect(note(html), html).not.toMatch(/empty app mount point/);
	});

	it("reads a 512 KiB page of one unclosed tag full of ids in linear time", () => {
		const html = `<html><body><div${" id=root".repeat((512 * 1024) / 8)}></body></html>`;
		const started = performance.now();
		const page = describeHtml(html, "http://x.test/");
		expect(page).toContain("static HTML");
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it("reads a page of nested unclosed div openers in linear time", () => {
		const html = `${"<div".repeat(100_000)} id=root>${" ".repeat(100_000)}x`;
		const started = performance.now();
		expect(note(html)).not.toMatch(/empty app mount point/);
		expect(performance.now() - started).toBeLessThan(1000);
	});
});
