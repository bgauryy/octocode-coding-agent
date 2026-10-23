import { Container, type TUI } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import {
	toggleThinkingBlockVisibility,
	updateThinkingBlockVisibility,
} from "../../../src/modes/interactive/interactive-mode/view-state.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createFakeHost } from "../../interactive-mode-host.ts";

function renderChat(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

describe("thinking visibility while a bash tool is running (#8611)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("preserves partial bash output", () => {
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const chatContainer = new Container();
		const component = new ToolExecutionComponent(
			"bash",
			"tool-8611",
			{ command: "echo first; sleep 10" },
			{ showImages: false },
			undefined,
			ui,
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "first" }], isError: false }, true);
		chatContainer.addChild(component);

		const fakeThis = {
			hideThinkingBlock: false,
			settingsManager: { setHideThinkingBlock: vi.fn() },
			chatContainer,
			ui,
			updateThinkingBlockVisibility() {
				updateThinkingBlockVisibility(createFakeHost(fakeThis));
			},
			showStatus: vi.fn(),
		};

		expect(renderChat(chatContainer)).toContain("first");
		toggleThinkingBlockVisibility(createFakeHost(fakeThis));

		expect(fakeThis.settingsManager.setHideThinkingBlock).toHaveBeenCalledWith(true);
		expect(chatContainer.children).toContain(component);
		expect(renderChat(chatContainer)).toContain("first");
	});
});
