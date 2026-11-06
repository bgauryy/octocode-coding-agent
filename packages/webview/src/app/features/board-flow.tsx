import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { SnapshotItem, State } from "@octocodeai/octocode-contracts/snapshot";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { HierarchyControls } from "../extension.ts";
import { navigate } from "../hooks.ts";
import { type BacklogIndex, STATE_TITLES } from "../model/backlog.ts";
import { type BoardActions, useBoardActions } from "./board-context.tsx";
import { currentTarget, type DropTarget, planDrop, stepTarget } from "./board-dnd.ts";
import { isSamePlace, placed, type Slot, slotFor, slotIndex } from "./board-slot.ts";
import type { ToastMessage } from "./Toast.tsx";

type BoardDialog =
	| { kind: "claim"; item: SnapshotItem }
	| { kind: "missing"; item: SnapshotItem; missing: string[] }
	| { kind: "reopen"; item: SnapshotItem; state: State }
	| { kind: "close"; item: SnapshotItem };

export const targetTitle = (target: DropTarget) => (target === "closed" ? "Closed" : STATE_TITLES[target]);

export interface BoardFlow {
	/** Undefined on a read-only page or a static export: no drag, no add, no write entry in a menu. */
	actions: BoardActions | undefined;
	targets: readonly DropTarget[];
	dragging: string | undefined;
	hover: DropTarget | undefined;
	/** Where in the hovered column a dragged card would land; undefined over the column's own background. */
	hoverSlot: Slot | undefined;
	lifted: { ref: string; target: DropTarget; slot?: Slot } | undefined;
	/** A column reports the order it shows, so a drop and the arrow keys know the neighbours. */
	publish(target: DropTarget, refs: readonly string[]): void;
	/** `items` with each card whose reorder is still being saved moved to its new place. */
	arrange(items: SnapshotItem[], target: DropTarget): SnapshotItem[];
	/** Where an item shows, counting a move that is still being saved. */
	shownIn(item: SnapshotItem): DropTarget;
	startDrag(ref: string | undefined): void;
	hoverOver(target: DropTarget | undefined, slot?: Slot): void;
	/** The same path for a mouse drop, a keyboard drop and the menu. */
	request(item: SnapshotItem, target: DropTarget, slot?: Slot): void;
	reopen(item: SnapshotItem): void;
	closeItem(item: SnapshotItem): void;
	lift(item: SnapshotItem): void;
	stepLift(delta: -1 | 1): void;
	/** Up and Down while lifted: the position within the column. */
	moveLift(delta: -1 | 1): void;
	dropLift(): void;
	cancelLift(): void;
	notify(text: string, tone?: ToastMessage["tone"]): void;
	/** Dialog buttons. */
	dialog: BoardDialog | undefined;
	dismissDialog(): void;
	confirmClaim(item: SnapshotItem): void;
	confirmReopen(item: SnapshotItem, state: State, note: string): void;
	closed(item: SnapshotItem, refreshed: boolean): void;
	/** The card to refocus after a keyboard drop re-parents it. */
	focusRef: string | undefined;
	announcement: string;
	toast: ToastMessage | undefined;
	dismissToast(): void;
	find(ref: string): SnapshotItem | undefined;
}

const BoardFlowContext = createContext<BoardFlow | undefined>(undefined);
export function useBoardFlow(): BoardFlow {
	const flow = useContext(BoardFlowContext);
	if (!flow) throw new Error("useBoardFlow needs a BoardFlowProvider");
	return flow;
}

function BoardFlowProvider({ index, children }: { index: BacklogIndex; children: ReactNode }) {
	const actions = useBoardActions();
	const [dragging, startDrag] = useState<string>();
	const [hoverAt, setHoverAt] = useState<{ target: DropTarget; slot?: Slot }>();
	const hoverOver = useCallback((target: DropTarget | undefined, slot?: Slot) => {
		setHoverAt((current) =>
			target === undefined
				? undefined
				: current?.target === target && JSON.stringify(current.slot) === JSON.stringify(slot)
					? current
					: { target, slot },
		);
	}, []);
	const columns = useRef(new Map<DropTarget, readonly string[]>());
	const [lifted, setLifted] = useState<BoardFlow["lifted"]>();
	const [overlay, setOverlay] = useState<Record<string, { target: DropTarget; slot?: Slot }>>({});
	const [dialog, setDialog] = useState<BoardDialog>();
	const [toast, setToast] = useState<ToastMessage>();
	const [announcement, announce] = useState("");
	const [focusRef, setFocusRef] = useState<string>();
	const keyboardDrop = useRef<string | undefined>(undefined);
	const inflight = useRef(new Set<string>());
	const acked = useRef(false);
	const latest = useRef(index);
	const toasts = useRef(0);
	useEffect(() => {
		latest.current = index;
	}, [index]);
	const targets = useMemo<readonly DropTarget[]>(() => [...index.states, "closed"], [index.states]);

	const notify = useCallback((text: string, tone: ToastMessage["tone"] = "info", undo?: ToastMessage["undo"]) => {
		toasts.current += 1;
		setToast({ id: toasts.current, text, tone, undo });
	}, []);

	/**
	 * Optimistic: the card shows in its new column (and place) at once; a refusal puts it back and shows the host's message.
	 * With a `slot` the card is ranked there once the move is saved.
	 */
	const execute = useCallback(
		async (item: SnapshotItem, state: State, note?: string, done?: string, slot?: Slot) => {
			if (!actions || inflight.current.has(item.ref)) return;
			inflight.current.add(item.ref);
			setOverlay((current) => ({ ...current, [item.ref]: { target: state, slot } }));
			try {
				const moved = await actions.move(item, state, note);
				let { refreshed } = moved;
				if (slot) {
					const version = moved.version ?? latest.current.byRef.get(item.ref)?.version;
					({ refreshed } = await actions.rank(item, slot, version));
				}
				announce(`${item.ref} moved to ${STATE_TITLES[state]}`);
				if (!refreshed) notify("Could not refresh the board: reload the page to see the current state.", "error");
				else if (done) notify(done);
			} catch (error) {
				const text = errorMessage(error);
				announce(`${item.ref} could not move: ${text}`);
				notify(text, "error");
			} finally {
				inflight.current.delete(item.ref);
				setOverlay(({ [item.ref]: _settled, ...rest }) => rest);
				if (keyboardDrop.current === item.ref) {
					// A keyboard drop re-parents the card, so focus falls to the page: send it back to the card's title.
					keyboardDrop.current = undefined;
					setFocusRef(item.ref);
					setTimeout(() => setFocusRef(undefined), 0);
				}
			}
		},
		[actions, notify],
	);

	/** Optimistic reorder inside the column the card is in. */
	const reorder = useCallback(
		async (item: SnapshotItem, target: DropTarget, slot: Slot) => {
			if (!actions || inflight.current.has(item.ref)) return;
			inflight.current.add(item.ref);
			setOverlay((current) => ({ ...current, [item.ref]: { target, slot } }));
			try {
				const { refreshed } = await actions.rank(item, slot);
				announce(`${item.ref} reordered in ${targetTitle(target)}`);
				if (!refreshed) notify("Could not refresh the board: reload the page to see the current state.", "error");
			} catch (error) {
				const text = errorMessage(error);
				announce(`${item.ref} could not be reordered: ${text}`);
				notify(text, "error");
			} finally {
				inflight.current.delete(item.ref);
				setOverlay(({ [item.ref]: _settled, ...rest }) => rest);
			}
		},
		[actions, notify],
	);

	const request = useCallback(
		(item: SnapshotItem, target: DropTarget, slot?: Slot) => {
			if (!actions || inflight.current.has(item.ref)) return;
			const plan = planDrop(item, target);
			switch (plan.kind) {
				case "none": {
					const refs = columns.current.get(target);
					if (!slot || target === "closed" || !refs || isSamePlace(refs, item.ref, slot)) return;
					return void reorder(item, target, slot);
				}
				case "refuse":
					announce(plan.reason);
					return notify(plan.reason, "error");
				case "move":
					return void execute(item, plan.state, undefined, undefined, slot);
				case "complete":
					// The host refuses done without a completion: the editor collects it, as the state control did.
					return navigate(`#${item.ref}/edit`);
				case "close":
					return setDialog({ kind: "close", item });
				case "claim":
					if (plan.missing.length) return setDialog({ kind: "missing", item, missing: plan.missing });
					if (!acked.current) return setDialog({ kind: "claim", item });
					return void execute(item, "ongoing", undefined, `${item.ref} is now in progress and assigned to you.`, slot);
				case "reopen":
					if (plan.missing.length) return setDialog({ kind: "missing", item, missing: plan.missing });
					return setDialog({ kind: "reopen", item, state: plan.state });
			}
		},
		[actions, execute, notify, reorder],
	);

	// Stable, so the toast timer is not restarted by every hover or drag.
	const dismissToast = useCallback(() => setToast(undefined), []);
	const flow = useMemo<BoardFlow>(
		() => ({
			actions,
			targets,
			dragging,
			hover: hoverAt?.target,
			hoverSlot: hoverAt?.slot,
			lifted,
			publish: (target, refs) => void columns.current.set(target, refs),
			arrange: (items, target) => {
				let refs = items.map((item) => item.ref);
				const byRef = new Map(items.map((item) => [item.ref, item]));
				for (const [ref, pending] of Object.entries(overlay))
					if (pending.slot && pending.target === target && byRef.has(ref)) refs = placed(refs, ref, pending.slot);
				return refs.map((ref) => byRef.get(ref)!);
			},
			shownIn: (item) => overlay[item.ref]?.target ?? currentTarget(item),
			startDrag,
			hoverOver,
			request,
			reopen: (item) => request(item, item.state === "done" ? "todo" : item.state),
			closeItem: (item) => request(item, "closed"),
			lift: (item) => {
				const target = overlay[item.ref]?.target ?? currentTarget(item);
				setLifted({ ref: item.ref, target });
				announce(
					`Picked up ${item.ref} from ${targetTitle(target)}. Use the left and right arrow keys to choose a column, the up and down arrow keys to choose the position, Space or Enter to drop, Escape to cancel.`,
				);
			},
			stepLift: (delta) => {
				if (!lifted) return;
				const target = stepTarget(targets, lifted.target, delta);
				setLifted({ ref: lifted.ref, target });
				announce(`${targetTitle(target)}, column ${targets.indexOf(target) + 1} of ${targets.length}`);
			},
			moveLift: (delta) => {
				if (!lifted || lifted.target === "closed") return;
				const refs = (columns.current.get(lifted.target) ?? []).filter((ref) => ref !== lifted.ref);
				const own = columns.current.get(lifted.target)?.indexOf(lifted.ref) ?? -1;
				const at = lifted.slot ? slotIndex(refs, lifted.slot) : own < 0 ? refs.length : own;
				const index = Math.min(refs.length, Math.max(0, at + delta));
				setLifted({ ...lifted, slot: slotFor(refs, index) });
				announce(`Position ${index + 1} of ${refs.length + 1} in ${targetTitle(lifted.target)}`);
			},
			dropLift: () => {
				if (!lifted) return;
				const item = latest.current.byRef.get(lifted.ref);
				setLifted(undefined);
				if (!item) return;
				keyboardDrop.current = item.ref;
				announce(`Dropped ${item.ref} on ${targetTitle(lifted.target)}`);
				request(item, lifted.target, lifted.slot);
			},
			cancelLift: () => {
				if (!lifted) return;
				setLifted(undefined);
				announce(`Move of ${lifted.ref} cancelled`);
			},
			notify: (text, tone) => notify(text, tone),
			dialog,
			dismissDialog: () => {
				keyboardDrop.current = undefined;
				setDialog(undefined);
			},
			confirmClaim: (item) => {
				acked.current = true;
				setDialog(undefined);
				void execute(item, "ongoing", undefined, `${item.ref} is now in progress and assigned to you.`);
			},
			confirmReopen: (item, state, note) => {
				if (state === "ongoing") acked.current = true;
				setDialog(undefined);
				void execute(item, state, note, `${item.ref} reopened.`);
			},
			focusRef,
			closed: (item, refreshed) => {
				setDialog(undefined);
				const before: State = item.state === "backlog" ? "backlog" : "todo";
				announce(`${item.ref} closed`);
				// Undo needs the version the close produced; without a refresh it would only hit a conflict.
				if (!refreshed)
					return notify(`${item.ref} closed, but the board could not be refreshed: reload the page.`, "error");
				// Closing releases an ongoing item, so Undo restores To do (or Backlog), not the earlier state.
				notify(`${item.ref} closed`, "info", {
					label: `Undo (back to ${targetTitle(before)})`,
					run: () => {
						const current = latest.current.byRef.get(item.ref);
						if (!current) return notify(`${item.ref} is no longer on the board.`, "error");
						void execute(current, before, "Undo close from the board", `${item.ref} reopened.`);
					},
				});
			},
			announcement,
			toast,
			dismissToast,
			find: (ref) => latest.current.byRef.get(ref),
		}),
		[
			actions,
			targets,
			dragging,
			hoverOver,
			hoverAt,
			lifted,
			overlay,
			request,
			execute,
			notify,
			dialog,
			announcement,
			toast,
			dismissToast,
			focusRef,
		],
	);
	return <BoardFlowContext.Provider value={flow}>{children}</BoardFlowContext.Provider>;
}

/** Gives a view the board's writes (when the page may write) and its one shared flow of drops, dialogs and notices. */
export function BoardScope({
	index,
	controls,
	children,
}: {
	index: BacklogIndex;
	controls: HierarchyControls | undefined;
	children: ReactNode;
}) {
	const scoped = <BoardFlowProvider index={index}>{children}</BoardFlowProvider>;
	// The provider is what gives the board its writes: a page without it draws no drag, add or write menu entry.
	return controls ? <controls.BoardProvider>{scoped}</controls.BoardProvider> : scoped;
}
