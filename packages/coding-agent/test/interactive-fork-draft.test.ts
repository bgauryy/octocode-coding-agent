import { describe, expect, it, vi } from "vitest";
import {
	handleCloneCommand,
	showUserMessageSelector,
} from "../src/modes/interactive/interactive-mode/session-navigation.ts";
import { initTheme } from "../src/theme/theme.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

initTheme("dark");

function forkHost(draft: string, selectedText: string | undefined) {
	let text = draft;
	let factory:
		| ((done: () => void) => { component: { getMessageList(): { onSelect?: (id: string) => void } } })
		| undefined;
	const host = createFakeHost({
		session: { getUserMessagesForForking: () => [{ entryId: "e1", text: "first" }] },
		runtimeHost: { fork: vi.fn(async () => ({ cancelled: false, selectedText })) },
		editor: { getText: () => text, setText: (next: string) => (text = next) },
		showSelector: (create: typeof factory) => {
			factory = create;
		},
		showStatus: vi.fn(),
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
		sessionManager: { getLeafId: () => "leaf" },
	});
	return { host, editorText: () => text, select: () => factory!(() => {}).component.getMessageList().onSelect!("e1") };
}

describe("fork keeps the unsent draft", () => {
	it("puts the forked text before the draft", async () => {
		const { host, editorText, select } = forkHost("my draft", "forked message");
		showUserMessageSelector(host);
		select();
		await vi.waitFor(() => expect(host.showStatus).toHaveBeenCalledWith("Forked to new session"));
		expect(editorText()).toBe("forked message\n\nmy draft");
	});

	it("leaves exactly the forked text when the draft is empty", async () => {
		const { host, editorText, select } = forkHost("  ", "forked message");
		showUserMessageSelector(host);
		select();
		await vi.waitFor(() => expect(host.showStatus).toHaveBeenCalledWith("Forked to new session"));
		expect(editorText()).toBe("forked message");
	});

	it("keeps the draft when the fork carries no text", async () => {
		const { host, editorText, select } = forkHost("my draft", undefined);
		showUserMessageSelector(host);
		select();
		await vi.waitFor(() => expect(host.showStatus).toHaveBeenCalledWith("Forked to new session"));
		expect(editorText()).toBe("my draft");
	});

	it("/clone keeps the draft", async () => {
		const { host, editorText } = forkHost("my draft", undefined);
		await handleCloneCommand(host);
		expect(editorText()).toBe("my draft");
	});
});
