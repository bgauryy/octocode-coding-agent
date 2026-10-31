import type { Snapshot, SnapshotItem } from "@octocodeai/octocode-contracts/snapshot";
import type { ComponentType, ReactNode } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { BacklogIndex } from "./model/backlog.ts";
import type { Params } from "./model/route.ts";
import type { IconProps } from "./ui/icons.tsx";

interface BacklogState {
	snapshot: Snapshot;
	/** False while a live page waits for its first snapshot: the embedded one is an empty placeholder. */
	loaded: boolean;
	setSnapshot: (snapshot: Snapshot) => void;
}
export type BacklogStore = StoreApi<BacklogState>;
export function createBacklogStore(snapshot: Snapshot, loaded = true): BacklogStore {
	return createStore<BacklogState>()((set) => ({
		snapshot,
		loaded,
		setSnapshot: (next) => set({ snapshot: next, loaded: true }),
	}));
}

/** Views are controlled: their filters live in the URL hash, so links, reloads and the back button restore them. */
export interface ViewProps {
	index: BacklogIndex;
	params: Params;
	setParams: (params: Params) => void;
	/** Optional authenticated action; static exports keep cards read-only. */
	ItemAction?: ComponentType<{ item: SnapshotItem }>;
}
export interface ViewDefinition {
	name: string;
	label: string;
	Icon: ComponentType<IconProps>;
	Component: ComponentType<ViewProps>;
}

export interface EditorProps {
	item?: SnapshotItem;
	correction: boolean;
	/** Close the editor; with a ref, open that item. */
	onClose: (ref?: string) => void;
}

/**
 * Everything that needs the authenticated local server. The offline export replaces this module with `null` at build
 * time, so it ships no transport, Markdown renderer or editor.
 */
export interface LiveExtension {
	/** The host refuses writes on this page (a daemon repository scope): offer no edit, comment or Implement control. */
	readOnly?: boolean;
	/** Moves a launch token from the URL into session storage and returns the current one. */
	takeAccess(): string;
	views: readonly ViewDefinition[];
	Provider: ComponentType<{ access: string; backlog: BacklogStore; children: ReactNode }>;
	ConnectionStatus: ComponentType;
	ItemActions: ComponentType<{ item: SnapshotItem }>;
	ItemQuickAction?: ComponentType<{ item: SnapshotItem }>;
	ItemActivity: ComponentType<{ item: SnapshotItem }>;
	Editor: ComponentType<EditorProps>;
	RichText: ComponentType<{ text: string }>;
}
