import { createStore, type StoreApi } from "zustand/vanilla";
import type { ChipParts } from "./mode.ts";

/** The permission chip one session's footer draws; that session's audit trail writes it when the mode or counters change. */
export type ChipStore = StoreApi<{ chip: ChipParts | undefined }>;

/** One store per feature instance, as `runningWorkOf`: a process hosting several sessions keeps each session's chip. */
const stores = new WeakMap<object, ChipStore>();

/** The chip store of the session `owner` (its feature setup) belongs to. */
export function chipOf(owner: object): ChipStore {
	let store = stores.get(owner);
	if (!store) {
		store = createStore<{ chip: ChipParts | undefined }>()(() => ({ chip: undefined }));
		stores.set(owner, store);
	}
	return store;
}

/** Publishes `chip` to `store`; an unchanged chip notifies nobody. */
export function publishChip(store: ChipStore, chip: ChipParts): void {
	const current = store.getState().chip;
	if (current && (Object.keys(chip) as (keyof ChipParts)[]).every((key) => current[key] === chip[key])) return;
	store.setState({ chip });
}
