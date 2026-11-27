/** @vitest-environment jsdom */
import type { Snapshot } from "@octocodeai/octocode-contracts/snapshot";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
		snapshotItem("B1", { title: "Idea", state: "backlog", goal: "g", why: "w", tags: ["ui", "api", "docs"] }),
		snapshotItem("B2", { title: "Ready work", state: "todo", goal: "It works", why: "Users need it", version: 3 }),
		snapshotItem("B3", { title: "No goal yet", state: "todo" }),
		snapshotItem("B4", { title: "Busy", state: "ongoing", goal: "g", why: "w", assignee: "agent-1" }),
		snapshotItem("B5", { title: "Shipped", state: "done", goal: "g", why: "w", version: 2 }),
		snapshotItem("B6", {
			title: "Dropped idea",
			state: "done",
			version: 4,
			closed: { kind: "obsolete", text: "Superseded", by: "user", at: 5 },
		}),
		snapshotItem("B7", { title: "Big epic", type: "epic", state: "backlog", children: ["B2"] }),
	],
};
const fetchMock = vi.fn<typeof fetch>();
const posted = () =>
	fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function board(scope: "session" | "repo" = "session") {
	history.replaceState(null, "", "#board");
	if (!live) throw new Error("live extension");
	const view = render(
		<App backlog={createBacklogStore(snapshot)} live={daemonLive(live, { kind: scope, id: "x" })} access="tok" />,
	);
	const column = (state: string) => view.container.querySelector(`section.column.state-${state}`) as HTMLElement;
	const card = (ref: string) => view.container.querySelector(`.card[data-ref="${ref}"]`) as HTMLElement;
	const drag = (ref: string, to: HTMLElement) => {
		fireEvent.dragStart(card(ref));
		fireEvent.dragOver(to);
		fireEvent.drop(to);
	};
	return { ...view, column, card, drag };
}

beforeEach(() => {
	FakeSocket.instances = [];
	fetchMock.mockReset().mockImplementation(async (_url, init) => json(init?.method === "POST" ? {} : snapshot));
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("dragging a card between columns", () => {
	it("sends item.state with the card's version when it drops on Backlog", async () => {
		const { column, card, drag } = board();
		expect(card("B2")).toHaveAttribute("draggable", "true");
		drag("B2", column("backlog"));
		await waitFor(() => expect(posted()).toHaveLength(1));
		expect(posted()[0]).toEqual({ command: "item.state", id: "B2", version: 3, state: "backlog" });
	});

	it("moves the card at once and puts it back with the host's message when the host refuses", async () => {
		fetchMock.mockImplementation(async (_url, init) =>
			init?.method === "POST"
				? json({ error: "B2 is ongoing for agent-1, which is still running." }, 409)
				: json(snapshot),
		);
		const { column, card, drag } = board();
		drag("B2", column("backlog"));
		expect(within(column("backlog")).getByRole("link", { name: "Ready work" })).toBeInTheDocument();
		expect(await screen.findByRole("alert")).toHaveTextContent("B2 is ongoing for agent-1");
		await waitFor(() => expect(column("todo")).toContainElement(card("B2")));
	});

	it("shows a drop indicator while a card is over a column", () => {
		const { column, card } = board();
		fireEvent.dragStart(card("B2"));
		fireEvent.dragOver(column("ongoing"));
		expect(column("ongoing")).toHaveClass("is-drop-target");
		expect(within(column("ongoing")).getByText("Drop here")).toBeInTheDocument();
		fireEvent.dragEnd(card("B2"));
		expect(column("ongoing")).not.toHaveClass("is-drop-target");
	});

	it("checks goal and why before claiming, and offers the editor", async () => {
		const user = userEvent.setup();
		const { column, drag } = board();
		drag("B3", column("ongoing"));
		const dialog = await screen.findByRole("dialog", { name: /B3 needs more/ });
		expect(dialog).toHaveTextContent("goal and why");
		expect(posted()).toHaveLength(0);
		await user.click(within(dialog).getByRole("button", { name: "Edit B3" }));
		expect(location.hash).toBe("#B3/edit");
		expect(posted()).toHaveLength(0);
	});

	it("says it claims the item as you, asks once, and then moves", async () => {
		const user = userEvent.setup();
		const { column, drag } = board();
		drag("B2", column("ongoing"));
		const dialog = await screen.findByRole("dialog", { name: "Start B2" });
		expect(dialog).toHaveTextContent("assigns B2 to you");
		expect(posted()).toHaveLength(0);
		await user.click(within(dialog).getByRole("button", { name: "Claim as you" }));
		await waitFor(() => expect(posted()).toHaveLength(1));
		expect(posted()[0]).toEqual({ command: "item.state", id: "B2", version: 3, state: "ongoing" });
		drag("B1", column("ongoing"));
		await waitFor(() => expect(posted()).toHaveLength(2));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("never completes on a drop: it opens the completion editor", () => {
		const { column, drag } = board();
		drag("B4", column("done"));
		expect(location.hash).toBe("#B4/edit");
		expect(posted()).toHaveLength(0);
	});

	it("refuses to drop a closed card on Done, and a done card on Closed, without calling the host", async () => {
		const user = userEvent.setup();
		const { column, drag } = board();
		await user.click(screen.getByRole("button", { name: /Closed/ }));
		drag("B5", screen.getByRole("region", { name: /Closed/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent("B5 is done: reopen it before closing.");
		expect(posted()).toHaveLength(0);
		expect(column("done")).toBeInTheDocument();
	});

	it("asks for a note when a done card reopens, then sends it with item.state", async () => {
		const user = userEvent.setup();
		const { column, drag } = board();
		drag("B5", column("todo"));
		const dialog = await screen.findByRole("dialog", { name: "Reopen B5" });
		const submit = within(dialog).getByRole("button", { name: "Reopen" });
		expect(submit).toBeDisabled();
		expect(posted()).toHaveLength(0);
		await user.type(within(dialog).getByRole("textbox"), "Found a regression");
		await user.click(submit);
		await waitFor(() => expect(posted()).toHaveLength(1));
		expect(posted()[0]).toEqual({
			command: "item.state",
			id: "B5",
			version: 2,
			state: "todo",
			note: "Found a regression",
		});
	});

	it("reopens a closed card from the Closed list with a note", async () => {
		const user = userEvent.setup();
		board();
		await user.click(screen.getByRole("button", { name: /Closed/ }));
		expect(screen.getByText(/Superseded/)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Reopen B6" }));
		const dialog = await screen.findByRole("dialog", { name: "Reopen B6" });
		await user.type(within(dialog).getByRole("textbox"), "Needed after all");
		await user.click(within(dialog).getByRole("button", { name: "Reopen" }));
		await waitFor(() => expect(posted()).toHaveLength(1));
		expect(posted()[0]).toMatchObject({
			command: "item.state",
			id: "B6",
			version: 4,
			state: "todo",
			note: "Needed after all",
		});
	});

	it("opens the Close dialog on a drop on Closed, then offers Undo that reopens with a note", async () => {
		const user = userEvent.setup();
		const { drag } = board();
		drag("B2", screen.getByRole("region", { name: /Closed/ }));
		const dialog = await screen.findByRole("dialog", { name: "Close item B2" });
		await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "No longer needed");
		await user.click(within(dialog).getByRole("button", { name: "Close B2" }));
		await waitFor(() => expect(posted()).toHaveLength(1));
		expect(posted()[0]).toEqual({
			command: "item.close",
			id: "B2",
			version: 3,
			kind: "obsolete",
			text: "No longer needed",
		});
		const toast = await waitFor(() => {
			const found = document.querySelector<HTMLElement>(".toast");
			if (!found) throw new Error("no toast");
			return found;
		});
		expect(toast).toHaveTextContent("B2 closed");
		await user.click(within(toast).getByRole("button", { name: /^Undo \(back to To do\)/ }));
		await waitFor(() => expect(posted()).toHaveLength(2));
		expect(posted()[1]).toMatchObject({
			command: "item.state",
			id: "B2",
			state: "todo",
			note: "Undo close from the board",
		});
	});
});

describe("keyboard", () => {
	const lift = async (ref: string, container: HTMLElement) => {
		const link = within(container.querySelector(`.card[data-ref="${ref}"]`) as HTMLElement).getByRole("link");
		act(() => link.focus());
		return link;
	};

	it("lifts with Space, chooses a column with arrows, drops with Enter, and announces each step", async () => {
		const user = userEvent.setup();
		const { container } = board();
		await lift("B2", container);
		const live = container.querySelector(".board-live") as HTMLElement;
		await user.keyboard(" ");
		expect(live).toHaveTextContent("Picked up B2 from To do");
		await user.keyboard("{ArrowLeft}");
		expect(live).toHaveTextContent("Backlog, column 1 of 5");
		expect(container.querySelector("section.column.state-backlog")).toHaveClass("is-drop-target");
		await user.keyboard("{Enter}");
		await waitFor(() => expect(posted()).toHaveLength(1));
		expect(posted()[0]).toMatchObject({ command: "item.state", id: "B2", state: "backlog" });
		expect(location.hash).toBe("#board");
	});

	it("cancels with Escape and sends nothing", async () => {
		const user = userEvent.setup();
		const { container } = board();
		await lift("B2", container);
		await user.keyboard(" {ArrowRight}{Escape}");
		expect(container.querySelector(".board-live")).toHaveTextContent("Move of B2 cancelled");
		await user.keyboard("{ArrowRight}");
		expect(posted()).toHaveLength(0);
		expect(container.querySelector(".is-drop-target")).toBeNull();
	});
});

describe("card menu", () => {
	it("keeps epics out of drag and says why in the menu", async () => {
		const user = userEvent.setup();
		const { card } = board();
		expect(card("B7")).not.toHaveAttribute("draggable");
		await user.click(screen.getByRole("button", { name: "Actions for B7" }));
		const menu = screen.getByRole("menu", { name: "B7 actions" });
		expect(within(menu).getByText("State follows children")).toBeInTheDocument();
		expect(within(menu).queryByRole("menuitem", { name: /Move to/ })).toBeNull();
		expect(within(menu).queryByRole("menuitem", { name: /Close/ })).toBeNull();
	});

	it("lists Open, Move to, Close and Copy ref for an open card and Reopen for a done one", async () => {
		const user = userEvent.setup();
		board();
		await user.click(screen.getByRole("button", { name: "Actions for B2" }));
		const menu = screen.getByRole("menu", { name: "B2 actions" });
		expect(
			within(menu)
				.getAllByRole("menuitem")
				.map((item) => item.textContent),
		).toEqual(["Open", "Move to Backlog", "Move to In progress", "Move to Done", "Close…", "Copy ref"]);
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("menu")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Actions for B5" }));
		expect(screen.getByRole("menuitem", { name: "Reopen…" })).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: "Close…" })).toBeNull();
	});

	it("closes from the menu through the Close dialog", async () => {
		const user = userEvent.setup();
		board();
		await user.click(screen.getByRole("button", { name: "Actions for B1" }));
		await user.click(screen.getByRole("menuitem", { name: "Close…" }));
		const dialog = await screen.findByRole("dialog", { name: "Close item B1" });
		await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Stale");
		await user.click(within(dialog).getByRole("button", { name: "Close B1" }));
		await waitFor(() => expect(document.querySelector(".toast")).toHaveTextContent("B1 closed"));
	});

	it("is compact: tags as colored chips, no select and no Implement button on the card", () => {
		const { card } = board();
		const b1 = card("B1");
		expect(within(b1).queryByRole("combobox")).toBeNull();
		expect(within(b1).getByText("+1")).toBeInTheDocument();
		const chips = within(b1)
			.getAllByRole("listitem")
			.filter((li) => li.className.includes("tag-"));
		expect(chips).toHaveLength(2);
		expect(chips[0].className).toMatch(/tag-[0-7]/);
	});
});

describe("adding a card in a column", () => {
	it("adds with Enter in Backlog and To do only, and cancels with Escape", async () => {
		const user = userEvent.setup();
		const { column } = board();
		expect(within(column("ongoing")).queryByRole("button", { name: /Add a card/ })).toBeNull();
		expect(within(column("done")).queryByRole("button", { name: /Add a card/ })).toBeNull();
		await user.click(within(column("todo")).getByRole("button", { name: /Add a card/ }));
		await user.type(screen.getByRole("textbox", { name: "Title of the new card in To do" }), "Write docs{Enter}");
		await waitFor(() => expect(posted()).toHaveLength(1));
		expect(posted()[0]).toEqual({ op: "add", title: "Write docs", state: "todo", type: "feature" });
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("textbox", { name: /Title of the new card/ })).toBeNull();
		expect(posted()).toHaveLength(1);
	});
});

describe("read-only page", () => {
	it("draws no drag, add, or write entry", async () => {
		const user = userEvent.setup();
		const { card, container } = board("repo");
		expect(card("B2")).not.toHaveAttribute("draggable");
		expect(screen.queryByRole("button", { name: /Add a card/ })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Actions for B2" }));
		const menu = screen.getByRole("menu", { name: "B2 actions" });
		expect(
			within(menu)
				.getAllByRole("menuitem")
				.map((item) => item.textContent),
		).toEqual(["Open", "Copy ref"]);
		expect(container.querySelector("[aria-describedby=board-dnd-hint]")).toBeNull();
		fireEvent.dragStart(card("B2"));
		fireEvent.drop(container.querySelector("section.column.state-backlog") as HTMLElement);
		expect(posted()).toHaveLength(0);
	});
});

describe("review fixes", () => {
	it("keeps focus in the quick-add field after each add", async () => {
		const user = userEvent.setup();
		const { column } = board();
		await user.click(within(column("todo")).getByRole("button", { name: /Add a card/ }));
		const field = screen.getByRole("textbox", { name: "Title of the new card in To do" });
		await user.type(field, "One{Enter}");
		await waitFor(() => expect(posted()).toHaveLength(1));
		await waitFor(() => expect(field).toHaveFocus());
	});

	it("returns focus to the card's title after a keyboard drop moves it", async () => {
		const user = userEvent.setup();
		const { container } = board();
		act(() =>
			within(container.querySelector('.card[data-ref="B2"]') as HTMLElement)
				.getByRole("link")
				.focus(),
		);
		await user.keyboard(" {ArrowLeft}{Enter}");
		await waitFor(() => expect(posted()).toHaveLength(1));
		// The static snapshot puts the card back in To do once the move settles; focus must follow it there.
		await waitFor(() => expect(document.activeElement).toHaveAccessibleName("Ready work"));
	});

	it("sends one command when the same card is dropped twice before the first settles", async () => {
		const { column, drag } = board();
		drag("B2", column("backlog"));
		drag("B2", column("backlog"));
		await waitFor(() => expect(posted()).toHaveLength(1));
		expect(posted()).toHaveLength(1);
	});

	it("shows the host's message for a stale drop and puts the card back", async () => {
		fetchMock.mockImplementation(async (_url, init) =>
			init?.method === "POST" ? json({ error: "B2 changed elsewhere \u2014 reload it." }, 409) : json(snapshot),
		);
		const { column, card, drag } = board();
		drag("B2", column("backlog"));
		expect(await screen.findByRole("alert")).toHaveTextContent("B2 changed elsewhere");
		await waitFor(() => expect(column("todo")).toContainElement(card("B2")));
	});

	it("closes the card menu on outside click, Escape and scroll", async () => {
		const user = userEvent.setup();
		board();
		const open = () => user.click(screen.getByRole("button", { name: "Actions for B2" }));
		await open();
		await user.click(document.body);
		expect(screen.queryByRole("menu")).toBeNull();
		await open();
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("menu")).toBeNull();
		await open();
		fireEvent.scroll(document.body);
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("expires the Undo toast after its window even while the board state keeps changing", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		const { drag, card, column } = board();
		drag("B2", screen.getByRole("region", { name: /Closed/ }));
		const dialog = await screen.findByRole("dialog", { name: "Close item B2" });
		await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Stale");
		await user.click(within(dialog).getByRole("button", { name: "Close B2" }));
		await waitFor(() => expect(document.querySelector(".toast")).toHaveTextContent(/B2 closed/));
		act(() => vi.advanceTimersByTime(5000));
		fireEvent.dragStart(card("B1"));
		fireEvent.dragOver(column("ongoing"));
		act(() => vi.advanceTimersByTime(5000));
		expect(document.querySelector(".toast")).toBeNull();
	});

	it("tells the person when the board could not be refreshed after a move", async () => {
		fetchMock.mockImplementation(async (_url, init) =>
			init?.method === "POST" ? json({}) : new Response("down", { status: 500 }),
		);
		const { column, drag } = board();
		drag("B2", column("backlog"));
		expect(await screen.findByRole("alert")).toHaveTextContent("Could not refresh the board");
	});
});
