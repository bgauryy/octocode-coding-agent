import {
	appendPreviewText,
	applicationMessageText,
	type ApplicationContentBlock,
	type ApplicationEvent,
	type ApplicationMessage,
} from "@octocodeai/octocode-contracts";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import type { ApplicationAssets } from "./assets.ts";
import { annotations, applyMessageFields } from "./normalize.ts";
import type { StreamHint } from "./service/wire.ts";

/** The largest serialized message the transcript shows inline; a larger one is replaced by its asset. */
const MESSAGE_CHARS = 60000;

/**
 * The streaming side of a transcript. A text or thinking delta changes one block of the provider's partial message;
 * this extends that block from its displayed text and the delta alone, and the block's whole-text asset by the delta's
 * bytes, so a token costs O(delta) instead of renormalizing and rehashing the message. The result equals normalizing
 * the whole partial message. Any update it cannot follow returns undefined, and the transcript normalizes the message.
 */
export class TranscriptStream {
	/** Raw text length of each block of a streaming message, by message id: a preview no longer tells it. */
	private readonly lengths = new Map<string, (number | undefined)[]>();
	private readonly assets: ApplicationAssets;
	constructor(assets: ApplicationAssets) {
		this.assets = assets;
	}

	/** Remember the raw lengths behind a streaming message the transcript normalized whole. */
	record(message: ApplicationMessage, hint: StreamHint): void {
		this.lengths.set(
			message.id,
			(message.content ?? []).map((_, index) => hint.rawLength(index)),
		);
	}
	forget(id: string): void {
		this.lengths.delete(id);
	}
	clear(): void {
		this.lengths.clear();
	}

	/** `previous` with the delta `hint` names applied to `source`, or undefined when the update needs a whole normalize. */
	extend(previous: ApplicationMessage | undefined, source: unknown, hint: StreamHint): ApplicationMessage | undefined {
		const append = hint.append;
		const lengths = previous && this.lengths.get(previous.id);
		const raw = asRecord(source);
		if (!append?.delta || !previous?.content || !lengths || previous.full || previous.complete) return undefined;
		if (raw.role !== "assistant" || !Array.isArray(raw.content) || raw.content.length !== previous.content.length)
			return undefined;
		const block = previous.content[append.index];
		const rawBlock = asRecord(raw.content[append.index]);
		if ((block?.type !== "text" && block?.type !== "thinking") || rawBlock.type !== block.type) return undefined;
		if (block.type === "thinking" && (block.redacted || rawBlock.redacted === true)) return undefined;
		const length = hint.rawLength(append.index);
		const known = lengths[append.index];
		if (length === undefined || known === undefined || length !== known + append.delta.length) return undefined;
		const shown = appendPreviewText(block.text, block.full !== undefined, append.delta);
		if (!shown) return undefined;
		// Built in the key order normalizing gives, so serialized comparisons see equal blocks as equal.
		const full = shown.previewed ? { full: this.full(block, rawBlock, append.delta) } : {};
		const marks = block.type === "text" ? annotations(rawBlock.annotations) : undefined;
		const next: ApplicationContentBlock =
			block.type === "text"
				? { id: block.id, type: "text", text: shown.text, ...full, ...(marks ? { annotations: marks } : {}) }
				: { id: block.id, type: "thinking", text: shown.text, ...full };
		const content = previous.content.map((item, index) => (index === append.index ? next : item));
		const message: ApplicationMessage = {
			id: previous.id,
			role: previous.role,
			content,
			text: applicationMessageText(content),
			complete: false,
			status: "streaming",
		};
		applyMessageFields({ ...raw, stopReason: "pending" }, message);
		if (JSON.stringify(message).length > MESSAGE_CHARS) return undefined;
		message.order = previous.order;
		lengths[append.index] = length;
		return message;
	}

	/** The block's whole-text asset after the delta: appended in place, or written whole once it first needs one. */
	private full(
		block: Extract<ApplicationContentBlock, { type: "text" | "thinking" }>,
		rawBlock: Record<string, unknown>,
		delta: string,
	) {
		const appended = block.full ? this.assets.append(block.id, delta) : undefined;
		if (appended) return appended;
		const text = block.type === "thinking" ? rawBlock.thinking : rawBlock.text;
		return this.assets.put(String(text), "text/plain", "utf8", undefined, block.id);
	}
}

/** One chunk a view is sent: its end, saying how much of a rare huge chunk it leaves out. The transcript keeps it whole. */
const VIEW_DELTA_CHARS = 64_000;
const viewDelta = (delta: string): string =>
	delta.length <= VIEW_DELTA_CHARS
		? delta
		: `[${delta.length - VIEW_DELTA_CHARS} characters not shown here; the transcript has them]\n${delta.slice(-VIEW_DELTA_CHARS)}`;

/** The display event for a provider update of a streaming message. */
export function messageDelta(message: ApplicationMessage, update: { type: string; delta?: unknown }): ApplicationEvent {
	return {
		type: "message.delta",
		messageId: message.id,
		delta: update.type === "text_delta" && typeof update.delta === "string" ? viewDelta(update.delta) : "",
		text: message.text,
		content: message.content,
		full: message.full,
	};
}

/** Whether a whole normalize after an update other than a text delta left what views show unchanged. */
export function unchangedDisplay(
	previous: ApplicationMessage | undefined,
	message: ApplicationMessage,
	update: { type: string },
): boolean {
	return (
		update.type !== "text_delta" &&
		JSON.stringify(previous?.content) === JSON.stringify(message.content) &&
		JSON.stringify(previous?.full) === JSON.stringify(message.full) &&
		previous?.text === message.text
	);
}
