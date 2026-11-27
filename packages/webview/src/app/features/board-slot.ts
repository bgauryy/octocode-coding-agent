/** A place in a column: the card that ends up directly above (`after`) and directly below (`before`) the moved card. */
export interface Slot {
	after?: string;
	before?: string;
}

/** The slot at `index` among `refs` (the column without the moved card): 0 is the top, `refs.length` the end. */
export function slotFor(refs: readonly string[], index: number): Slot {
	const after = refs[index - 1];
	const before = refs[index];
	return { ...(after === undefined ? {} : { after }), ...(before === undefined ? {} : { before }) };
}

/** The index among `refs` a slot stands for; a slot that names no card of the column is the end. */
export function slotIndex(refs: readonly string[], slot: Slot): number {
	const above = slot.after === undefined ? -1 : refs.indexOf(slot.after);
	if (above >= 0) return above + 1;
	const below = slot.before === undefined ? -1 : refs.indexOf(slot.before);
	return below >= 0 ? below : refs.length;
}

/** `refs` with `ref` taken out and put at `slot`; what a column shows while the move is being saved. */
export function placed(refs: readonly string[], ref: string, slot: Slot): string[] {
	const rest = refs.filter((other) => other !== ref);
	rest.splice(slotIndex(rest, slot), 0, ref);
	return rest;
}

/** Where a drop at height `y` lands in a column: next to the card under the pointer, or at the end below the last card. */
export function slotAtPoint(
	column: Element,
	target: EventTarget | null,
	y: number,
	moved: string,
	refs: readonly string[],
): Slot | undefined {
	const element = target instanceof Element ? target : null;
	const card = element?.closest<HTMLElement>(".card[data-ref]");
	const others = refs.filter((ref) => ref !== moved);
	if (card && column.contains(card)) {
		const ref = card.dataset.ref;
		if (ref === undefined || ref === moved) return undefined;
		const box = card.getBoundingClientRect();
		return slotFor(others, others.indexOf(ref) + (y > box.top + box.height / 2 ? 1 : 0));
	}
	return element?.closest(".column-cards") ? slotFor(others, others.length) : undefined;
}

/** Whether putting `ref` at `slot` leaves the column as it is. */
export function isSamePlace(refs: readonly string[], ref: string, slot: Slot): boolean {
	const others = refs.filter((other) => other !== ref);
	return slotIndex(others, slot) === refs.indexOf(ref);
}
