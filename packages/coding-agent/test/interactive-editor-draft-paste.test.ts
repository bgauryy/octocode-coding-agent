import { setKeybindings, TuiMainScreen } from "@octocodeai/octocode-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { prependToEditorDraft } from "../src/modes/interactive/interactive-mode/helpers.ts";
import { restoreQueuedMessagesToEditor } from "../src/modes/interactive/interactive-mode/message-queue.ts";
import { CustomEditor } from "../src/theme/custom-editor.ts";
import { getEditorTheme, initTheme } from "../src/theme/theme.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

const big = Array.from({ length: 40 }, (_, i) => `row ${i}`).join("\n");

function editor() {
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const created = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), getEditorTheme(), keybindings);
	const sent: string[] = [];
	created.onSubmit = (text) => sent.push(text);
	return { editor: created, sent };
}

beforeEach(() => initTheme("dark"));

describe("a draft with paste markers put back behind restored text", () => {
	it("sends a recalled large prompt in full after queued messages return to the editor", () => {
		const { editor: input, sent } = editor();
		input.addToHistory(big);
		input.handleInput("\x1b[A");
		expect(input.getText()).toBe("[paste #1 +40 lines]");

		const host = createFakeHost({
			editor: input,
			clearAllQueues: () => ({ steering: ["queued one"], followUp: ["queued two"] }),
			session: {},
		});
		expect(restoreQueuedMessagesToEditor(host)).toBe(2);
		expect(input.getText()).toBe("queued one\n\nqueued two\n\n[paste #1 +40 lines]");

		input.handleInput("\r");
		expect(sent).toEqual([`queued one\n\nqueued two\n\n${big}`]);
	});

	it("expands the draft of an editor that cannot keep its markers", () => {
		let text = "[paste #1 +40 lines]";
		const duckTyped = {
			getText: () => text,
			getExpandedText: () => text.replace("[paste #1 +40 lines]", big),
			setText: (next: string) => {
				text = next;
			},
			handleInput: () => {},
			render: () => [],
			invalidate: () => {},
		};
		prependToEditorDraft(duckTyped, "restored");
		expect(text).toBe(`restored\n\n${big}`);
	});

	it("expands the draft when the restored text holds a marker the draft's pastes would expand", () => {
		const { editor: input, sent } = editor();
		input.handleInput(`\x1b[200~${big}\x1b[201~`);
		expect(input.getText()).toBe("[paste #1 +40 lines]");
		input.prependText("about [paste #1 +40 lines]");
		input.handleInput("\r");
		expect(sent).toEqual([`about [paste #1 +40 lines]\n\n${big}`]);
	});
});
