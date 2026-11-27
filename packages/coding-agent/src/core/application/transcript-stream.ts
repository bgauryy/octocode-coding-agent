import {
	appendPreviewText,
	applicationContentText,
	applicationMessageText,
	OUTPUT_CHARS,
	type ApplicationContentBlock,
	type ApplicationEvent,
	type ApplicationMessage,
} from "@octocodeai/octocode-contracts";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import type { ApplicationAssets } from "./assets.ts";
import {
	jsonLength,
	listJsonLength,
	recordJsonLength,
	rememberJsonLength,
} from "@octocodeai/octocode-common/json-length";
import { annotations, applyMessageFields } from "./normalize.ts";
import type { StreamHint } from "./service/wire.ts";

/** The largest serialized message the transcript shows inline; a larger one is replaced by its asset. */
const MESSAGE_CHARS = 60000;

/** What one displayed block adds to its message's text: the characters, and their length inside a JSON string. */
const blockTexts = new WeakMap<object, { chars: number; json: number }>();

/**
 * `JSON.stringify(message).length` for a message whose `text` is `applicationMessageText` of its content, without
 * serializing the blocks an update left alone: a block is measured the first time it is seen, and the message's text is
 * the blocks' texts joined by newlines until it is long enough to be shortened, when it is measured itself.
 */
export function messageJsonLength(message: ApplicationMessage): number {
	const content = message.content ?? [];
	let chars = Math.max(0, content.length - 1);
	let text = 2 + 2 * chars;
	for (const block of content) {
		let own = blockTexts.get(block);
		if (!own) {
			const shown = applicationContentText([block]);
			own = { chars: shown.length, json: JSON.stringify(shown).length - 2 };
			blockTexts.set(block, own);
		}
		chars += own.chars;
		text += own.json;
	}
	return recordJsonLength(message, {
		...(message.content ? { content: listJsonLength(content) } : {}),
		text: chars > OUTPUT_CHARS ? (jsonLength(message.text) ?? 0) : text,
	});
}

type StreamedBlock = Extract<ApplicationContentBlock, { type: "text" | "thinking" }>;
const innerJsonLength = (text: string) => JSON.stringify(text).length - 2;
const pairHalf = (code: number) => code >= 0xd800 && code <= 0xdfff;

/**
 * Measure `next`, the displayed `block` after `delta`, for `messageJsonLength`: from `block`'s measure and the delta
 * alone while the text is whole (`block.text + delta`), else from its preview-bounded text once. A surrogate at the seam
 * is measured whole, since JSON escapes a lone half and the parts would not add up.
 */
function measureStreamed(next: StreamedBlock, block: StreamedBlock, delta: string, previewed: boolean): void {
	const own = blockTexts.get(block);
	const seam = pairHalf(block.text.charCodeAt(block.text.length - 1)) || pairHalf(delta.charCodeAt(0));
	const text =
		own && !previewed && !seam
			? { chars: own.chars + delta.length, json: own.json + innerJsonLength(delta) }
			: { chars: next.text.length, json: innerJsonLength(next.text) };
	blockTexts.set(next, text);
	rememberJsonLength(next, recordJsonLength(next, { text: text.json + 2 }));
}

/** Per block of a streaming message: the raw length its display shows, and the raw offset its delivered deltas reach. */
interface BlockLengths {
	shown: (number | undefined)[];
	read: (number | undefined)[];
}

/**
 * The streaming side of a transcript. A text or thinking delta changes one block of the provider's partial message;
 * this extends that block from its displayed text and the delta alone, and the block's whole-text asset by the delta's
 * bytes, so a token costs O(delta) instead of renormalizing and rehashing the message. The provider extends its partial
 * ahead of the updates still queued, so a whole normalize can show text whose deltas arrive later: those deltas leave
 * the display as it is, and appending resumes where it ends. The result equals normalizing the partial message once the
 * deltas it holds are delivered. Any update it cannot follow returns undefined, and the transcript normalizes the message.
 */
export class TranscriptStream {
	/** Raw lengths of each block of a streaming message, by message id: a preview no longer tells them. */
	private readonly lengths = new Map<string, BlockLengths>();
	private readonly assets: ApplicationAssets;
	constructor(assets: ApplicationAssets) {
		this.assets = assets;
	}

	/** Remember the raw lengths behind a streaming message the transcript normalized whole. */
	record(message: ApplicationMessage, hint: StreamHint): void {
		const read = this.lengths.get(message.id)?.read;
		const shown = (message.content ?? []).map((_, index) => hint.rawLength(index));
		this.lengths.set(message.id, {
			shown,
			// A start opens a block at offset 0 whatever the source already holds; any other block is taken as shown.
			read: shown.map((length, index) => (hint.started === index ? 0 : (read?.[index] ?? length))),
		});
	}
	forget(id: string): void {
		this.lengths.delete(id);
	}
	clear(): void {
		this.lengths.clear();
	}

	/**
	 * `previous` with the delta `hint` names applied to `source`; `previous` itself when its display already holds the
	 * delta; or undefined when the update needs a whole normalize.
	 */
	extend(previous: ApplicationMessage | undefined, source: unknown, hint: StreamHint): ApplicationMessage | undefined {
		const append = hint.append;
		const lengths = previous && this.lengths.get(previous.id);
		if (!append?.delta || !lengths) return undefined;
		const read = lengths.read[append.index];
		const next = read !== undefined && hint.appendsAt(read) ? read + append.delta.length : undefined;
		lengths.read[append.index] = next;
		const shown = lengths.shown[append.index];
		if (next === undefined || shown === undefined || !previous.content || previous.full || previous.complete)
			return undefined;
		if (next <= shown) return previous;
		if (read !== shown) return undefined;
		const raw = asRecord(source);
		if (raw.role !== "assistant" || !Array.isArray(raw.content) || raw.content.length !== previous.content.length)
			return undefined;
		const block = previous.content[append.index];
		const rawBlock = asRecord(raw.content[append.index]);
		if ((block?.type !== "text" && block?.type !== "thinking") || rawBlock.type !== block.type) return undefined;
		if (block.type === "thinking" && (block.redacted || rawBlock.redacted === true)) return undefined;
		const shownText = appendPreviewText(block.text, block.full !== undefined, append.delta);
		if (!shownText) return undefined;
		// Built in the key order normalizing gives, so serialized comparisons see equal blocks as equal.
		const full = shownText.previewed ? { full: this.full(block, rawBlock, append.delta, next) } : {};
		const marks = block.type === "text" ? annotations(rawBlock.annotations) : undefined;
		const updated: ApplicationContentBlock =
			block.type === "text"
				? { id: block.id, type: "text", text: shownText.text, ...full, ...(marks ? { annotations: marks } : {}) }
				: { id: block.id, type: "thinking", text: shownText.text, ...full };
		measureStreamed(updated, block, append.delta, shownText.previewed);
		const content = previous.content.map((item, index) => (index === append.index ? updated : item));
		const message: ApplicationMessage = {
			id: previous.id,
			role: previous.role,
			content,
			text: applicationMessageText(content),
			complete: false,
			status: "streaming",
		};
		applyMessageFields({ ...raw, stopReason: "pending" }, message);
		if (messageJsonLength(message) > MESSAGE_CHARS) return undefined;
		message.order = previous.order;
		lengths.shown[append.index] = next;
		return message;
	}

	/** The block's whole-text asset after the delta: appended in place, or written whole once it first needs one. */
	private full(
		block: Extract<ApplicationContentBlock, { type: "text" | "thinking" }>,
		rawBlock: Record<string, unknown>,
		delta: string,
		end: number,
	) {
		const appended = block.full ? this.assets.append(block.id, delta) : undefined;
		if (appended) return appended;
		// The source may already hold later deltas: the asset holds the text up to this one.
		const text = block.type === "thinking" ? rawBlock.thinking : rawBlock.text;
		return this.assets.put(String(text).slice(0, end), "text/plain", "utf8", undefined, block.id);
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
