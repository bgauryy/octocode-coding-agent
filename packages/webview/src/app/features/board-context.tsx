import type { SnapshotItem, State } from "@octocodeai/octocode-contracts/snapshot";
import type { Slot } from "./board-slot.ts";
import { type ComponentType, createContext, useContext } from "react";

/** What a live, editable page lets the board do. Absent in static exports and read-only pages: the board then draws no write control. */
export interface BoardActions {
	/** `item.state`; a note is required by the host when reopening. Rejects with the host's one-line refusal. */
	move(item: SnapshotItem, state: State, note?: string): Promise<{ refreshed: boolean; version?: number }>;
	/** `item.rank`: puts the card between two cards of its column; `version` is the one the card has now (after a move). */
	rank(item: SnapshotItem, slot: Slot, version?: number): Promise<{ refreshed: boolean }>;
	/** Adds an item with only a title. */
	add(title: string, state: State): Promise<{ refreshed: boolean }>;
	/** The Close form as a dialog; `onClosed` runs after the host accepted and the board reloaded. */
	CloseDialog: ComponentType<{ item: SnapshotItem; onClose: () => void; onClosed: (refreshed: boolean) => void }>;
}

const BoardActionsContext = createContext<BoardActions | undefined>(undefined);
export const BoardActionsProvider = BoardActionsContext.Provider;
export function useBoardActions(): BoardActions | undefined {
	return useContext(BoardActionsContext);
}
