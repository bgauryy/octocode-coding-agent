import { Text } from "@octocodeai/octocode-tui";
import { describe, expect, test } from "vitest";
import type { MessageRenderer, MessageRenderOptions } from "../src/core/features/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { getMarkdownTheme, initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("CustomMessageComponent", () => {
	test("provides output padding to custom renderers and updates it", () => {
		initTheme("dark");
		const optionsSeen: MessageRenderOptions[] = [];
		const renderer: MessageRenderer = (_message, options) => {
			optionsSeen.push(options);
			return new Text("custom", options.outputPad, 0);
		};
		const message: CustomMessage = {
			role: "custom",
			customType: "test",
			content: "custom",
			display: true,
			timestamp: Date.now(),
		};
		const component = new CustomMessageComponent(message, renderer, undefined, 1);

		expect(optionsSeen).toEqual([{ expanded: false, outputPad: 1 }]);
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith(" custom")),
		).toBe(true);

		component.setOutputPad(0);

		expect(optionsSeen.at(-1)).toEqual({ expanded: false, outputPad: 0 });
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith("custom")),
		).toBe(true);
	});

	test("draws a one-line message without a renderer as one row, a longer one with its body right under the label", () => {
		initTheme("dark");
		const message = (content: string): CustomMessage => ({
			role: "custom",
			customType: "wake",
			content,
			display: true,
			timestamp: Date.now(),
		});
		const rows = (content: string) =>
			new CustomMessageComponent(message(content), undefined, undefined, 1)
				.render(80)
				.map((line) => stripAnsi(line).trimEnd())
				.filter(Boolean);
		expect(rows("Timer fired: check the build log.")).toEqual([" [wake] Timer fired: check the build log."]);
		expect(rows("first line\nsecond line")).toEqual([" [wake]", " first line", " second line"]);
	});

	test("keeps inline markdown in a one-line body on the label row", () => {
		initTheme("dark");
		const message: CustomMessage = {
			role: "custom",
			customType: "wake",
			content: "Run `yarn check` and **retry**.",
			display: true,
			timestamp: Date.now(),
		};
		const lines = new CustomMessageComponent(message, undefined, undefined, 1).render(80);
		const rows = lines.map((line) => stripAnsi(line).trimEnd()).filter(Boolean);
		expect(rows).toEqual([" [wake] Run yarn check and retry."]);
		const row = lines.find((line) => stripAnsi(line).includes("[wake]"))!;
		expect(row).toContain(getMarkdownTheme().code("yarn check"));
		// Bold wraps the word already in the message color: the bold opener, then color codes, then the word.
		expect(row).toMatch(/\x1b\[1m(?:\x1b\[[0-9;]*m)*retry/);
	});
});
