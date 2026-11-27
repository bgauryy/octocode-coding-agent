import { describe, expect, it } from "vitest";
import { ansiLinesToHtml } from "../src/ansi-to-html.ts";

describe("ansiLinesToHtml", () => {
	it("drops row marks, links and other non-SGR sequences instead of printing their payload", () => {
		const html = ansiLinesToHtml([
			"\x1b_octo:ws\x1b\\\x1b[31mred\x1b[0m",
			"\x1b_octo:wj\x1b\\cut \x1b]8;;https://example.invalid/\x07link\x1b]8;;\x07 <b>",
		]);
		expect(html).toBe(
			'<div class="ansi-line"><span style="color:#800000">red</span></div>' +
				'<div class="ansi-line">cut link &lt;b&gt;</div>',
		);
		expect(html).not.toContain("octo:");
		expect(html).not.toContain("\x1b");
	});
});
