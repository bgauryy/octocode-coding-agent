/** @vitest-environment jsdom */
import type { Snapshot } from "@octocodeai/octocode-contracts/snapshot";
import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { daemonLive } from "../src/app/daemon/live.ts";
import { createBacklogStore } from "../src/app/extension.ts";
import { live } from "../src/app/live/index.ts";
import { FakeSocket, snapshotItem } from "./helpers.ts";

const snapshot: Snapshot = {
	repo: "repo",
	generatedAt: 1000,
	states: ["backlog", "todo", "ongoing", "done"],
	idleMs: 100_000,
	items: [
		snapshotItem("B1", { title: "First", state: "todo", rank: 1024, version: 2 }),
		snapshotItem("B2", { title: "Second", state: "todo", rank: 2048, version: 3 }),
		snapshotItem("B3", { title: "Third", state: "todo", rank: 3072, version: 4 }),
		snapshotItem("B4", { title: "Urgent unranked", state: "todo", priority: "p0" }),
		snapshotItem("B5", { title: "Idea", state: "backlog", version: 6 }),
	],
};
const fetchMock = vi.fn<typeof fetch>();
const posted = () =>
	fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)));
/** jsdom's drag events carry no coordinates: set the pointer height by hand. */
function dropAt(target: HTMLElement, clientY: number, type: "dragOver" | "drop" = "drop") {
	const event = createEvent[type](target);
	Object.defineProperty(event, "clientY", { value: clientY });
	fireEvent(target, event);
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function page(scope: "session" | "repo" = "session", hash = "#board") {
	history.replaceState(null, "", hash);
	if (!live) throw new Error("live extension");
	const view = render(
		<App backlog={createBacklogStore(snapshot)} live={daemonLive(live, { kind: scope, id: "x" })} access="tok" />,
	);
	const column = (state: string) => view.container.querySelector(`section.column.state-${state}`) as HTMLElement;
	const card = (ref: string) => view.container.querySelector(`.card[data-ref="${ref}"]`) as HTMLElement;
	const order = (state: string) =>
		[...column(state).querySelectorAll(".card")].map((node) => (node as HTMLElement).dataset.ref);
	return { ...view, column, card, order };
}

beforeEach(() => {
	FakeSocket.instances = [];
	fetchMock.mockReset().mockImplementation(async (_url, init) => json(init?.method === "POST" ? {} : snapshot));
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("column order", () => {
	it("shows ranked cards first in rank order, then the rest by priority", () => {
		const { order } = page();
		expect(order("todo")).toEqual(["B1", "B2", "B3", "B4"]);
	});

	it("lists the Backlog tab in the same order", () => {
		const { container } = page("session", "#backlog");
		const rows = [...container.querySelectorAll(".backlog-group.state-todo .backlog-row")].map(
			(row) => (row as HTMLElement).dataset.ref,
		);
		expect(rows).toEqual(["B1", "B2", "B3", "B4"]);
	});
});

describe("reordering by drag", () => {
	it("sends item.rank with both neighbours for a drop between two cards of the same column", async () => {
		const { card } = page();
		fireEvent.dragStart(card("B3"));
		// jsdom has no layout: a pointer below the zero-height midpoint lands after the card.
		dropAt(card("B1"), 5, "dragOver");
		dropAt(card("B1"), 5);
		await waitFor(() => expect(posted()).toHaveLength(1));
		expect(posted()[0]).toEqual({ command: "item.rank", id: "B3", version: 4, after: "B1", before: "B2" });
	});

	it("shows the card in its new place at once and puts it back with the host's message when refused", async () => {
		fetchMock.mockImplementation(async (_url, init) =>
			init?.method === "POST" ? json({ error: "B3 changed elsewhere — reload it." }, 409) : json(snapshot),
		);
		const { card, order } = page();
		fireEvent.dragStart(card("B3"));
		dropAt(card("B1"), 5);
		expect(order("todo")).toEqual(["B1", "B3", "B2", "B4"]);
		expect(await screen.findByRole("alert")).toHaveTextContent("B3 changed elsewhere");
		await waitFor(() => expect(order("todo")).toEqual(["B1", "B2", "B3", "B4"]));
	});

	it("sends nothing when the card is dropped where it already is", () => {
		const { card } = page();
		fireEvent.dragStart(card("B2"));
		dropAt(card("B1"), 5);
		expect(posted()).toHaveLength(0);
	});

	it("changes state first and then ranks the card in the other column", async () => {
		fetchMock.mockImplementation(async (_url, init) =>
			init?.method === "POST" ? json({ item: { ref: "B5", version: 7 } }) : json(snapshot),
		);
		const { card } = page();
		fireEvent.dragStart(card("B5"));
		dropAt(card("B2"), -5);
		await waitFor(() => expect(posted()).toHaveLength(2));
		expect(posted()[0]).toEqual({ command: "item.state", id: "B5", version: 6, state: "todo" });
		expect(posted()[1]).toEqual({ command: "item.rank", id: "B5", version: 7, after: "B1", before: "B2" });
	});

	it("keeps a plain column drop as a state change only", async () => {
		const { card, column } = page();
		fireEvent.dragStart(card("B5"));
		fireEvent.drop(column("todo"));
		await waitFor(() => expect(posted()).toHaveLength(1));
		expect(posted()[0]).toMatchObject({ command: "item.state", id: "B5" });
	});
});

describe("reordering by keyboard", () => {
	const lift = (ref: string, container: HTMLElement) => {
		const link = within(container.querySelector(`.card[data-ref="${ref}"]`) as HTMLElement).getByRole("link");
		act(() => link.focus());
	};

	it("chooses the position with Up and Down, announces it and drops with Enter", async () => {
		const user = userEvent.setup();
		const { container } = page();
		lift("B3", container);
		const liveRegion = container.querySelector(".board-live") as HTMLElement;
		await user.keyboard(" {ArrowUp}");
		expect(liveRegion).toHaveTextContent("Position 2 of 4 in To do");
		await user.keyboard("{ArrowUp}");
		expect(liveRegion).toHaveTextContent("Position 1 of 4 in To do");
		await user.keyboard("{ArrowUp}");
		expect(liveRegion).toHaveTextContent("Position 1 of 4 in To do");
		await user.keyboard("{Enter}");
		await waitFor(() => expect(posted()).toHaveLength(1));
		expect(posted()[0]).toEqual({ command: "item.rank", id: "B3", version: 4, before: "B1" });
	});

	it("moves down to the end of the column", async () => {
		const user = userEvent.setup();
		const { container } = page();
		lift("B1", container);
		await user.keyboard(" {ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
		await waitFor(() => expect(posted()).toHaveLength(1));
		expect(posted()[0]).toEqual({ command: "item.rank", id: "B1", version: 2, after: "B4" });
	});

	it("sends nothing when Up and Down end where the card started", async () => {
		const user = userEvent.setup();
		const { container } = page();
		lift("B2", container);
		await user.keyboard(" {ArrowUp}{ArrowDown}{Enter}");
		expect(posted()).toHaveLength(0);
	});
});

describe("read-only pages", () => {
	it("offer no reordering", () => {
		const { card } = page("repo");
		expect(card("B1")).not.toHaveAttribute("draggable");
		fireEvent.dragStart(card("B3"));
		dropAt(card("B1"), 5);
		expect(posted()).toHaveLength(0);
	});
});
