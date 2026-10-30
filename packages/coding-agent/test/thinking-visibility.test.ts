import { Container } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import {
	toggleThinkingBlockVisibility,
	updateThinkingBlockVisibility,
} from "../src/modes/interactive/interactive-mode/view-state.ts";
import { initTheme } from "../src/theme/theme.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

const plain = (component: AssistantMessageComponent) =>
	component
		.render(80)
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
const thought = (text: string) =>
	new AssistantMessageComponent({ role: "assistant", content: [{ type: "thinking", thinking: text }] } as never, false);

function transcript() {
	const top = thought("Top thought.");
	const nested = thought("Nested thought.");
	const group = new Container();
	group.addChild(nested);
	const chatContainer = new Container();
	chatContainer.addChild(top);
	chatContainer.addChild(group);
	const context = {
		hideThinkingBlock: false,
		settingsManager: { setHideThinkingBlock: vi.fn() },
		chatContainer,
		ui: { requestRender: vi.fn() },
		footerDataProvider: { setExtensionStatus: vi.fn() },
		updateThinkingBlockVisibility: () => updateThinkingBlockVisibility(createFakeHost(context)),
	};
	return { top, nested, context, host: createFakeHost(context) };
}

describe("thinking visibility has one owner: the host setting", () => {
	beforeAll(() => initTheme("dark", false));

	it("applies the setting to every assistant message, including nested ones", () => {
		const { top, nested, context, host } = transcript();
		context.hideThinkingBlock = true;
		updateThinkingBlockVisibility(host);
		expect(plain(top)).not.toContain("Top thought.");
		expect(plain(nested)).not.toContain("Nested thought.");
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("persists each toggle and shows the blocks again on the second", () => {
		const { top, nested, context, host } = transcript();
		toggleThinkingBlockVisibility(host);
		expect(context.settingsManager.setHideThinkingBlock).toHaveBeenLastCalledWith(true);
		expect(plain(nested)).not.toContain("Nested thought.");
		toggleThinkingBlockVisibility(host);
		expect(context.settingsManager.setHideThinkingBlock).toHaveBeenLastCalledWith(false);
		expect(plain(top)).toContain("Top thought.");
		expect(plain(nested)).toContain("Nested thought.");
		expect(context.footerDataProvider.setExtensionStatus).toHaveBeenLastCalledWith(
			"notice",
			"Thinking blocks: visible",
		);
	});
});
