/**
 * Operations on queued messages from the chat: one ordered list over the session queue (owned by `AgentSession`) and
 * the compaction queue (held here while compaction runs), the recall-last action, mode switching, and holding a
 * message out of delivery while it is edited. The list UI lives in `queue-list.ts`.
 */

import type { ImageContent } from "@octocodeai/octocode-ai/compat";
import { getApplicationPort } from "../../../core/application/index.ts";
import type { InputSource } from "../../../core/features/index.ts";
import { plural } from "../../../octocode/shared/text.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { QueuedInput } from "../../../core/agent-session.ts";
import { prependToEditorDraft } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";
import type { CompactionQueuedMessage } from "./types.ts";

export type QueueManagerHost = Pick<
	InteractiveModeHost,
	"editor" | "session" | "showError" | "showStatus" | "ui" | "uiStore"
>;

const held = (host: Pick<QueueManagerHost, "uiStore">) => host.uiStore.getState().queue.compaction;
const editHeld = (host: Pick<QueueManagerHost, "uiStore">, edit: (queue: CompactionQueuedMessage[]) => void) =>
	host.uiStore.getState().editHeldMessages(edit);

/** A queued message from either queue, in delivery order. */
export interface QueueItem {
	mode: "steer" | "followUp";
	text: string;
	imageCount: number;
	/** Queued by a feature rather than typed by the user. */
	feature: boolean;
	/** The session-queue entry, or the compaction-queue entry held by the interface. */
	session?: QueuedInput;
	compaction?: CompactionQueuedMessage;
}

/** Steering before follow-ups; within each, messages already in the session before those held for compaction. */
export function listQueueItems(host: Pick<QueueManagerHost, "session" | "uiStore">): QueueItem[] {
	const items: QueueItem[] = [];
	for (const mode of ["steer", "followUp"] as const) {
		for (const queued of host.session.getQueuedInputs()) {
			if (queued.mode !== mode) continue;
			items.push({
				mode,
				text: queued.text,
				imageCount: queued.imageCount,
				feature: queued.source === "feature",
				session: queued,
			});
		}
		for (const message of held(host)) {
			if (message.mode === mode)
				items.push({ mode, text: message.text, imageCount: 0, feature: false, compaction: message });
		}
	}
	return items;
}

function takeOut(host: QueueManagerHost, item: QueueItem): boolean {
	if (item.session) {
		return getApplicationPort(host.session).invoke("removeQueuedInput", item.session.id) !== undefined;
	}
	const index = item.compaction ? held(host).indexOf(item.compaction) : -1;
	if (index === -1) return false;
	editHeld(host, (queue) => void queue.splice(index, 1));
	return true;
}

/** Remove a queued message so it is never sent; false when it is no longer queued (delivery has begun). */
export function removeQueueItem(host: QueueManagerHost, item: QueueItem): boolean {
	const removed = takeOut(host, item);
	return removed;
}

/** Swap a queued message with its neighbour of the same kind and queue; false at either end. */
export function moveQueueItem(host: QueueManagerHost, item: QueueItem, direction: "up" | "down"): boolean {
	let moved = false;
	if (item.session) {
		moved = getApplicationPort(host.session).invoke("moveQueuedInput", item.session.id, direction);
	} else if (item.compaction) {
		const queue = held(host);
		const from = queue.indexOf(item.compaction);
		const step = direction === "up" ? -1 : 1;
		let to = from + step;
		while (from !== -1 && queue[to] && queue[to].mode !== item.mode) to += step;
		if (from !== -1 && queue[to]) {
			editHeld(host, (next) => void ([next[from], next[to]] = [next[to], next[from]]));
			moved = true;
		}
	}
	return moved;
}

/** Next turn ↔ after run: the message goes last among its new kind. False when it is no longer queued. */
export function toggleQueueItemMode(host: QueueManagerHost, item: QueueItem): boolean {
	const mode = item.mode === "steer" ? "followUp" : "steer";
	let switched = false;
	if (item.session) {
		switched = getApplicationPort(host.session).invoke("setQueuedInputMode", item.session.id, mode);
	} else if (item.compaction && takeOut(host, item)) {
		const message = item.compaction;
		editHeld(host, (queue) => {
			message.mode = mode;
			queue.push(message);
		});
		switched = true;
	}
	return switched;
}

/** A queued message taken out of delivery while it is edited. */
export interface HeldQueueItem {
	item: QueueItem;
	/** The session it was queued in; a held message never goes back into another session. */
	owner: QueueManagerHost["session"];
	/** Where a compaction-queue message stood, to put it back there. */
	compactionIndex?: number;
}

/** Take a message out of delivery for editing; undefined when its delivery has already begun. */
export function holdQueueItem(host: QueueManagerHost, item: QueueItem): HeldQueueItem | undefined {
	const owner = host.session;
	if (item.session) {
		if (!getApplicationPort(owner).invoke("holdQueuedInput", item.session.id)) return undefined;
		return { item, owner };
	}
	const compactionIndex = item.compaction ? held(host).indexOf(item.compaction) : -1;
	if (compactionIndex === -1 || !takeOut(host, item)) return undefined;
	return { item, owner, compactionIndex };
}

export type ReleaseOutcome = "queued" | "sent" | "removed" | "missing";

/**
 * Put a held message back in its place, with `text` when it was edited (blank removes it) or unchanged when the edit
 * was cancelled. When its queue can no longer deliver it (the run or compaction ended meanwhile) it is sent now, as it
 * would have been. "missing": the queue was cleared or the session replaced meanwhile, and the queued text was
 * already returned to whoever cleared it.
 */
export function releaseHeldQueueItem(host: QueueManagerHost, heldItem: HeldQueueItem, text?: string): ReleaseOutcome {
	const { item, owner } = heldItem;
	if (host.session !== owner) return "missing";
	if (item.session) {
		const released = getApplicationPort(owner).invoke("releaseQueuedInput", item.session.id, text);
		if (released.outcome === "missing") return "missing";
		if (released.outcome !== "idle") return released.outcome;
		return sendReleased(host, { ...released, expand: false });
	}
	if (!item.compaction) return "missing";
	if (text !== undefined && !text.trim()) return "removed";
	const message = { text: text ?? item.compaction.text, mode: item.mode };
	if (!owner.isCompacting) {
		return sendReleased(host, { ...message, images: [], source: "interactive", expand: true });
	}
	const restored = item.compaction;
	editHeld(host, (queue) => {
		restored.text = message.text;
		queue.splice(Math.min(heldItem.compactionIndex ?? 0, queue.length), 0, restored);
	});
	return "queued";
}

/**
 * Send a released message whose queue has gone: during compaction a text-only message waits in the compaction
 * queue; otherwise it is submitted with its kind, which starts a run or queues into one that began meanwhile. A
 * submission rejected before acceptance returns the text to the editor.
 */
function sendReleased(
	host: QueueManagerHost,
	message: { mode: "steer" | "followUp"; text: string; images: ImageContent[]; source: InputSource; expand: boolean },
): ReleaseOutcome {
	if (host.session.isCompacting && message.images.length === 0) {
		host.uiStore.getState().holdMessage({ text: message.text, mode: message.mode });
		return "queued";
	}
	let accepted = false;
	void getApplicationPort(host.session)
		.invoke("prompt", message.text, {
			images: message.images.length > 0 ? message.images : undefined,
			streamingBehavior: message.mode,
			source: message.source,
			// A compaction-queue message is unsent typed text; a session-queue message already carries its images.
			...(message.expand ? { attachImagePaths: true } : { expandPromptTemplates: false }),
			preflightResult: () => {
				accepted = true;
			},
		})
		.catch((error: unknown) => {
			if (!accepted) {
				prependToEditorDraft(host.editor, message.text);
			}
			const dropped =
				!accepted && message.images.length > 0 ? `; ${plural(message.images.length, "attachment")} dropped` : "";
			host.showError(
				`${accepted ? "Message failed" : `Message was not sent; restored to editor${dropped}`}: ${errorMessage(error)}`,
			);
		});
	return "sent";
}

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
			`The last queued message has ${plural(last.imageCount, "attachment")}; press ↑ in an empty editor to edit or remove it`,
		);
		return false;
	}
	if (!takeOut(host, last)) {
		host.showStatus("The last queued message is already being delivered");
		return false;
	}
	prependToEditorDraft(host.editor, last.text);
	const remaining = items.length - 1;
	host.showStatus(
		remaining > 0
			? `Restored the last queued message to the editor; ${remaining} still queued`
			: "Restored the queued message to the editor",
	);
	return true;
}
