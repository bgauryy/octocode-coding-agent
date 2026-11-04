import { Container, type Component } from "@octocodeai/octocode-tui";
import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import {
	rebuildChatFromMessages,
	renderInitialMessages,
} from "../src/modes/interactive/interactive-mode/session-render.ts";
import {
	loadEarlierFromKey,
	loadEarlierMessages,
	RESUME_WINDOW_ENTRIES,
} from "../src/modes/interactive/interactive-mode/session-window.ts";

class Row implements Component {
	disposed = false;
	readonly label: string;
	constructor(label: string) {
		this.label = label;
	}
	render(): string[] {
		return [this.label];
	}
	invalidate(): void {}
	dispose(): void {
		this.disposed = true;
	}
}

const message = (i: number, role: "user" | "assistant" | "toolResult" = "user"): SessionEntry =>
	({ type: "message", id: `e${i}`, parentId: null, message: { role } }) as unknown as SessionEntry;
const compaction = { type: "compaction", id: "c0", parentId: null } as unknown as SessionEntry;

function fakeHost(entries: SessionEntry[]) {
	const chatContainer = new Container();
	const host = {
		chatContainer,
		pendingTools: new Map<string, Component>(),
		streamingComponent: undefined as Component | undefined,
		sessionManager: { buildContextEntries: () => entries, getEntries: () => entries },
		renderSessionEntries: vi.fn((batch: SessionEntry[]) => {
			for (const entry of batch) chatContainer.addChild(new Row(entry.type === "compaction" ? "summary" : entry.id));
			host.pendingTools.clear();
		}),
		showStatus: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
	return host;
}

const labels = (host: ReturnType<typeof fakeHost>) =>
	host.chatContainer.children.map((child) => (child instanceof Row ? child.label : "row"));

describe("windowed resume", () => {
	const entries = Array.from({ length: 2000 }, (_, i) => message(i));

	it("renders a bounded window of a 2,000-entry session, ending with the last messages", () => {
		const host = fakeHost(entries);
		renderInitialMessages(host as never);
		const shown = labels(host);
		expect(shown).toHaveLength(RESUME_WINDOW_ENTRIES + 1); // window plus the load-earlier row
		expect(shown.at(-1)).toBe("e1999");
		expect(shown[1]).toBe(`e${2000 - RESUME_WINDOW_ENTRIES}`);
	});

	it("prepends the previous window in order, below the row, until nothing is hidden", () => {
		const host = fakeHost(entries);
		renderInitialMessages(host as never);
		expect(loadEarlierMessages(host as never)).toBe(true);
		const shown = labels(host);
		expect(shown).toHaveLength(2 * RESUME_WINDOW_ENTRIES + 1);
		expect(shown[0]).toBe("row");
		expect(shown.slice(1)).toEqual(entries.slice(2000 - 2 * RESUME_WINDOW_ENTRIES).map((e) => e.id));
		while (loadEarlierMessages(host as never));
		expect(labels(host)).toEqual(entries.map((e) => e.id));
		loadEarlierFromKey(host as never);
		expect(host.showStatus).toHaveBeenCalledWith("No earlier messages to load");
	});

	it("keeps the compaction summary on top and a tool call with its results", () => {
		const long = [compaction, ...entries.slice(0, 500)];
		// make the window start fall on a tool result: entry 300 of the context
		long[301] = message(300, "toolResult");
		const host = fakeHost(long);
		renderInitialMessages(host as never);
		const shown = labels(host);
		expect(shown[0]).toBe("summary");
		expect(shown[1]).toBe("row");
		expect(shown[2]).toBe("e299");
	});

	it("rebuild disposes old rows, keeps the live reply and does not window a short session", () => {
		const host = fakeHost(entries);
		renderInitialMessages(host as never);
		const old = host.chatContainer.children.filter((child): child is Row => child instanceof Row);
		const live = new Row("live");
		host.streamingComponent = live;
		host.chatContainer.addChild(live);
		rebuildChatFromMessages(host as never);
		expect(old).toHaveLength(RESUME_WINDOW_ENTRIES);
		expect(old.every((row) => row.disposed)).toBe(true);
		expect(live.disposed).toBe(false);
		expect(labels(host).at(-1)).toBe("live");

		const short = fakeHost(entries.slice(0, 10));
		renderInitialMessages(short as never);
		expect(labels(short)).toEqual(entries.slice(0, 10).map((e) => e.id));
	});
});
