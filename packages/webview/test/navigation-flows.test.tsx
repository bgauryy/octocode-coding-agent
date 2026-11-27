/** @vitest-environment jsdom */
import type { Snapshot } from "@octocodeai/octocode-contracts/snapshot";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { createBacklogStore } from "../src/app/extension.ts";
import { CommandPalette } from "../src/app/features/CommandPalette.tsx";
import { buildTree, cycleTime, indexBacklog } from "../src/app/model/backlog.ts";
import { Sheet } from "../src/app/ui/Sheet.tsx";
import { snapshotItem } from "./helpers.ts";

const snapshot: Snapshot = {
	repo: "repo",
	generatedAt: 1000,
	states: ["backlog", "todo", "ongoing", "done"],
	idleMs: 100_000,
	items: [
		snapshotItem("B1", { title: "Parent task", children: ["B2"], createdAt: 1 }),
		snapshotItem("B2", { title: "Child task", parentId: "B1", createdAt: 2 }),
	],
};
beforeEach(() => history.replaceState(null, "", "#board"));

describe("navigation and focus", () => {
	it("shows a loading item for a deep link until the first snapshot then focuses the loaded title", async () => {
		history.replaceState(null, "", "#B1");
		const store = createBacklogStore({ ...snapshot, items: [] }, false);
		render(<App backlog={store} live={null} />);
		expect(screen.getByRole("dialog", { name: "Loading item…" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
		expect(screen.queryByText("B1 not found")).not.toBeInTheDocument();
		act(() => store.getState().setSnapshot(snapshot));
		expect(screen.getByRole("heading", { level: 2, name: "Parent task" })).toHaveFocus();
	});

	it("focuses the next related item's heading without losing the original board opener", async () => {
		const user = userEvent.setup();
		render(<App backlog={createBacklogStore(snapshot)} live={null} />);
		const opener = screen.getByRole("link", { name: "Parent task" });
		await user.click(opener);
		const parent = await screen.findByRole("dialog", { name: "Parent task" });
		await user.click(within(parent).getByRole("link", { name: "Child task" }));
		expect(await screen.findByRole("heading", { level: 2, name: "Child task" })).toHaveFocus();
		await user.keyboard("{Escape}");
		await waitFor(() => expect(opener).toHaveFocus());
	});

	it("keeps a replacement sheet's initial focus and makes lower modal layers inert", async () => {
		const { rerender } = render(
			<Sheet key="one" label="One" onClose={() => {}}>
				<button type="button">First</button>
			</Sheet>,
		);
		rerender(
			<Sheet key="two" label="Two" initialFocus={() => document.getElementById("edit-title")} onClose={() => {}}>
				<input id="edit-title" aria-label="Edit title" />
			</Sheet>,
		);
		await waitFor(() => expect(screen.getByRole("textbox", { name: "Edit title" })).toHaveFocus());
		rerender(
			<>
				<Sheet key="two" label="Two" onClose={() => {}}>
					<input aria-label="Edit title" />
				</Sheet>
				<Sheet label="Top" onClose={() => {}}>
					<button type="button">Top button</button>
				</Sheet>
			</>,
		);
		expect(screen.getByRole("dialog", { name: "Two", hidden: true })).toHaveAttribute("inert");
		expect(screen.getByRole("dialog", { name: "Top" })).not.toHaveAttribute("inert");
	});

	it("does not dismiss or execute a command while an IME composition is active", () => {
		const close = vi.fn();
		const run = vi.fn();
		render(<CommandPalette commands={[{ id: "run", label: "Run", group: "Actions", run }]} onClose={close} />);
		const input = screen.getByRole("combobox", { name: "Search commands and items" });
		fireEvent.keyDown(input, { key: "Enter", isComposing: true });
		fireEvent.keyDown(input, { key: "Escape", isComposing: true });
		expect(run).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
		fireEvent.keyDown(input, { key: "Enter" });
		expect(run).toHaveBeenCalledOnce();
	});
});

describe("secondary views", () => {
	it("keeps canonical comments visible in offline detail without duplicating mirrored notes", async () => {
		history.replaceState(null, "", "#B1");
		const comment = { id: 1, backlogId: "B1", at: 1, author: "sam", text: "Canonical discussion" };
		const note = { at: 1, author: "sam", text: "Canonical discussion", kind: "note" as const };
		const store = createBacklogStore({ ...snapshot, items: [snapshotItem("B1", { comments: [comment] })] });
		render(<App backlog={store} live={null} />);
		expect(screen.getAllByText("Canonical discussion")).toHaveLength(1);
		act(() =>
			store
				.getState()
				.setSnapshot({ ...snapshot, items: [snapshotItem("B1", { comments: [comment], notes: [note] })] }),
		);
		expect(screen.getAllByText("Canonical discussion")).toHaveLength(1);
	});

	it("uses the requested table column's default sort and clears all filters without losing it", async () => {
		const user = userEvent.setup();
		history.replaceState(null, "", "#table?sort=created&q=parent");
		render(<App backlog={createBacklogStore(snapshot)} live={null} />);
		expect(screen.getByRole("columnheader", { name: "Created" })).toHaveAttribute("aria-sort", "descending");
		await user.click(screen.getByRole("button", { name: "Clear filters" }));
		expect(location.hash).toBe("#table?sort=created&dir=desc");
		expect(screen.getByRole("searchbox", { name: "Search" })).toHaveFocus();
		expect(within(screen.getAllByRole("row")[1]).getByRole("link", { name: "Child task" })).toBeInTheDocument();
	});

	it("keeps every hierarchy item visible across missing parents and cycles", () => {
		const index = indexBacklog({
			...snapshot,
			items: [
				snapshotItem("B1", { parentId: "B2" }),
				snapshotItem("B2", { parentId: "B1" }),
				snapshotItem("B3", { parentId: "B99" }),
				snapshotItem("B4", { parentId: "B3" }),
				snapshotItem("B5"),
			],
		});
		const tree = buildTree(index);
		const refs: string[] = [];
		const walk = (nodes: typeof tree.roots) => {
			for (const node of nodes) {
				refs.push(node.item.ref);
				walk(node.children);
			}
		};
		walk(tree.roots);
		refs.push(...tree.alone.map((item) => item.ref));
		expect(refs.sort()).toEqual(["B1", "B2", "B3", "B4", "B5"]);
		expect(cycleTime(snapshotItem("B1", { startedAt: 0, doneAt: 10 }))).toBe(10);
	});
});
