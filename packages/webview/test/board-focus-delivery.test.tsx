/** @vitest-environment jsdom */
import type { SnapshotItem } from "@octocodeai/octocode-contracts/snapshot";
import { act, render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BoardCard } from "../src/app/features/BoardCard.tsx";
import { BoardActionsProvider, type BoardActions } from "../src/app/features/board-context.tsx";
import { BoardScope, type BoardFlow, useBoardFlow } from "../src/app/features/board-flow.tsx";
import type { BacklogIndex } from "../src/app/model/backlog.ts";
import { snapshotItem } from "./helpers.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const item = snapshotItem("B2", { title: "Ready work", state: "todo", goal: "g", why: "w" });

function fixture(initialItems: SnapshotItem[] = [item], states: BacklogIndex["states"] = ["backlog", "todo"]) {
	let flow: BoardFlow;
	const resolutions = new Map<string, (result: { refreshed: boolean }) => void>();
	const requests: NonNullable<BoardFlow["focusRequest"]>[] = [];
	const operation = (card: SnapshotItem) =>
		new Promise<{ refreshed: boolean }>((resolve) => {
			resolutions.set(card.ref, resolve);
		});
	const move = vi.fn(operation);
	const rank = vi.fn(operation);
	const actions: BoardActions = { move, rank, add: vi.fn(), CloseDialog: () => null };
	function Cards({ items, visible }: { items: SnapshotItem[]; visible: boolean }) {
		const current = useBoardFlow();
		useLayoutEffect(() => {
			flow = current;
			if (current.focusRequest && requests.at(-1)?.id !== current.focusRequest.id) requests.push(current.focusRequest);
		}, [current]);
		return (
			<>
				<button>Outside card</button>
				{["backlog", "todo"].map((state) => (
					<section key={state}>
						{visible &&
							items
								.filter((card) => current.shownIn(card) === state)
								.map((card) => <BoardCard key={card.ref} item={card} childrenDone={0} />)}
					</section>
				))}
			</>
		);
	}
	function tree(items: SnapshotItem[] = initialItems, visible = true) {
		const index: BacklogIndex = {
			repo: "repo",
			now: 0,
			idleMs: 1000,
			states,
			items,
			byRef: new Map(items.map((card) => [card.ref, card])),
			sessionTasks: [],
		};
		return (
			<BoardActionsProvider value={actions}>
				<BoardScope index={index} controls={undefined}>
					<Cards items={items} visible={visible} />
				</BoardScope>
			</BoardActionsProvider>
		);
	}
	const view = render(tree());
	const drop = (card = item, delta: -1 | 0 | 1 = -1) => {
		act(() => flow.lift(card));
		if (delta) act(() => flow.stepLift(delta));
		act(() => flow.dropLift());
	};
	const settleBeforeCommit = async (card = item, beforeCommit?: () => void) => {
		await act(async () => {
			resolutions.get(card.ref)!({ refreshed: true });
			await Promise.resolve();
			beforeCommit?.();
			vi.runOnlyPendingTimers();
		});
	};
	return { view, tree, drop, settleBeforeCommit, move, rank, requests, current: () => flow };
}

it("delivers keyboard drop focus even when zero-delay timers run before the next commit", async () => {
	const { drop, settleBeforeCommit, move } = fixture();
	act(() => screen.getByRole("link", { name: "Ready work" }).focus());
	drop();
	expect(move).toHaveBeenCalledOnce();
	await settleBeforeCommit();
	expect(screen.getByRole("link", { name: "Ready work" })).toHaveFocus();
});

it("does not let an old delivery acknowledgement clear a newer request for the same card", async () => {
	const { drop, settleBeforeCommit, requests, current } = fixture();
	drop();
	await settleBeforeCommit();
	const previous = requests[0].id;
	drop();
	await settleBeforeCommit(item, () => current().consumeFocus(previous));
	expect(requests.at(-1)?.id).toBeGreaterThan(previous);
	expect(screen.getByRole("link", { name: "Ready work" })).toHaveFocus();
});

it.each(["older first", "newer first"])(
	"only restores the latest keyboard operation when results settle %s",
	async (order) => {
		const other = snapshotItem("B3", { title: "Other work", state: "todo", goal: "g", why: "w" });
		const { drop, settleBeforeCommit } = fixture([item, other]);
		drop(item);
		drop(other);
		const outside = screen.getByRole("button", { name: "Outside card" });
		act(() => outside.focus());
		if (order === "older first") {
			await settleBeforeCommit(item);
			expect(outside).toHaveFocus();
			await settleBeforeCommit(other);
		} else {
			await settleBeforeCommit(other);
			await settleBeforeCommit(item);
		}
		expect(screen.getByRole("link", { name: "Other work" })).toHaveFocus();
	},
);

it.each(["filtered", "deleted"])("expires a request for a %s card before it appears again", async (kind) => {
	const { view, tree, drop, settleBeforeCommit } = fixture();
	drop();
	view.rerender(tree(kind === "deleted" ? [] : [item], false));
	const outside = screen.getByRole("button", { name: "Outside card" });
	act(() => outside.focus());
	await settleBeforeCommit();
	view.rerender(tree());
	expect(outside).toHaveFocus();
});

it("does not deliver pending focus after the board unmounts", async () => {
	const { view, drop, settleBeforeCommit } = fixture();
	drop();
	view.unmount();
	const outside = document.createElement("button");
	document.body.append(outside);
	outside.focus();
	await settleBeforeCommit();
	expect(outside).toHaveFocus();
	outside.remove();
});

it("clears an unchanged keyboard drop before a later mouse operation", async () => {
	const { drop, current, move, settleBeforeCommit } = fixture();
	drop(item, 0);
	expect(move).not.toHaveBeenCalled();
	const outside = screen.getByRole("button", { name: "Outside card" });
	act(() => outside.focus());
	act(() => current().request(item, "backlog"));
	await settleBeforeCommit();
	expect(outside).toHaveFocus();
});

it("consumes a keyboard reorder before a later mouse move", async () => {
	const other = snapshotItem("B3", { title: "Other work", state: "todo" });
	const { current, rank, settleBeforeCommit } = fixture([item, other]);
	act(() => current().publish("todo", [item.ref, other.ref]));
	act(() => current().lift(item));
	act(() => current().moveLift(1));
	act(() => current().dropLift());
	expect(rank).toHaveBeenCalledOnce();
	await settleBeforeCommit();
	const outside = screen.getByRole("button", { name: "Outside card" });
	act(() => outside.focus());
	act(() => current().request(item, "backlog"));
	await settleBeforeCommit();
	expect(outside).toHaveFocus();
});

it.each(["completion", "closed"])("does not retain keyboard focus intent after %s", async (kind) => {
	const { drop, current, move, settleBeforeCommit } = fixture(
		[item],
		kind === "completion" ? ["backlog", "todo", "done"] : ["backlog", "todo"],
	);
	drop(item, 1);
	expect(move).not.toHaveBeenCalled();
	if (kind === "completion") expect(location.hash).toBe("#B2/edit");
	else {
		expect(current().dialog?.kind).toBe("close");
		act(() => current().closed(item, true));
	}
	const outside = screen.getByRole("button", { name: "Outside card" });
	act(() => outside.focus());
	act(() => {
		if (kind === "closed") current().toast?.undo?.run();
		else current().request(item, "backlog");
	});
	expect(move).toHaveBeenCalledOnce();
	await settleBeforeCommit();
	expect(outside).toHaveFocus();
});
