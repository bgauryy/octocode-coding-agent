import type { BacklogTask } from "@octocodeai/octocode-contracts/backlogs";
import type { Snapshot, SnapshotItem } from "@octocodeai/octocode-contracts/snapshot";
import type { ComponentType, ReactNode } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { BacklogIndex } from "./model/backlog.ts";
import type { NeedsYou } from "./model/needs-you.ts";
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
	/** Edit controls for the epic → item → task hierarchy; absent in static exports and read-only pages. */
	controls?: HierarchyControls;
}

/** The controls a live, editable page adds to the hierarchy views. The host still refuses what it does not allow. */
export interface HierarchyControls {
	/** In the tree: re-parent an item under an epic, add an item to an epic, add a task to an item. */
	ItemTools: ComponentType<{ item: SnapshotItem; index: BacklogIndex }>;
	/** Change a task's state and move it up or down among its owner's tasks. */
	TaskTools: ComponentType<{ task: BacklogTask; siblings: readonly BacklogTask[] }>;
	/** Gives the board its writes: move, add and the Close dialog. Without it the board is read-only. */
	BoardProvider: ComponentType<{ children: ReactNode }>;
	/** An item's tasks in its detail sheet, with inline add and edit. */
	ItemTasks: ComponentType<{ item: SnapshotItem }>;
	/** Promote a session task to an item or move it under one. */
	SessionTaskTools: ComponentType<{ task: BacklogTask; index: BacklogIndex }>;
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

export type Theme = "system" | "light" | "dark";

/** The host-kept theme choice: browser storage does not survive an app-window launch, so the host holds it. */
export interface ThemePrefs {
	read(access: string): Promise<Theme>;
	save(access: string, theme: Theme): Promise<void>;
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
	/** Reads and saves the theme on the host; the offline page has no such capability and keeps the choice for the visit. */
	themePrefs: ThemePrefs;
	/** The header's notification permission and sound controls; also raises the notifications. Inside `Provider`. */
	Notifications: ComponentType;
	/** What waits on the user in the session; a hook, called inside `Provider`. */
	useNeedsYou: () => NeedsYou | undefined;
	/** The waiting dialog, answerable inline from any view. */
	NeedsYouAnswer: ComponentType<{ needs: NeedsYou; onClose: () => void }>;
	ItemActions: ComponentType<{ item: SnapshotItem }>;
	/** Tree, board and detail edit controls for items and tasks. */
	controls: HierarchyControls;
	ItemQuickAction?: ComponentType<{ item: SnapshotItem }>;
	ItemActivity: ComponentType<{ item: SnapshotItem }>;
	Editor: ComponentType<EditorProps>;
	RichText: ComponentType<{ text: string }>;
}
