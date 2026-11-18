import { Container } from "@octocodeai/octocode-tui";
import { describe, expect, test, vi } from "vitest";
import type { QueuedInput } from "../src/core/agent-session.ts";
import { handleDequeue } from "../src/modes/interactive/interactive-mode/message-queue.ts";
import {
	listQueueItems,
	moveQueueItem,
	recallLastQueuedMessage,
	removeQueueItem,
} from "../src/modes/interactive/interactive-mode/queue-manager.ts";
import { createFakeHost, heldStore } from "./interactive-mode-host.ts";

/** A host whose session queue behaves like the core one: ids, kinds, edit/remove/move. */
function fixture(
	queued: Array<Partial<QueuedInput> & { text: string }> = [],
	compaction: Array<{ text: string; mode: "steer" | "followUp" }> = [],
) {
	let items: QueuedInput[] = queued.map((entry, index) => ({
		id: `q${index + 1}`,
		mode: "steer",
		imageCount: 0,
		source: "interactive",
		...entry,
	}));
	const session = {
		isCompacting: false,
		getQueuedInputs: () => items,
		getSteeringMessages: () => items.filter((item) => item.mode === "steer").map((item) => item.text),
		getFollowUpMessages: () => items.filter((item) => item.mode === "followUp").map((item) => item.text),
		removeQueuedInput: vi.fn((id: string) => {
			const found = items.find((item) => item.id === id);
			items = items.filter((item) => item.id !== id);
			return found;
		}),
		replaceQueuedInput: vi.fn((id: string, text: string) => {
			const found = items.find((item) => item.id === id);
			if (!found) return "missing";
			if (!text.trim()) {
				items = items.filter((item) => item.id !== id);
				return "removed";
			}
			found.text = text;
			return "replaced";
		}),
		moveQueuedInput: vi.fn((id: string, direction: "up" | "down") => {
			const index = items.findIndex((item) => item.id === id);
			const other = items.findIndex(
				(item, i) => i === index + (direction === "up" ? -1 : 1) && item.mode === items[index]?.mode,
			);
			if (index < 0 || other < 0) return false;
			[items[index], items[other]] = [items[other], items[index]];
			return true;
		}),
		clearQueue: vi.fn(),
	};
	const editorText = { value: "" };
	const ui = {
		session,
		uiStore: heldStore(compaction),
		editor: {
			getText: () => editorText.value,
			setText: (text: string) => {
				editorText.value = text;
			},
		},
		pendingMessagesContainer: new Container(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showSelectorDialog: vi.fn(),
		showEditorDialog: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
	return { ui, host: createFakeHost(ui), session, editorText };
}

describe("queue item list", () => {
	test("orders next-turn messages before follow-ups, session before compaction, and marks extension messages", () => {
		const { host } = fixture(
			[{ text: "after", mode: "followUp" }, { text: "first" }, { text: "ext", source: "feature" }],
			[
				{ text: "late follow", mode: "followUp" },
				{ text: "late steer", mode: "steer" },
			],
		);
		expect(listQueueItems(host).map((item) => [item.mode, item.text, item.feature])).toEqual([
			["steer", "first", false],
			["steer", "ext", true],
			["steer", "late steer", false],
			["followUp", "after", false],
			["followUp", "late follow", false],
		]);
	});
});

describe("recalling the last queued message (Alt+Up)", () => {
	test("restores only the last queued message and keeps the others queued", () => {
		const { host, session, editorText, ui } = fixture([
			{ text: "one" },
			{ text: "two" },
			{ text: "three", mode: "followUp" },
		]);
		handleDequeue(host);
		expect(editorText.value).toBe("three");
		expect(session.removeQueuedInput).toHaveBeenCalledOnce();
		expect(session.clearQueue).not.toHaveBeenCalled();
		expect(session.getQueuedInputs().map((item) => item.text)).toEqual(["one", "two"]);
		expect(ui.showStatus).toHaveBeenCalledWith(expect.stringContaining("2 still queued"));

		// Pressing again with the draft present recalls the next one without duplicating or dropping anything.
		handleDequeue(host);
		expect(editorText.value).toBe("two\n\nthree");
		expect(session.getQueuedInputs().map((item) => item.text)).toEqual(["one"]);
	});

	test("puts the recalled message before an existing draft", () => {
		const { host, editorText } = fixture([{ text: "queued" }]);
		editorText.value = "draft\nline two";
		handleDequeue(host);
		expect(editorText.value).toBe("queued\n\ndraft\nline two");
	});

	test("recalls from the compaction queue when it holds the last message", () => {
		const { host, ui, session, editorText } = fixture(
			[{ text: "session" }],
			[{ text: "during compaction", mode: "steer" }],
		);
		// Delivery order is steering session then steering compaction, so the compaction message is last.
		handleDequeue(host);
		expect(editorText.value).toBe("during compaction");
		expect(ui.uiStore.getState().queue.compaction).toEqual([]);
		expect(session.removeQueuedInput).not.toHaveBeenCalled();
	});

	test("reports an empty queue and leaves the editor alone", () => {
		const { host, ui, editorText } = fixture();
		editorText.value = "draft";
		handleDequeue(host);
		expect(editorText.value).toBe("draft");
		expect(ui.showStatus).toHaveBeenCalledWith("No queued messages to restore");
	});

	test("does not pull a message with attachments into the text-only editor", () => {
		const { host, ui, session, editorText } = fixture([{ text: "with image", imageCount: 2 }]);
		handleDequeue(host);
		expect(editorText.value).toBe("");
		expect(session.removeQueuedInput).not.toHaveBeenCalled();
		expect(ui.showStatus).toHaveBeenCalledWith(expect.stringContaining("2 attachments"));
	});

	test("recalls an extension-sent message like any other", () => {
		const { host, editorText } = fixture([{ text: "from ext", source: "feature" }]);
		handleDequeue(host);
		expect(editorText.value).toBe("from ext");
	});

	test("recall is a no-op once the message began delivery", () => {
		const { host, session, ui, editorText } = fixture([{ text: "racing" }]);
		session.removeQueuedInput.mockReturnValueOnce(undefined);
		expect(recallLastQueuedMessage(host)).toBe(false);
		expect(editorText.value).toBe("");
		expect(ui.showStatus).toHaveBeenCalledWith(expect.stringContaining("already being delivered"));
	});
});

describe("removing and moving", () => {
	test("remove acts on compaction-queue messages", () => {
		const { host, ui } = fixture(
			[],
			[
				{ text: "a", mode: "steer" },
				{ text: "b", mode: "steer" },
			],
		);
		expect(removeQueueItem(host, listQueueItems(host)[1])).toBe(true);
		expect(ui.uiStore.getState().queue.compaction).toEqual([{ text: "a", mode: "steer" }]);
	});

	test("removing a message that has been delivered meanwhile reports false", () => {
		const { host, session } = fixture([{ text: "old" }]);
		const [item] = listQueueItems(host);
		session.getQueuedInputs().length = 0;
		expect(removeQueueItem(host, item)).toBe(false);
	});

	test("moves within the same kind and source; false at the ends", () => {
		const { host, session, ui } = fixture(
			[{ text: "a" }, { text: "b" }],
			[
				{ text: "x", mode: "followUp" },
				{ text: "y", mode: "followUp" },
			],
		);
		let items = listQueueItems(host);
		expect(moveQueueItem(host, items[1], "up")).toBe(true);
		expect(session.getSteeringMessages()).toEqual(["b", "a"]);
		expect(moveQueueItem(host, listQueueItems(host)[0], "up")).toBe(false);
		items = listQueueItems(host);
		expect(moveQueueItem(host, items[3], "up")).toBe(true);
		expect(ui.uiStore.getState().queue.compaction.map((entry) => entry.text)).toEqual(["y", "x"]);
		expect(moveQueueItem(host, listQueueItems(host)[3], "down")).toBe(false);
	});
});
