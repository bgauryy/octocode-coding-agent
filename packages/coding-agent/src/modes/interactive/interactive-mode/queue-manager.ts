/**
 * Managing queued messages from the chat: one ordered list over the session queue (owned by `AgentSession`) and the
 * compaction queue (held here while compaction runs), the recall-last action, and the `/queue` dialog.
 */

import { getApplicationPort } from "../../../core/application/index.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import type { QueuedInput } from "../../../core/agent-session.ts";
import type { InteractiveModeHost } from "./host.ts";
import type { CompactionQueuedMessage } from "./types.ts";

type QueueManagerHost = Pick<
	InteractiveModeHost,
	| "compactionQueuedMessages"
	| "editor"
	| "session"
	| "showExtensionEditor"
	| "showExtensionSelector"
	| "showStatus"
	| "ui"
	| "updatePendingMessagesDisplay"
>;

/** A queued message from either queue, in delivery order. */
export interface QueueItem {
	mode: "steer" | "followUp";
	text: string;
	imageCount: number;
	/** Queued by an extension rather than typed by the user. */
	extension: boolean;
	/** The session-queue entry, or the compaction-queue entry held by the interface. */
	session?: QueuedInput;
	compaction?: CompactionQueuedMessage;
}

const MODE_LABEL = { steer: "Next turn", followUp: "After run" } as const;

/** Steering before follow-ups; within each, messages already in the session before those held for compaction. */
export function listQueueItems(host: Pick<QueueManagerHost, "compactionQueuedMessages" | "session">): QueueItem[] {
	const items: QueueItem[] = [];
	for (const mode of ["steer", "followUp"] as const) {
		for (const queued of host.session.getQueuedInputs()) {
			if (queued.mode !== mode) continue;
			items.push({
				mode,
				text: queued.text,
				imageCount: queued.imageCount,
				extension: queued.source === "extension",
				session: queued,
			});
		}
		for (const held of host.compactionQueuedMessages) {
			if (held.mode === mode) items.push({ mode, text: held.text, imageCount: 0, extension: false, compaction: held });
		}
	}
	return items;
}

const changed = (host: QueueManagerHost): void => {
	host.updatePendingMessagesDisplay();
	host.ui.requestRender();
};

function takeOut(host: QueueManagerHost, item: QueueItem): boolean {
	if (item.session) {
		return getApplicationPort(host.session).invoke("removeQueuedInput", item.session.id) !== undefined;
	}
	const index = item.compaction ? host.compactionQueuedMessages.indexOf(item.compaction) : -1;
	if (index === -1) return false;
	host.compactionQueuedMessages.splice(index, 1);
	return true;
}

/** Remove a queued message so it is never sent; false when it is no longer queued (delivery has begun). */
export function removeQueueItem(host: QueueManagerHost, item: QueueItem): boolean {
	const removed = takeOut(host, item);
	if (removed) changed(host);
	return removed;
}

/** Replace a queued message's text; empty or whitespace-only text removes it. Attachments stay. */
export function editQueueItem(
	host: QueueManagerHost,
	item: QueueItem,
	text: string,
): "replaced" | "removed" | "missing" {
	let outcome: "replaced" | "removed" | "missing";
	if (item.session) {
		outcome = getApplicationPort(host.session).invoke("replaceQueuedInput", item.session.id, text);
	} else if (!item.compaction || !host.compactionQueuedMessages.includes(item.compaction)) {
		outcome = "missing";
	} else if (!text.trim()) {
		takeOut(host, item);
		outcome = "removed";
	} else {
		item.compaction.text = text;
		outcome = "replaced";
	}
	if (outcome !== "missing") changed(host);
	return outcome;
}

/** Swap a queued message with its neighbour of the same kind and queue; false at either end. */
export function moveQueueItem(host: QueueManagerHost, item: QueueItem, direction: "up" | "down"): boolean {
	let moved = false;
	if (item.session) {
		moved = getApplicationPort(host.session).invoke("moveQueuedInput", item.session.id, direction);
	} else if (item.compaction) {
		const held = host.compactionQueuedMessages;
		const from = held.indexOf(item.compaction);
		const step = direction === "up" ? -1 : 1;
		let to = from + step;
		while (from !== -1 && held[to] && held[to].mode !== item.mode) to += step;
		if (from !== -1 && held[to]) {
			[held[from], held[to]] = [held[to], held[from]];
			moved = true;
		}
	}
	if (moved) changed(host);
	return moved;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Alt+Up: put the last queued message back in the editor, ahead of the current draft, and leave every other queued
 * message queued. A message with attachments stays queued because the editor holds text only.
 */
export function recallLastQueuedMessage(host: QueueManagerHost): boolean {
	const items = listQueueItems(host);
	const last = items.at(-1);
	if (!last) {
		host.showStatus("No queued messages to restore");
		return false;
	}
	if (last.imageCount > 0) {
		host.showStatus(
			`The last queued message has ${plural(last.imageCount, "attachment")}; use /queue to edit or remove it`,
		);
		return false;
	}
	if (!takeOut(host, last)) {
		host.showStatus("The last queued message is already being delivered");
		return false;
	}
	const draft = host.editor.getText();
	host.editor.setText([last.text, draft].filter((part) => part.trim()).join("\n\n"));
	changed(host);
	const remaining = items.length - 1;
	host.showStatus(
		remaining > 0
			? `Restored the last queued message to the editor; ${remaining} still queued`
			: "Restored the queued message to the editor",
	);
	return true;
}

function describe(item: QueueItem, index: number): string {
	const preview = stripAnsi(item.text)
		.replace(/[\r\n\t\u2028\u2029]+/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
		.slice(0, 80);
	const notes = [
		item.extension ? "extension" : "",
		item.imageCount ? plural(item.imageCount, "attachment") : "",
	].filter(Boolean);
	return `${index + 1}. ${MODE_LABEL[item.mode]}: ${preview}${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

const ACTIONS = ["Edit", "Remove", "Move up", "Move down"] as const;
const GONE = "That message is already being delivered; it can no longer be changed";

/**
 * `/queue`: pick a queued message, then edit, remove or move it. The list is rebuilt after every action, so what
 * the dialog shows is what will be sent next. Cancelling an action returns to the list; cancelling the list closes it.
 */
export async function showQueueManager(host: QueueManagerHost): Promise<void> {
	for (;;) {
		const items = listQueueItems(host);
		if (items.length === 0) {
			host.showStatus("No queued messages");
			return;
		}
		const labels = items.map(describe);
		const picked = await host.showExtensionSelector("Queued messages", labels);
		const item = picked === undefined ? undefined : items[labels.indexOf(picked)];
		if (!item) return;
		const action = await host.showExtensionSelector(labels[items.indexOf(item)], [...ACTIONS]);
		if (action === "Edit") {
			const text = await host.showExtensionEditor("Edit queued message", item.text);
			if (text !== undefined && editQueueItem(host, item, text) === "missing") host.showStatus(GONE);
		} else if (action === "Remove") {
			if (!removeQueueItem(host, item)) host.showStatus(GONE);
		} else if (action === "Move up" || action === "Move down") {
			moveQueueItem(host, item, action === "Move up" ? "up" : "down");
		}
	}
}
