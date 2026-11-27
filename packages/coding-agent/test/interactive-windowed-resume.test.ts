import { Container, type Component, ScrollView } from "@octocodeai/octocode-tui";
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
import { applicationRenderer } from "../src/modes/interactive/interactive-mode/application-events.ts";
import { initTheme } from "../src/theme/theme.ts";

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
	const order: string[] = [];
	const host = {
		order,
		editor: { clearHistory: vi.fn(() => order.push("clearHistory")) },
		chatContainer,
		pendingTools: new Map<string, Component>(),
		streamingComponent: undefined as Component | undefined,
		sessionManager: { buildContextEntries: () => entries, getEntries: () => entries },
		renderSessionEntries: vi.fn((batch: SessionEntry[]) => {
			order.push("render");
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

	it("drops the previous session's prompt history before rendering this session's entries", () => {
		const host = fakeHost(entries);
		renderInitialMessages(host as never);
		expect(host.order[0]).toBe("clearHistory");
		expect(host.order).toContain("render");
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

	it("load earlier keeps the rows the reader is looking at in view", () => {
		initTheme("dark");
		const host = fakeHost(entries);
		const transcript = new ScrollView(host.chatContainer, { follow: "end" });
		const layout = () => transcript.updateLayout(host.chatContainer.render(40).length, 10, () => {});
		renderInitialMessages(host as never);
		layout();
		transcript.scrollTo(25);
		const topRow = () => host.chatContainer.render(40)[transcript.scrollTop];
		const reading = topRow();

		loadEarlierMessages({ ...host, transcriptScrollView: transcript } as never);
		layout();
		expect(topRow()).toBe(reading);
		expect(transcript.scrollTop).toBe(25 + RESUME_WINDOW_ENTRIES);
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

describe("windowed live rebuild", () => {
	it("indexes tool boundaries once instead of rescanning hidden message content on every page", () => {
		let reads = 0;
		const entries = Array.from({ length: 2000 }, (_, i) => message(i));
		const counted = entries.map(
			(entry) =>
				new Proxy(entry, {
					get(target, key, receiver) {
						if (key === "message") reads++;
						return Reflect.get(target, key, receiver);
					},
				}),
		);
		const host = fakeHost(counted);
		renderInitialMessages(host as never);
		reads = 0;
		while (loadEarlierMessages(host as never));
		expect(reads).toBe(0);
		expect(labels(host)).toEqual(entries.map((entry) => entry.id));
	});

	it("a transcript reset during a session renders the same bounded window", () => {
		const entries = Array.from({ length: 2000 }, (_, i) => message(i));
		const host = { ...fakeHost(entries), entriesRenderedByRebuild: new Set<string>() };
		host.renderSessionEntries.mockImplementation((batch: SessionEntry[]) => {
			for (const entry of batch) host.chatContainer.addChild(new Row(entry.id));
		});

		const render = applicationRenderer(host as never, { readAsset: () => undefined } as never);
		render({ type: "session.reset", messages: [], tools: [] } as never);
		expect(host.chatContainer.children).toHaveLength(RESUME_WINDOW_ENTRIES + 1);
		expect((host.chatContainer.children.at(-1) as Row).label).toBe("e1999");
		// Every entry is remembered, hidden ones too: a late announcement of one must not draw it a second time.
		expect(host.entriesRenderedByRebuild.size).toBe(2000);
		expect(loadEarlierMessages(host as never)).toBe(true);
		expect(host.chatContainer.children).toHaveLength(2 * RESUME_WINDOW_ENTRIES + 1);
	});
});
