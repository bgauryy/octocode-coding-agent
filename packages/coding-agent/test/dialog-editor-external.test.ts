import { TuiMainScreen } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { DialogEditorComponent } from "../src/modes/interactive/components/dialog-editor.ts";
import { initTheme } from "../src/theme/theme.ts";

const edited = vi.hoisted(() => ({ contents: [] as string[] }));
vi.mock("../src/modes/interactive/external-editor.ts", () => ({
	editInExternalEditor: async ({ content }: { content: string }) => {
		edited.contents.push(content);
		return { status: "complete", content };
	},
}));

beforeAll(() => initTheme("dark"));

describe("extension editor and the external editor", () => {
	it("hands the external editor pasted text in full and submits what comes back", async () => {
		const submitted: string[] = [];
		const component = new DialogEditorComponent(
			new TuiMainScreen(new VirtualTerminal(80, 24)),
			KeybindingsManager.create(),
			"Describe",
			undefined,
			(value) => submitted.push(value),
			() => {},
			undefined,
			"true",
		);
		const pasted = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
		component.handleInput(`\x1b[200~${pasted}\x1b[201~`);
		await Reflect.get(component, "handleOpenExternalEditor").call(component);
		expect(edited.contents).toEqual([pasted]);
		component.handleInput("\r");
		expect(submitted).toEqual([pasted]);
	});
});
