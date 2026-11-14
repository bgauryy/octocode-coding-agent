/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { createBacklogStore } from "../src/app/extension.ts";
import { LoadedHistoryList } from "../src/app/live/LoadedHistoryList.tsx";
import { LiveProvider } from "../src/app/live/session.tsx";
import type { FeedEvent } from "../src/app/live/application-projection.ts";
import { FakeSocket } from "./helpers.ts";

beforeEach(() => {
	FakeSocket.instances = [];
	vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());
function Wrapper({ children }: { children: ReactNode }) {
	return (
		<LiveProvider
			access="token"
			backlog={createBacklogStore({ repo: "r", generatedAt: 0, states: ["todo"], idleMs: 1, items: [] })}
		>
			{children}
		</LiveProvider>
	);
}
const rows = (start: number, count: number): FeedEvent[] =>
	Array.from({ length: count }, (_, i) => ({
		id: start + i,
		type: "message",
		at: i,
		text: `ROW-${start + i}-END`,
		details: {},
	}));
const list = () => screen.getByRole("list", { name: "Loaded updates" });
const mounted = () => Array.from(document.querySelector('ol[aria-label="Loaded updates"]')!.children);

it("keeps 10k loaded records reachable with at most 100 mounted rich cards, including hidden search matches", () => {
	const events = rows(0, 10000);
	render(<LoadedHistoryList events={events} loadRevision={0} label="Loaded updates" />, { wrapper: Wrapper });
	const seen = new Set<string>();
	const newer = screen.getByRole("button", { name: "Newer loaded" });
	for (let page = 0; page < 100; page++) {
		expect(mounted()).toHaveLength(100);
		for (const item of mounted())
			for (const match of item.textContent?.matchAll(/ROW-\d+-END/g) ?? []) seen.add(match[0]);
		if (page < 99) fireEvent.click(newer);
	}
	expect(seen.size).toBe(10000);
	expect(screen.getByRole("button", { name: "Newer loaded" })).toBeDisabled();
	fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ROW-42-END" } });
	expect(mounted()).toHaveLength(1);
	expect(list()).toHaveTextContent("ROW-42-END");
	fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
	expect(list()).toHaveTextContent("ROW-9900-END");
	fireEvent.click(screen.getByRole("button", { name: "Older loaded" }));
	expect(list()).toHaveTextContent("ROW-9800-END");
}, 30000);

it("anchors the current page through prepends and live appends, but reveals explicit new loads", () => {
	const events = rows(100, 300);
	const view = render(<LoadedHistoryList events={events} loadRevision={0} label="Loaded updates" />, {
		wrapper: Wrapper,
	});
	fireEvent.click(screen.getByRole("button", { name: "Newer loaded" }));
	expect(list()).toHaveTextContent("ROW-200-END");
	view.rerender(
		<LoadedHistoryList
			events={[...rows(0, 100), ...events, ...rows(400, 100)]}
			loadRevision={0}
			label="Loaded updates"
		/>,
	);
	expect(mounted()[0]).toHaveTextContent("ROW-200-END");
	view.rerender(<LoadedHistoryList events={rows(0, 500)} loadRevision={1} label="Loaded updates" />);
	expect(mounted()[0]).toHaveTextContent("ROW-0-END");
	fireEvent.click(screen.getByRole("button", { name: "Newer loaded" }));
	view.rerender(<LoadedHistoryList events={rows(400, 2)} loadRevision={1} label="Loaded updates" />);
	expect(mounted()).toHaveLength(2);
	expect(mounted()[0]).toHaveTextContent("ROW-400-END");
	expect(list()).toHaveTextContent("ROW-401-END");
});

it("indexes hidden text only while searching, reuses it between queries, and releases it on clear", () => {
	const events = rows(0, 200);
	const text = vi.fn(() => "ROW-199-END");
	Object.defineProperty(events[199], "text", { get: text });
	render(<LoadedHistoryList events={events} loadRevision={0} label="Loaded updates" />, { wrapper: Wrapper });
	expect(text).not.toHaveBeenCalled();
	fireEvent.change(screen.getByRole("searchbox"), { target: { value: "absent-one" } });
	const indexedReads = text.mock.calls.length;
	expect(indexedReads).toBeGreaterThan(0);
	fireEvent.change(screen.getByRole("searchbox"), { target: { value: "absent-two" } });
	expect(text).toHaveBeenCalledTimes(indexedReads);
	fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
	expect(text).toHaveBeenCalledTimes(indexedReads);
	fireEvent.change(screen.getByRole("searchbox"), { target: { value: "absent-three" } });
	expect(text.mock.calls.length).toBeGreaterThan(indexedReads);
});

it("searches visible structured report fields outside the mounted page", () => {
	const events = rows(0, 200);
	events[150] = {
		...events[150],
		type: "agent.result",
		text: "Report",
		details: {
			summary: "Unique summary",
			body: "Needle only in report body",
			goal: "Unique goal",
			files: ["unique-file.ts"],
		},
	};
	render(<LoadedHistoryList events={events} loadRevision={0} label="Loaded updates" />, { wrapper: Wrapper });
	for (const query of ["Unique summary", "Needle only", "Unique goal", "unique-file.ts"]) {
		fireEvent.change(screen.getByRole("searchbox"), { target: { value: query } });
		expect(mounted()).toHaveLength(1);
		expect(list()).toHaveTextContent("Needle only in report body");
	}
});
