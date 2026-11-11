import {
	appendPreviewText,
	applicationMessageText,
	type ApplicationContentBlock,
	type ApplicationEvent,
	type ApplicationMessage,
	type ApplicationSnapshot,
} from "@octocodeai/octocode-contracts";
import { redactData } from "../../../../../common/src/sanitize.ts";
import { SecretStream } from "../../../../../common/src/secret-stream.ts";

/**
 * What the transcript knows about a streamed update besides its display event. The provider extends its partial
 * message as pieces arrive, ahead of the updates still waiting to be delivered, so the source can already hold text
 * whose deltas come later: positions are tracked from the deltas themselves, and the source only confirms them.
 */
export interface StreamHint {
	/** The block a text or thinking delta extended, and the raw text it added. */
	append?: { index: number; delta: string };
	/** The block a text or thinking start opened: its deltas begin at raw offset 0. */
	started?: number;
	/** The block whose text is final. */
	ended?: number;
	/** The raw text length of a block of the source message now, later deltas included. */
	rawLength(index: number): number | undefined;
	/** Whether the delta of `append` is the raw text of its block at `offset`. */
	appendsAt(offset: number): boolean;
}

const never = () => false;

/** The hint for a provider update of `source`, the partial message the provider extends in place. */
export function streamHint(
	source: unknown,
	update: { type: string; contentIndex?: number; delta?: string },
): StreamHint {
	const content = (source as { content?: unknown } | undefined)?.content;
	const blocks = Array.isArray(content) ? (content as unknown[]) : undefined;
	const rawText = (index: number) => {
		const block = blocks?.[index] as { type?: unknown; text?: unknown; thinking?: unknown } | undefined;
		const text = block?.type === "thinking" ? block.thinking : block?.text;
		return typeof text === "string" ? text : undefined;
	};
	const rawLength = (index: number) => rawText(index)?.length;
	const index = update.contentIndex;
	if (typeof index !== "number") return { rawLength, appendsAt: never };
	const delta = update.delta;
	if (blocks && typeof delta === "string" && (update.type === "text_delta" || update.type === "thinking_delta")) {
		const appendsAt = (offset: number) => {
			const text = rawText(index);
			return text !== undefined && offset + delta.length <= text.length && text.startsWith(delta, offset);
		};
		return { rawLength, appendsAt, append: { index, delta } };
	}
	if (update.type === "text_start" || update.type === "thinking_start")
		return { rawLength, appendsAt: never, started: index };
	if (update.type === "text_end" || update.type === "thinking_end")
		return { rawLength, appendsAt: never, ended: index };
	return { rawLength, appendsAt: never };
}

/** One streamed block as views hold it: redacted text released so far, in display form. */
interface WireBlock {
	stream: SecretStream;
	/** Raw characters received, held ones included. */
	raw: number;
	text: string;
	previewed: boolean;
}

type Content = ApplicationContentBlock[] | undefined;
/** What following an event returns where sending it would return the event: never sent. */
const FOLLOWED: ApplicationEvent = Object.freeze({ type: "message.delta", messageId: "", delta: "" });
const streamable = (
	block: ApplicationContentBlock | undefined,
): block is Extract<ApplicationContentBlock, { type: "text" | "thinking" }> =>
	block?.type === "text" || (block?.type === "thinking" && !block.redacted);

/**
 * The serialized side of a transcript: redacts each event once and turns text and thinking deltas into append-only
 * deltas that carry only the newly released text. A block is streamed from its start or its first, empty display; the
 * text a piece cannot yet prove free of a credential is held (see `SecretStream`). Snapshots and full updates of a streaming
 * message show each streamed block as views already hold it, so later appends continue it exactly. Anything this
 * cannot follow (a gap in the raw text, held text past its bound, a placeholder for a large message) ends streaming of
 * the block, which then travels whole and redacted as before.
 */
export class ApplicationWire {
	private readonly messages = new Map<string, Map<number, WireBlock>>();

	/** The redacted event to serialize; undefined when it releases nothing a view would show. */
	event(event: ApplicationEvent, hint?: StreamHint): ApplicationEvent | undefined {
		return this.apply(event, hint, true);
	}

	/**
	 * Follow `event` as `event` would, without redacting or building anything to send: no view is connected yet, and a
	 * view that connects later starts from a snapshot that shows the streamed blocks as this state holds them. True when
	 * `event` would have released something.
	 */
	follow(event: ApplicationEvent, hint?: StreamHint): boolean {
		return this.apply(event, hint, false) !== undefined;
	}

	/** The event to send, `FOLLOWED` in its place when not `encode`, or undefined when it releases nothing. */
	private apply(event: ApplicationEvent, hint: StreamHint | undefined, encode: boolean): ApplicationEvent | undefined {
		switch (event.type) {
			case "message.completed":
				this.messages.delete(event.message.id);
				return encode ? redactData(event) : FOLLOWED;
			case "message.started": {
				if (event.message.complete) return encode ? redactData(event) : FOLLOWED;
				const blocks = this.blocks(event.message.id);
				this.sync(blocks, event.message.content, event.message.full !== undefined);
				return encode ? { type: event.type, message: this.show(redactData(event.message), blocks) } : FOLLOWED;
			}
			case "message.delta": {
				const blocks = this.blocks(event.messageId);
				if (hint?.append && !event.full) {
					const append = this.append(event, blocks, hint, encode);
					if (append !== null) return append;
				}
				const ended = hint?.ended === undefined ? undefined : blocks.get(hint.ended);
				if (ended) this.release(ended, ended.stream.flush());
				this.sync(blocks, event.content, event.full !== undefined, hint);
				if (!encode) return FOLLOWED;
				const safe = redactData({ ...event, delta: "" });
				if (!blocks.size || !safe.content) return safe;
				const shown = this.show({ id: event.messageId, text: safe.text ?? "", content: safe.content }, blocks);
				return { ...safe, text: shown.text, content: shown.content };
			}
			case "session.reset": {
				if (!encode) return FOLLOWED;
				const safe = redactData(event);
				return { ...safe, messages: safe.messages.map((message) => this.shown(message)) };
			}
			default:
				return encode ? redactData(event) : FOLLOWED;
		}
	}

	/** A redacted snapshot whose streaming messages show what their appends continue. */
	snapshot(snapshot: ApplicationSnapshot): ApplicationSnapshot {
		const safe = redactData(snapshot);
		return { ...safe, messages: safe.messages.map((message) => this.shown(message)) };
	}

	clear(): void {
		this.messages.clear();
	}

	private blocks(id: string): Map<number, WireBlock> {
		let blocks = this.messages.get(id);
		if (!blocks) this.messages.set(id, (blocks = new Map()));
		return blocks;
	}

	/** An append-only delta, undefined when nothing is released yet, or null when the block cannot stream. */
	private append(
		event: Extract<ApplicationEvent, { type: "message.delta" }>,
		blocks: Map<number, WireBlock>,
		hint: StreamHint,
		encode: boolean,
	): ApplicationEvent | undefined | null {
		const { index, delta } = hint.append!;
		const block = blocks.get(index);
		const display = event.content?.[index];
		if (!block || !streamable(display)) return null;
		// A delta that does not continue what was streamed leaves a gap: the block travels whole from now on.
		if (!hint.appendsAt(block.raw)) {
			blocks.delete(index);
			return null;
		}
		block.raw += delta.length;
		const released = block.stream.push(delta);
		if (released === undefined) return null;
		if (!released) return undefined;
		const length = block.text.length;
		this.release(block, released);
		if (block.previewed && !display.full) return null;
		if (!encode) return FOLLOWED;
		return {
			type: "message.delta",
			messageId: event.messageId,
			delta: released,
			block: { index, length, ...(block.previewed ? { full: redactData(display.full) } : {}) },
		};
	}

	private release(block: WireBlock, text: string): void {
		const next = appendPreviewText(block.text, block.previewed, text)!;
		block.text = next.text;
		block.previewed = next.previewed;
	}

	/**
	 * Follow the display: start streaming empty blocks and blocks a start just opened (their deltas follow from offset 0
	 * whatever the display already shows), and stop where the raw text no longer matches. The source may already hold
	 * deltas still to come, so only raw text shorter than what was streamed is a gap until the block ends.
	 */
	private sync(blocks: Map<number, WireBlock>, content: Content, placeholder: boolean, hint?: StreamHint): void {
		for (const [index, block] of blocks) {
			const raw = hint?.rawLength(index);
			const lost = hint && (raw === undefined || raw < block.raw || (hint.ended === index && raw !== block.raw));
			if (placeholder || !streamable(content?.[index]) || lost) blocks.delete(index);
		}
		if (placeholder) return;
		for (const [index, block] of (content ?? []).entries())
			if (!blocks.has(index) && streamable(block) && ((block.text === "" && !block.full) || hint?.started === index))
				blocks.set(index, { stream: new SecretStream(), raw: 0, text: "", previewed: false });
	}

	private shown(message: ApplicationMessage): ApplicationMessage {
		const blocks = this.messages.get(message.id);
		return blocks?.size && !message.complete && !message.full ? this.show(message, blocks) : message;
	}

	/** A redacted message with each streamed block replaced by what views hold, and its text derived again. */
	private show<T extends Pick<ApplicationMessage, "id" | "text" | "content">>(
		message: T,
		blocks: Map<number, WireBlock>,
	): T {
		if (!message.content || !blocks.size) return message;
		const content = message.content.map((item, index) => {
			const block = blocks.get(index);
			if (!block || !streamable(item)) return item;
			const { full, ...rest } = item;
			return { ...rest, text: block.text, ...(block.previewed && full ? { full } : {}) };
		});
		return { ...message, content, text: applicationMessageText(content) };
	}
}
