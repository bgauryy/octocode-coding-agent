import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleLinksCommand, handleSemanticCopy } from "../src/modes/interactive/reference-actions.ts";
import type * as ReferenceOpener from "../src/modes/interactive/reference-opener.ts";
import { setItemLinkHandler } from "../src/octocode/shared/item-ref.ts";
import { SearchableSelectorComponent } from "../src/modes/interactive/components/searchable-selector.ts";
import { initTheme } from "../src/theme/theme.ts";

const { clipboard, opener, selector } = vi.hoisted(() => ({
	clipboard: vi.fn(),
	opener: vi.fn(),
	selector: vi.fn<(title: string, choices: string[]) => Promise<string | undefined>>(),
}));
vi.mock("../src/modes/interactive/reference-picker.ts", () => ({
	chooseReference: (_host: unknown, title: string, choices: string[]) => selector(title, choices),
}));
vi.mock("../src/utils/clipboard.ts", () => ({ copyToClipboard: clipboard }));
vi.mock("../src/modes/interactive/reference-opener.ts", async (original) => ({
	...(await original<typeof ReferenceOpener>()),
	openReference: opener,
}));

function host(source = "[guide](docs/a.md#L12:3)") {
	return {
		session: {
			getLastAssistantText: () => source,
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "[older](https://example.com/old)" }] },
				{ role: "assistant", content: [{ type: "text", text: source }] },
			],
		},
		sessionManager: { getCwd: () => "/original" },
		settingsManager: {},
		ui: {},
		showExtensionCustom: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		showStatus: vi.fn(),
	} as unknown as Parameters<typeof handleLinksCommand>[0];
}

describe("keyboard references and semantic copy", () => {
	it("keeps a long reference list bounded and returns an unclipped target after filtering", () => {
		initTheme("dark");
		const target = `https://example.com/${"long/".repeat(100)}target`;
		const selected = vi.fn();
		const picker = new SearchableSelectorComponent(
			"References",
			Array.from({ length: 10_000 }, (_, index) => ({
				label: `target-${index}`,
				value: index === 9999 ? target : String(index),
			})),
			selected,
			() => {},
		);
		expect(picker.render(80).length).toBeLessThan(30);
		for (const char of "target-9999") picker.handleInput(char);
		picker.handleInput("\r");
		expect(selected).toHaveBeenCalledWith(target);
	});

	beforeEach(() => {
		clipboard.mockReset().mockResolvedValue(undefined);
		opener.mockReset();
		selector.mockReset();
	});
	it("opens an exact file destination without native terminal links", async () => {
		const ui = host();
		selector.mockImplementation(async (_title, choices) => (choices.includes("Open") ? "Open" : choices[0]));
		await handleLinksCommand(ui, "");
		expect(opener).toHaveBeenCalledWith(ui, "file:///original/docs/a.md#L12:3");
	});
	it("searches full-session targets and lets the keyboard copy an unshortened URL", async () => {
		const ui = host();
		selector.mockImplementation(async (_title, choices) =>
			choices.includes("Copy destination") ? "Copy destination" : choices[0],
		);
		await handleLinksCommand(ui, "all example.com/old");
		expect(clipboard).toHaveBeenCalledWith("https://example.com/old");
		expect(opener).not.toHaveBeenCalled();
	});
	it("scopes references to an answer selected by the user", async () => {
		const ui = host();
		selector.mockImplementation(async (title, choices) =>
			title.startsWith("Choose an answer")
				? choices[1]
				: choices.includes("Copy destination")
					? "Copy destination"
					: choices[0],
		);
		await handleLinksCommand(ui, "message");
		expect(clipboard).toHaveBeenCalledWith("https://example.com/old");
	});
	it("keeps the backlog handler rather than sending item markers to a browser", async () => {
		const ui = host("[B12](http://127.0.0.1/__octocode/item/B12)");
		const item = vi.fn();
		setItemLinkHandler(item);
		try {
			selector.mockImplementation(async (_title, choices) => (choices.includes("Open") ? "Open" : choices[0]));
			await handleLinksCommand(ui, "");
			expect(item).toHaveBeenCalledWith("B12");
			expect(opener).not.toHaveBeenCalled();
		} finally {
			setItemLinkHandler(undefined);
		}
	});
	it("copies original code, plain text, Markdown and canonical references separately", async () => {
		const source = "**Read** [guide](docs/a.md).\n\n```ts\nconst a = '**literal**';\n```";
		const ui = host(source);
		await handleSemanticCopy(ui, "code");
		expect(clipboard).toHaveBeenLastCalledWith("const a = '**literal**';");
		await handleSemanticCopy(ui, "message");
		expect(clipboard).toHaveBeenLastCalledWith("Read guide.\n\nconst a = '**literal**';");
		await handleSemanticCopy(ui, "markdown");
		expect(clipboard).toHaveBeenLastCalledWith(source);
		await handleSemanticCopy(ui, "references");
		expect(clipboard).toHaveBeenLastCalledWith("Read guide (file:///original/docs/a.md).\n\nconst a = '**literal**';");
	});
	it("cancels without opening and reports a clipboard failure without success feedback", async () => {
		const ui = host();
		selector.mockResolvedValue(undefined);
		await handleLinksCommand(ui, "");
		expect(opener).not.toHaveBeenCalled();
		clipboard.mockRejectedValueOnce(new Error("Clipboard unavailable"));
		await handleSemanticCopy(ui, "markdown");
		expect(ui.showError).toHaveBeenCalledWith(expect.stringContaining("remains available"));
		expect(ui.showStatus).not.toHaveBeenCalled();
	});
});
