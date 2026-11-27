/** @vitest-environment jsdom */
import type { Snapshot } from "@octocodeai/octocode-contracts/snapshot";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { ViewProps } from "../src/app/extension.ts";
import { AttentionView } from "../src/app/features/AttentionView.tsx";
import { BoardView } from "../src/app/features/BoardView.tsx";
import { TableView } from "../src/app/features/TableView.tsx";
import { TreeView } from "../src/app/features/TreeView.tsx";
import { indexBacklog } from "../src/app/model/backlog.ts";
import type { Params } from "../src/app/model/route.ts";
import { snapshotItem } from "./helpers.ts";

const NOW = 10_000_000;
const closed = (kind: "obsolete" | "duplicate" | "wont_do", reason: string, of?: string) => ({
	kind,
	text: reason,
	...(of ? { of } : {}),
	by: "alex",
	at: 1,
});
const snapshot: Snapshot = {
	repo: "repo",
	generatedAt: NOW,
	states: ["backlog", "todo", "ongoing", "done"],
	idleMs: 1000,
	items: [
		snapshotItem("B1", { title: "Open work", state: "todo", updatedAt: NOW }),
		snapshotItem("B2", { title: "Finished work", state: "done", updatedAt: NOW }),
		// Both closed items are old and open-looking enough to show up in Attention if they were not hidden.
		snapshotItem("B3", {
			title: "Dropped idea",
			state: "done",
			closed: closed("wont_do", "Not worth it"),
			updatedAt: 1,
		}),
		snapshotItem("B4", {
			title: "Same as B1",
			state: "done",
			closed: closed("duplicate", "Covered by B1", "B1"),
			updatedAt: 1,
		}),
		snapshotItem("B5", { title: "Stale idle", state: "backlog", updatedAt: 1 }),
	] as Snapshot["items"],
};

function Page({ View, initial = {} }: { View: (props: ViewProps) => React.ReactNode; initial?: Params }) {
	const [params, setParams] = useState<Params>(initial);
	return <View index={indexBacklog(snapshot)} params={params} setParams={setParams} />;
}
const count = (text: string | null) => Number(/^(\d+)/.exec(text ?? "")?.[1]);
const toggle = () => screen.getByRole("button", { name: "Show closed" });

describe("closed items in the list views", () => {
	it("Table hides closed items by default and shows them with a Closed pill", async () => {
		const user = userEvent.setup();
		render(<Page View={TableView} />);
		expect(screen.queryByText("Dropped idea")).toBeNull();
		expect(screen.getByRole("status")).toHaveTextContent("3 items");
		await user.click(toggle());
		const row = screen.getByText("Dropped idea").closest("tr")!;
		expect(within(row).getByText("Closed")).toHaveAttribute("title", expect.stringContaining("Not worth it"));
		expect(within(row).queryByText("Done")).toBeNull();
		const duplicate = within(screen.getByText("Same as B1").closest("tr")!).getByText("Closed");
		expect(duplicate.getAttribute("title")).toMatch(/Duplicate of B1: Covered by B1/);
		// A completed item stays Done.
		expect(within(screen.getByText("Finished work").closest("tr")!).getByText("Done")).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent("5 items");
	});

	it("Tree hides closed items by default and shows them with a Closed pill", async () => {
		const user = userEvent.setup();
		render(<Page View={TreeView} />);
		expect(screen.queryByText("Dropped idea")).toBeNull();
		await user.click(toggle());
		const line = screen.getByText("Dropped idea").closest(".item-line") as HTMLElement;
		expect(within(line).getByText("Closed")).toBeInTheDocument();
		await user.click(toggle());
		expect(screen.queryByText("Dropped idea")).toBeNull();
	});

	it("Attention leaves closed items out unless shown", async () => {
		const user = userEvent.setup();
		render(<Page View={AttentionView} />);
		expect(screen.getByText("Stale idle")).toBeInTheDocument();
		// Closed items are done, so they are never idle; the toggle still appears because some exist.
		await user.click(toggle());
		expect(screen.getByText("Stale idle")).toBeInTheDocument();
		expect(toggle()).toHaveAttribute("aria-pressed", "true");
	});

	it("shows the same count on the board and in the table, hidden or shown", async () => {
		const user = userEvent.setup();
		const board = render(<Page View={BoardView} />);
		const boardCount = () => count(document.querySelector(".result-count")!.textContent);
		const hidden = boardCount();
		board.unmount();
		const table = render(<Page View={TableView} />);
		expect(count(table.container.querySelector(".result-count")!.textContent)).toBe(hidden);
		table.unmount();

		const shownBoard = render(<Page View={BoardView} initial={{ closed: "show" }} />);
		const all = boardCount();
		shownBoard.unmount();
		render(<Page View={TableView} initial={{ closed: "show" }} />);
		expect(count(screen.getByRole("status").textContent)).toBe(all);
		expect(all).toBeGreaterThan(hidden);
		await user.click(toggle());
		expect(count(screen.getByRole("status").textContent)).toBe(hidden);
	});
});
