/** @vitest-environment jsdom */
import type { Snapshot, SnapshotItem } from "@octocodeai/octocode-contacts/snapshot";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/app/App.tsx";
import { createBacklogStore } from "../src/app/extension.ts";
import { rankCommands } from "../src/app/features/CommandPalette.tsx";

function item(ref: string, overrides: Partial<SnapshotItem> = {}): SnapshotItem {
	return {
		ref,
		title: `Task ${ref}`,
		goal: "",
		body: "",
		paths: [],
		why: "",
		evidence: [],
		plan: "",
		state: "todo",
		priority: "p2",
		tags: [],
		createdBy: "kim",
		createdAt: 0,
		updatedAt: 0,
		version: 1,
		derived: [],
		notes: [],
		...overrides,
	};
}
const snapshot: Snapshot = {
	repo: "octo-repo",
	generatedAt: 1000,
	states: ["backlog", "todo", "ongoing", "done"],
	idleMs: 1_000_000,
	items: [
		item("B1", { title: "Fix login redirect", priority: "p0", tags: ["auth"] }),
		item("B2", { title: "Write onboarding docs", state: "done", priority: "p3" }),
		item("B3", { title: "Profile slow board", state: "ongoing", assignee: "kim", assigneeLive: true }),
	],
};

function renderApp() {
	return render(<App backlog={createBacklogStore(snapshot)} live={null} />);
}
async function go(hash: string) {
	await act(async () => {
		location.hash = hash;
		window.dispatchEvent(new HashChangeEvent("hashchange"));
	});
}

beforeEach(() => {
	history.replaceState(null, "", "#board");
});

describe("board", () => {
	it("filters cards, mirrors filters into the hash and clears them", async () => {
		const user = userEvent.setup();
		renderApp();
		expect(screen.getByRole("heading", { level: 1, name: "octo-repo" })).toBeInTheDocument();
		await user.type(screen.getByRole("searchbox", { name: "Search tasks" }), "login");
		expect(screen.getByRole("link", { name: "Fix login redirect" })).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "Write onboarding docs" })).not.toBeInTheDocument();
		expect(location.hash).toBe("#board?q=login");
		expect(screen.getByRole("status")).toHaveTextContent("1 of 3 items");
		await user.click(screen.getByRole("button", { name: "Clear filters" }));
		expect(location.hash).toBe("#board");
		expect(screen.getByRole("searchbox", { name: "Search tasks" })).toHaveFocus();
	});

	it("restores filters from the URL and keeps them on the tab link", () => {
		history.replaceState(null, "", "#board?p=p0");
		renderApp();
		expect(screen.getByRole("combobox", { name: "Priority" })).toHaveValue("p0");
		expect(screen.getByRole("link", { name: /Board/, current: "page" })).toHaveAttribute("href", "#board?p=p0");
	});

	it("focuses the view's search with /", async () => {
		const user = userEvent.setup();
		renderApp();
		await user.keyboard("/");
		expect(screen.getByRole("searchbox", { name: "Search tasks" })).toHaveFocus();
	});
});

describe("table", () => {
	it("sorts by a column and exposes the order to assistive technology", async () => {
		const user = userEvent.setup();
		history.replaceState(null, "", "#table");
		renderApp();
		const header = screen.getByRole("columnheader", { name: /Priority/ });
		expect(header).toHaveAttribute("aria-sort", "none");
		await user.click(within(header).getByRole("button"));
		expect(header).toHaveAttribute("aria-sort", "ascending");
		expect(location.hash).toBe("#table?sort=priority&dir=asc");
		const rows = screen.getAllByRole("row").slice(1);
		expect(within(rows[0]).getByRole("link", { name: "Fix login redirect" })).toBeInTheDocument();
		expect(within(header).getByRole("button")).toHaveFocus();
	});
});

describe("item sheet", () => {
	it("opens as a modal, traps focus, closes with Escape and returns focus to the card", async () => {
		const user = userEvent.setup();
		renderApp();
		const card = screen.getByRole("link", { name: "Fix login redirect" });
		card.focus();
		await go("#B1");
		const dialog = await screen.findByRole("dialog", { name: "Fix login redirect" });
		expect(dialog).toHaveAttribute("aria-modal", "true");
		expect(screen.getByRole("heading", { level: 2, name: "Fix login redirect" })).toHaveFocus();
		expect(document.querySelector(".shell")).toHaveAttribute("inert");
		for (let i = 0; i < 6; i++) await user.tab();
		expect(dialog).toContainElement(document.activeElement as HTMLElement);
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		expect(location.hash).toBe("#board");
		expect(card).toHaveFocus();
	});

	it("explains a missing item instead of failing", async () => {
		renderApp();
		await go("#B99");
		expect(await screen.findByRole("heading", { name: "B99 not found" })).toBeInTheDocument();
	});
});

describe("command palette", () => {
	it("opens with ⌘K, filters items and opens the active one with Enter", async () => {
		const user = userEvent.setup();
		renderApp();
		await user.keyboard("{Meta>}k{/Meta}");
		const input = screen.getByRole("combobox", { name: "Search commands and items" });
		expect(input).toHaveFocus();
		await user.type(input, "slow");
		const options = within(screen.getByRole("listbox", { name: "Results" })).getAllByRole("option");
		expect(options).toHaveLength(1);
		expect(options[0]).toHaveAttribute("aria-selected", "true");
		expect(input).toHaveAttribute("aria-activedescendant", options[0].id);
		await user.keyboard("{Enter}");
		await waitFor(() => expect(location.hash).toBe("#B3"));
		expect(screen.queryByRole("combobox", { name: "Search commands and items" })).not.toBeInTheDocument();
	});

	it("moves the active option with the arrow keys and wraps around", async () => {
		const user = userEvent.setup();
		renderApp();
		await user.click(screen.getByRole("button", { name: /Search or jump to/ }));
		const first = within(screen.getByRole("listbox", { name: "Results" })).getAllByRole("option")[0];
		expect(first).toHaveAttribute("aria-selected", "true");
		await user.keyboard("{ArrowUp}");
		expect(
			within(screen.getByRole("listbox", { name: "Results" }))
				.getAllByRole("option")
				.at(-1),
		).toHaveAttribute("aria-selected", "true");
		await user.keyboard("{ArrowDown}");
		expect(first).toHaveAttribute("aria-selected", "true");
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
	});

	it("ranks label prefixes above references and other matches", () => {
		const commands = ["Profile slow board", "Slow query", "B12"].map((label, i) => ({
			id: String(i),
			label,
			hint: i === 2 ? "slow" : undefined,
			group: "Items" as const,
			run: () => {},
		}));
		expect(rankCommands(commands, "slow").map((command) => command.label)).toEqual([
			"Slow query",
			"B12",
			"Profile slow board",
		]);
	});
});

describe("views", () => {
	it("summarizes attention items in the tab badge and lists the reasons", async () => {
		history.replaceState(null, "", "#attention");
		render(
			<App
				backlog={createBacklogStore({
					...snapshot,
					items: [item("B7", { state: "ongoing", assignee: "ghost", assigneeLive: false })],
				})}
				live={null}
			/>,
		);
		expect(screen.getByTitle("1 need attention")).toHaveTextContent("1");
		expect(screen.getByText(/ghost is not running/)).toBeInTheDocument();
	});

	it("renders the derivation tree with expand and collapse controls", async () => {
		const user = userEvent.setup();
		history.replaceState(null, "", "#tree");
		render(
			<App
				backlog={createBacklogStore({
					...snapshot,
					items: [item("B1", { children: ["B2"] }), item("B2", { parentId: "B1" })],
				})}
				live={null}
			/>,
		);
		const branch = document.querySelector(".tree details") as HTMLDetailsElement;
		expect(branch.open).toBe(true);
		await user.click(screen.getByRole("button", { name: "Collapse all" }));
		expect((document.querySelector(".tree details") as HTMLDetailsElement).open).toBe(false);
	});
});
