import type { LiveExtension } from "./extension.ts";
import { ItemDetail, MissingItem } from "./features/ItemDetail.tsx";
import type { indexBacklog } from "./model/backlog.ts";
import { reportLinkHref } from "./model/reports.ts";
import type { resolveRoute } from "./model/route.ts";
import { navigate } from "./hooks.ts";
import { Button, Skeleton, SkeletonLine } from "./ui/primitives.tsx";
import { Sheet } from "./ui/Sheet.tsx";

/** The item sheet over a view: the editor for a new or edited item, otherwise the item detail. */
export function ItemSheet({
	destination,
	index,
	live,
	editable,
	loaded,
	onClose,
}: {
	destination: Exclude<ReturnType<typeof resolveRoute>, { kind: "view" }>;
	index: ReturnType<typeof indexBacklog>;
	live: LiveExtension | null;
	editable: boolean;
	loaded: boolean;
	onClose: () => void;
}) {
	const item = destination.kind === "item" ? index.byRef.get(destination.ref) : undefined;
	const editing =
		live &&
		editable &&
		(destination.kind === "new" || (item && destination.kind === "item" && destination.mode !== "view"));
	const titleFocus = () => document.getElementById("item-title");
	const fieldFocus = () => document.querySelector<HTMLElement>("#drawer [data-autofocus]");

	if (editing) {
		const correction = destination.kind === "item" && destination.mode === "correct";
		return (
			<Sheet
				labelledBy="editor-title"
				onClose={onClose}
				initialFocus={fieldFocus}
				key={`edit:${item?.ref ?? "new"}:${correction}`}
			>
				<live.Editor
					item={item}
					correction={correction}
					onClose={(ref) => (ref ? navigate(`#${ref}`) : item ? navigate(`#${item.ref}`) : onClose())}
				/>
			</Sheet>
		);
	}
	return (
		<Sheet
			labelledBy="item-title"
			onClose={onClose}
			initialFocus={titleFocus}
			focusKey={`${destination.kind === "item" ? destination.ref : "new"}:${loaded}:${Boolean(item)}`}
		>
			{!loaded ? (
				<div className="sheet-body">
					<Button onClick={onClose}>Close</Button>
					<h2 id="item-title" tabIndex={-1}>
						Loading item…
					</h2>
					<Skeleton label="Loading item details">
						<SkeletonLine />
						<SkeletonLine width="70%" />
					</Skeleton>
				</div>
			) : item ? (
				<ItemDetail
					key={item.ref}
					item={item}
					index={index}
					onClose={onClose}
					actions={
						live ? (
							editable ? (
								<live.ItemActions item={item} />
							) : (
								<p className="muted">
									This board is read-only here. Open the repository's session to edit items or start implementation.
								</p>
							)
						) : undefined
					}
					activity={live && editable ? <live.ItemActivity item={item} /> : undefined}
					tasks={live && editable && item.type !== "epic" ? <live.controls.ItemTasks item={item} /> : undefined}
					reportHref={live ? reportLinkHref : undefined}
				/>
			) : (
				<MissingItem refName={destination.kind === "item" ? destination.ref : "Item"} onClose={onClose} />
			)}
		</Sheet>
	);
}
