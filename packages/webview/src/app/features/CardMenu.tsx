import type { SnapshotItem } from "@octocodeai/octocode-contracts/snapshot";
import { type ComponentType, type CSSProperties, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { isEpic } from "../model/hierarchy.ts";
import { targetTitle, useBoardFlow } from "./board-flow.tsx";
import { currentTarget, type DropTarget } from "./board-dnd.ts";

/** The ⋯ menu of a card: Open, Move to…, Close…, Reopen… (done or closed), Implement and Copy ref. Writes only where the page may write. */
export function CardMenu({
	item,
	ItemAction,
}: {
	item: SnapshotItem;
	ItemAction?: ComponentType<{ item: SnapshotItem }>;
}) {
	const flow = useBoardFlow();
	const [at, setAt] = useState<CSSProperties>();
	const button = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const id = useId();
	const open = at !== undefined;
	function close(refocus = true) {
		setAt(undefined);
		if (refocus) button.current?.focus();
	}
	useEffect(() => {
		if (!open) return;
		const first = menu.current?.querySelector<HTMLElement>("a, button:not(:disabled)");
		first?.focus();
		function outside(event: PointerEvent) {
			if (event.target instanceof Node && !menu.current?.contains(event.target) && event.target !== button.current)
				setAt(undefined);
		}
		// The menu is fixed to where it opened, so it closes instead of detaching when the page or a column scrolls.
		const detach = (event: Event) => {
			if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) setAt(undefined);
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("scroll", detach, true);
		window.addEventListener("resize", detach);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("scroll", detach, true);
			window.removeEventListener("resize", detach);
		};
	}, [open]);
	function toggle() {
		if (open) return close();
		const rect = button.current?.getBoundingClientRect();
		setAt({ top: (rect?.bottom ?? 0) + 4, right: Math.max(8, window.innerWidth - (rect?.right ?? 0)) });
	}
	function keys(event: KeyboardEvent) {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			return close();
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		const stops = [...(menu.current?.querySelectorAll<HTMLElement>("a, button:not(:disabled)") ?? [])];
		const now = stops.indexOf(document.activeElement as HTMLElement);
		const next = (now + (event.key === "ArrowDown" ? 1 : -1) + stops.length) % stops.length;
		stops[next]?.focus();
	}
	const run = (action: () => void) => () => {
		// Focus goes back to the ⋯ button first, so a dialog the action opens returns focus there.
		close();
		action();
	};
	const epic = isEpic(item);
	const here = currentTarget(item);
	const moves: DropTarget[] = flow.targets.filter((target) => target !== "closed" && target !== here);
	const copy = () =>
		navigator.clipboard
			? navigator.clipboard.writeText(item.ref).then(
					() => flow.notify(`Copied ${item.ref}`),
					(error: unknown) => flow.notify(`Could not copy ${item.ref}: ${String(error)}`, "error"),
				)
			: flow.notify("Copying needs a secure page.", "error");
	return (
		<div className="card-menu">
			<button
				ref={button}
				type="button"
				className="card-menu-button"
				aria-label={`Actions for ${item.ref}`}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				onClick={toggle}
			>
				<span aria-hidden="true">⋯</span>
			</button>
			{open && (
				<div
					ref={menu}
					id={id}
					className="menu"
					role="menu"
					tabIndex={-1}
					style={at}
					onKeyDown={keys}
					aria-label={`${item.ref} actions`}
				>
					<a role="menuitem" href={`#${item.ref}`} onClick={() => close(false)}>
						Open
					</a>
					{flow.actions && epic && (
						<span role="menuitem" aria-disabled="true" className="menu-note">
							State follows children
						</span>
					)}
					{flow.actions &&
						!epic &&
						moves.map((target) => (
							<button key={target} type="button" role="menuitem" onClick={run(() => flow.request(item, target))}>
								Move to {targetTitle(target)}
							</button>
						))}
					{flow.actions && !epic && item.state !== "done" && (
						<button type="button" role="menuitem" onClick={run(() => flow.closeItem(item))}>
							Close…
						</button>
					)}
					{flow.actions && !epic && item.state === "done" && (
						<button type="button" role="menuitem" onClick={run(() => flow.reopen(item))}>
							Reopen…
						</button>
					)}
					{ItemAction && item.state !== "done" && (
						<div role="none" className="menu-action">
							<ItemAction item={item} />
						</div>
					)}
					<button type="button" role="menuitem" onClick={run(() => void copy())}>
						Copy ref
					</button>
				</div>
			)}
		</div>
	);
}
