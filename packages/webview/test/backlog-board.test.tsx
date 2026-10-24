/** @vitest-environment jsdom */
import type { Snapshot } from "@octocodeai/octocode-contacts/snapshot";
import { act, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { createBacklogStore } from "../src/app/extension.ts";
import { BoardView } from "../src/app/features/BoardView.tsx";
import { filterBoard, indexBacklog } from "../src/app/model/backlog.ts";
import { readLaunch } from "../src/app/model/route.ts";
import { snapshotItem } from "./helpers.ts";

const snapshot: Snapshot = {
	repo: "product",
	generatedAt: 10_000,
	states: ["backlog", "todo", "ongoing", "done"],
	idleMs: 100_000,
	items: [
		snapshotItem("B1", { title: "Plan search", tags: ["ui"], assignee: "alex", priority: "p2", updatedAt: 9000 }),
		snapshotItem("B2", {
			title: "Fix navigation",
			state: "todo",
			priority: "p0",
			goal: "Keep routes stable",
			why: "Prevent lost work",
			comments: [{ id: 1, backlogId: "B2", author: "sam", text: "Preserve deep links", at: 100 }],
			notes: [
				{ author: "sam", text: "Preserve deep links", at: 100, kind: "note" },
				{ author: "sam", text: "Created", at: 0, kind: "change" },
			],
		}),
		snapshotItem("B3", { title: "Title only", state: "todo" }),
		snapshotItem("B4", { title: "Active task", state: "ongoing", assigneeLive: true }),
		snapshotItem("B5", { title: "Shipped task", state: "done" }),
	],
};

beforeEach(() => history.replaceState(null, "", "#board"));

describe("backlog planning", () => {
	it("opens the planning queue and preserves its filters when an item sheet closes", async () => {
		const user = userEvent.setup();
		render(<App backlog={createBacklogStore(snapshot)} live={null} />);
		await user.click(screen.getByRole("link", { name: "Backlog 3" }));
		expect(await screen.findByRole("heading", { level: 2, name: "Backlog" })).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "Active task" })).not.toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "Shipped task" })).not.toBeInTheDocument();
		await user.selectOptions(screen.getByRole("combobox", { name: "Assignee" }), "alex");
		await user.selectOptions(screen.getByRole("combobox", { name: "Tag" }), "ui");
		expect(location.hash).toBe("#backlog?assignee=alex&tag=ui");
		expect(screen.getByRole("status")).toHaveTextContent("1 of 3 items");
		await user.click(screen.getByRole("link", { name: "Plan search" }));
		expect(await screen.findByRole("dialog", { name: "Plan search" })).toBeInTheDocument();
		await user.keyboard("{Escape}");
		expect(location.hash).toBe("#backlog?assignee=alex&tag=ui");
	});

	it("keeps implementation buttons separate from item detail links", async () => {
		const user = userEvent.setup();
		const implement = vi.fn();
		render(
			<BoardView
				index={indexBacklog(snapshot)}
				params={{}}
				setParams={() => {}}
				ItemAction={({ item }) => (
					<button type="button" onClick={() => implement(item.ref)}>
						Implement {item.ref}
					</button>
				)}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Implement B2" }));
		expect(implement).toHaveBeenCalledWith("B2");
		expect(location.hash).toBe("#board");
		const title = screen.getByRole("link", { name: "Fix navigation" });
		expect(title.querySelector("button")).toBeNull();
		const card = title.closest("article")!;
		expect(within(card).getByTitle("1 comment")).toHaveTextContent("Comments: 1");
	});

	it("filters runnable items and restores priority or recent-update ordering from the URL", async () => {
		const user = userEvent.setup();
		history.replaceState(null, "", "#board?ready=ready");
		render(<App backlog={createBacklogStore(snapshot)} live={null} />);
		expect(screen.getByRole("link", { name: "Fix navigation" })).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "Title only" })).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Clear filters" }));
		await user.selectOptions(screen.getByRole("combobox", { name: "Sort items" }), "updated");
		expect(location.hash).toBe("#board?sort=updated");
		await act(async () => {
			location.hash = "#backlog?sort=updated";
			window.dispatchEvent(new HashChangeEvent("hashchange"));
		});
		expect(screen.getByRole("combobox", { name: "Sort items" })).toHaveValue("updated");
	});

	it("searches canonical comments even without mirrored legacy notes and sorts consistently", () => {
		const index = indexBacklog({ ...snapshot, items: snapshot.items.map((item) => ({ ...item, notes: [] })) });
		expect(filterBoard(index, { q: "deep links" }).map((item) => item.ref)).toEqual(["B2"]);
		expect(filterBoard(index, {}).map((item) => item.ref)).toEqual(["B2", "B1", "B3", "B4", "B5"]);
		expect(filterBoard(index, { sort: "updated" })[0].ref).toBe("B1");
		expect(filterBoard(index, { assignee: "alex", tag: "ui" }).map((item) => item.ref)).toEqual(["B1"]);
		expect(readLaunch("#access=test&view=backlog")).toEqual({ access: "test", hash: "#backlog" });
	});
});
