import { applicationContentText, type ApplicationAsset } from "./content.ts";
import type { ApplicationMessage } from "./application.ts";

/** Message text keeps this many characters, start and end, around a marker that counts what was left out. */
export const OUTPUT_CHARS = 16_000;
const HEAD_CHARS = 4_000;
/** A content block longer than this shows its start and end; its whole text is a separate asset. */
const PREVIEW_CHARS = 4000;
const PREVIEW_HEAD = 2000;
const PREVIEW_TAIL = 1900;
const PREVIEW_MARKER = "\n… [Full content available]\n";

/**
 * Long output keeps its start (results often open with a summary: a page title, a match count) and its end (where
 * commands report failures), joined by a marker that says how much was left out.
 */
export function keepEnds(text: string, max: number): string {
	if (text.length <= max) return text;
	const marker = (omitted: number) => `\n… [${omitted} characters omitted] …\n`;
	const tail = max - HEAD_CHARS - marker(text.length).length;
	return `${text.slice(0, HEAD_CHARS)}${marker(text.length - HEAD_CHARS - tail)}${text.slice(-tail)}`;
}

/** The displayed form of a content block's text: whole up to the preview size, else its start and end. */
export function previewText(text: string): { text: string; previewed: boolean } {
	if (text.length <= PREVIEW_CHARS) return { text, previewed: false };
	return { text: `${text.slice(0, PREVIEW_HEAD)}${PREVIEW_MARKER}${text.slice(-PREVIEW_TAIL)}`, previewed: true };
}

/** A message's display text, derived from its displayed blocks. */
export function applicationMessageText(content: Parameters<typeof applicationContentText>[0]): string {
	return keepEnds(applicationContentText(content), OUTPUT_CHARS);
}

/**
 * The displayed text after `delta` extends a block whose displayed text is `current`: the same result `previewText`
 * gives for the whole text, computed from the preview alone. Undefined when `current` is not a preview it can extend.
 */
export function appendPreviewText(
	current: string,
	previewed: boolean,
	delta: string,
): { text: string; previewed: boolean } | undefined {
	if (!previewed) return previewText(current + delta);
	const tailStart = PREVIEW_HEAD + PREVIEW_MARKER.length;
	if (current.length !== tailStart + PREVIEW_TAIL || current.slice(PREVIEW_HEAD, tailStart) !== PREVIEW_MARKER)
		return undefined;
	return { text: current.slice(0, tailStart) + (current.slice(tailStart) + delta).slice(-PREVIEW_TAIL), previewed };
}

/** How an append-only `message.delta` extends one text or thinking block. */
export interface ApplicationBlockAppend {
	/** The block's position in `content`. */
	index: number;
	/** The block's displayed text length before the append; a different length means the view must resynchronize. */
	length: number;
	/** The block's whole-text asset once its displayed text is a preview. */
	full?: ApplicationAsset;
}

/**
 * Apply an append-only delta to a message: extend the block, keep the preview rule, and derive the message text.
 * Undefined when the message does not hold the block in the state the sender assumed.
 */
export function appendApplicationMessage(
	message: ApplicationMessage,
	append: ApplicationBlockAppend,
	delta: string,
): ApplicationMessage | undefined {
	const block = message.content?.[append.index];
	if (message.full || !block || (block.type !== "text" && block.type !== "thinking")) return undefined;
	if ((block.type === "thinking" && block.redacted) || block.text.length !== append.length) return undefined;
	const result = appendPreviewText(block.text, block.full !== undefined, delta);
	if (!result || (result.previewed && !append.full)) return undefined;
	const { full: _full, ...rest } = block;
	const next = { ...rest, text: result.text, ...(result.previewed ? { full: append.full } : {}) };
	const content = message.content!.map((item, index) => (index === append.index ? next : item));
	return { ...message, content, text: applicationMessageText(content) };
}
