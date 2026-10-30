/**
 * The queued-messages list (Up in an empty editor, or `/queue`): mounts `QueueListComponent` in the editor slot, maps
 * its keys to queue operations, keeps it in step with the queues, and holds a message out of delivery while it is
 * edited so it can be neither delivered mid-edit nor sent twice.
 */

import { plural } from "../../../octocode/shared/render/text.ts";
import { ExtensionEditorComponent } from "../components/extension-editor.ts";
import { type QueueListAction, QueueListComponent, type QueueListRow } from "../components/queue-list.ts";
import type { InteractiveModeHost } from "./host.ts";
import {
	type HeldQueueItem,
	holdQueueItem,
	listQueueItems,
	moveQueueItem,
	type QueueItem,
	type QueueManagerHost,
	releaseHeldQueueItem,
	removeQueueItem,
	toggleQueueItemMode,
} from "./queue-manager.ts";

type QueueListHost = QueueManagerHost & Pick<InteractiveModeHost, "keybindings" | "settingsManager" | "showSelector">;

/** Refresh callbacks of open lists, by host; the pending-messages display calls them on every queue change. */
const openLists = new WeakMap<object, () => void>();

/** Rebuild an open list after the queues changed (delivery, edits elsewhere, compaction flush). */
export function refreshQueueList(host: object): void {
	openLists.get(host)?.();
}

const itemKey = (item: QueueItem): unknown => item.session?.id ?? item.compaction;
const MODE_LABEL = { steer: "Next turn", followUp: "After run" } as const;

function toRow(item: QueueItem): QueueListRow {
	const notes = [item.imageCount ? plural(item.imageCount, "attachment") : "", item.extension ? "extension" : ""];
	return { mode: item.mode, text: item.text, notes: notes.filter(Boolean) };
}

/**
 * Open the list focused on the last (Up) or first (`/queue`) message. Returns false, with a status, when nothing is
 * queued.
 */
export function showQueueManager(host: QueueListHost, focus: "first" | "last" = "first"): boolean {
	let items = listQueueItems(host);
	if (items.length === 0) {
		host.showStatus("No queued messages");
		return false;
	}
	host.showSelector((done) => {
		let held: HeldQueueItem | undefined;
		let closed = false;
		const list = new QueueListComponent(
			(action, index) => act(action, index),
			() => done(),
		);
		/** Rebuild rows, keeping the selection on `key` (the same message) or near its old position. */
		const refresh = (key?: unknown) => {
			if (closed || held) return;
			const previous = items[list.selectedIndex];
			items = listQueueItems(host);
			if (items.length === 0) {
				done();
				return;
			}
			const wanted = key ?? (previous ? itemKey(previous) : undefined);
			const found = items.findIndex((item) => itemKey(item) === wanted);
			list.setRows(items.map(toRow), found === -1 ? list.selectedIndex : found);
			host.ui.requestRender();
		};
		const finishEdit = (text?: string) => {
			const editing = held;
			if (!editing) return;
			held = undefined;
			list.hideEditor();
			const outcome = releaseHeldQueueItem(host, editing, text);
			if (outcome === "removed") host.showStatus("Removed the queued message");
			else if (outcome === "sent") host.showStatus("The run had ended, so the message was sent");
			else if (outcome === "missing") host.showStatus("The queue was cleared while you edited; nothing changed");
			refresh(itemKey(editing.item));
		};
		const edit = (item: QueueItem, number: number) => {
			const taken = holdQueueItem(host, item);
			if (!taken) {
				host.showStatus("That message is already being delivered");
				refresh();
				return;
			}
			held = taken;
			const editor = new ExtensionEditorComponent(
				host.ui,
				host.keybindings,
				`Edit queued message ${number} · ${MODE_LABEL[item.mode]}`,
				item.text,
				(text) => finishEdit(text),
				() => finishEdit(),
				{ description: "Held while you edit, so it is not sent. Empty text removes it." },
				host.settingsManager.getExternalEditorCommand(),
			);
			list.showEditor(editor);
			host.ui.requestRender();
		};
		const act = (action: QueueListAction, index: number) => {
			const item = items[index];
			if (!item) return;
			if (action === "edit") return edit(item, index + 1);
			if (action === "remove") {
				if (!removeQueueItem(host, item)) host.showStatus("That message is already being delivered");
			} else if (action === "toggleMode") {
				toggleQueueItemMode(host, item);
			} else {
				moveQueueItem(host, item, action === "moveUp" ? "up" : "down");
			}
			refresh(action === "remove" ? undefined : itemKey(item));
		};
		list.setRows(items.map(toRow), focus === "last" ? items.length - 1 : 0);
		const onQueueChange = () => refresh();
		openLists.set(host, onQueueChange);
		return {
			component: list,
			focus: list,
			// Closing or being displaced by another dialog mid-edit puts the message back unchanged, so none is lost.
			dispose: () => {
				if (closed) return;
				closed = true;
				finishEdit();
				if (openLists.get(host) === onQueueChange) openLists.delete(host);
			},
		};
	});
	return true;
}
