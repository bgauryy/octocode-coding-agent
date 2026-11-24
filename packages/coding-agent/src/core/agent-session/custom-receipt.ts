import type { CustomMessage } from "../messages.ts";
import type { SessionManagerApi } from "../session-manager/api.ts";
import type { EntryReceipt } from "../session-manager/entry-receipt.ts";

// A callback belongs to the local send. Only the entry ID goes on disk.
const receipts = new WeakMap<object, EntryReceipt>();

export function attachCustomReceipt(message: object, receipt: EntryReceipt): void {
	receipts.set(message, receipt);
}

export function carryCustomReceipt(from: object, to: CustomMessage): void {
	const receipt = receipts.get(from);
	if (receipt) receipts.set(to, receipt);
}

/** Both immediate and queued delivery acknowledge at the same transcript append, before any model outcome. */
export function recordCustomMessage(
	manager: Pick<SessionManagerApi, "appendCustomMessageEntry">,
	message: CustomMessage,
): string {
	const receipt = receipts.get(message);
	const id = manager.appendCustomMessageEntry(
		message.customType,
		message.content,
		message.display,
		message.details,
		message.timestamp,
		receipt,
	);
	receipts.delete(message);
	return id;
}
