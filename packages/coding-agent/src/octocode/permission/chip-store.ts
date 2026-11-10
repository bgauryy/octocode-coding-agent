import { createStore } from "zustand/vanilla";
import type { ChipParts } from "./mode.ts";

/** The permission chip the footer draws; the audit trail writes it each time the mode or the action counters change. */
export const chipStore = createStore<{ chip: ChipParts | undefined }>()(() => ({ chip: undefined }));

/** Publishes `chip`; an unchanged chip notifies nobody. */
export function publishChip(chip: ChipParts): void {
	const current = chipStore.getState().chip;
	if (current && (Object.keys(chip) as (keyof ChipParts)[]).every((key) => current[key] === chip[key])) return;
	chipStore.setState({ chip });
}
