import type { AssistantMessage } from "@octocodeai/octocode-ai";
import { resetCapabilitiesCache, setCapabilities, type TUI } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { ContentAttachmentComponent } from "../src/modes/interactive/components/application-content.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const untrusted = "before\x1b[2J\x1b[1;1Hafter\x1b]52;c;dGVzdA==\x07\x1bPpayload\x1b\\";
const ui = { requestRender() {} } as TUI;

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("terminal content boundary", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => resetCapabilitiesCache());

	it("removes terminal commands from assistant and user Markdown while retaining text", () => {
		for (const component of [
			new AssistantMessageComponent(assistant(untrusted)),
			new UserMessageComponent(untrusted),
		]) {
			const lines = component.render(80).join("\n");
			expect(stripAnsi(lines)).toContain("beforeafter");
			for (const command of ["\x1b[2J", "\x1b[1;1H", "\x1b]52;", "\x1bP"]) expect(lines).not.toContain(command);
		}
	});

	it("sanitizes transformer output and assistant failure text", () => {
		const transformed = new UserMessageComponent("safe", undefined, 1, [() => untrusted]).render(80).join("\n");
		expect(transformed).not.toContain("\x1b]52;");
		const failed = new AssistantMessageComponent({ ...assistant(""), stopReason: "error", errorMessage: untrusted });
		expect(failed.render(80).join("\n")).not.toContain("\x1b[2J");
	});

	it("sanitizes image metadata when Kitty falls back after failed conversion", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		for (const metadata of [{ mimeType: "image/jpeg", name: untrusted }, { mimeType: `image/png${untrusted}` }]) {
			const asset = { id: "invalid-image", size: 9, ...metadata };
			const component = new ContentAttachmentComponent(
				{ id: "image", type: "image", asset },
				{
					readAsset: () => ({ asset, encoding: "base64", data: "bm90IGFuIGltYWdl" }),
				},
			);
			const rendered = component.render(200).join("\n");
			expect(stripAnsi(rendered)).toContain("[Image");
			for (const command of ["\x1b[2J", "\x1b[1;1H", "\x1b]52;", "\x1bP"]) expect(rendered).not.toContain(command);
		}
	});

	it("collapses unknown tool output while retaining full output on expansion", () => {
		const component = new ToolExecutionComponent("uninstalled", "tool", {}, {}, undefined, ui, "/tmp");
		component.updateResult({
			content: [{ type: "text", text: Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n") }],
			isError: false,
		});
		const preview = stripAnsi(component.render(80).join("\n"));
		// A finished result closes to its fold hint.
		expect(preview).toContain("… +5000 lines");
		expect(preview).not.toContain("line 0");
		expect(preview).not.toContain("line 4999");
		expect(component.render(80).length).toBeLessThan(30);
		component.setExpanded(true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("line 4999");
	});

	it("contains exceptions thrown during a plugin component render and shows the result", () => {
		const component = new ToolExecutionComponent(
			"plugin",
			"tool",
			{},
			{},
			{
				renderCall: () => ({
					render() {
						throw new Error("broken plugin");
					},
					invalidate() {},
				}),
			},
			ui,
			"/tmp",
		);
		component.updateResult({ content: [{ type: "text", text: "important result" }], isError: false });
		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("renderer failed");
		expect(rendered).toContain("important result");
	});

	it("shows an explicit failure when a standalone legacy component exceeds asset capacity", () => {
		const component = new AssistantMessageComponent(assistant("x".repeat(33 * 1024 * 1024)));
		expect(stripAnsi(component.render(80).join("\n"))).toContain("Content unavailable");
	});

	it.each(["kitty", "iterm2", null] as const)(
		"keeps generic tool text in order and draws its image with %s graphics",
		(images) => {
			setCapabilities({ images, trueColor: true, hyperlinks: true });
			for (const renderer of [undefined, {}]) {
				const component = new ToolExecutionComponent("image_tool", "image-tool", {}, {}, renderer, ui, "/tmp");
				component.updateResult({
					content: [
						{ type: "text", text: "BEFORE IMAGE" },
						{
							type: "image",
							mimeType: "image/png",
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPuoAAAAASUVORK5CYII=",
						},
						{ type: "text", text: "AFTER IMAGE" },
					],
					isError: false,
				});
				component.setExpanded(true);
				const rendered = component.render(80).join("\n");
				const imageMarker = images === "kitty" ? "\x1b_G" : images === "iterm2" ? "\x1b]1337;File=" : "[image]";
				expect(rendered.indexOf("BEFORE IMAGE")).toBeGreaterThan(-1);
				expect(rendered.indexOf("AFTER IMAGE")).toBeGreaterThan(rendered.indexOf("BEFORE IMAGE"));
				// A drawn image follows the text rows; a placeholder keeps its place in the text.
				if (images === null) expect(rendered.indexOf(imageMarker)).toBeGreaterThan(rendered.indexOf("BEFORE IMAGE"));
				else expect(rendered.indexOf(imageMarker)).toBeGreaterThan(rendered.indexOf("AFTER IMAGE"));
			}
		},
	);

	it("applies one collapsed text budget across generic result blocks", () => {
		const component = new ToolExecutionComponent("many_blocks", "blocks", {}, {}, undefined, ui, "/tmp");
		component.updateResult({
			content: Array.from({ length: 15 }, (_, index) => ({ type: "text", text: `BLOCK ${index}` })),
			isError: false,
		});
		const preview = stripAnsi(component.render(80).join("\n"));
		expect(preview).not.toContain("BLOCK 0");
		expect(preview).toContain("… +15 lines");
		component.setExpanded(true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("BLOCK 14");
	});
});
