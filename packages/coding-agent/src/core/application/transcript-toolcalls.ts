import { asRecord } from "@octocodeai/octocode-contracts/guards";

/** Argument text a streamed call may reach while every delta still updates its display. */
const EVERY_DELTA_UNTIL = 8192;
/** Past that, the least new argument text that updates the display again; an eighth of the shown text when larger. */
const MIN_GROWTH = 2048;

interface Seen {
	/** The source's content blocks and each block's `arguments`, as of the last whole normalize. */
	blocks: unknown[];
	args: unknown[];
	/** Argument characters streamed per block: in total, and as of the last whole normalize. */
	streamed: number[];
	shown: number[];
}

/**
 * Bounds the cost of streamed tool-call arguments, which the transcript can only show by normalizing the whole
 * message. A `toolcall_delta` keeps the current display when the source's blocks and their `arguments` are the objects
 * it last normalized (the provider has not reparsed, so a normalize would show the same), or when the call has
 * streamed past 8 KB and grew by less than an eighth since. Total work stays linear in the argument size; the display
 * lags the source by at most that eighth, and every other update, including the call's end, normalizes whole.
 * Arguments mutated in place are therefore shown from the next new object or update.
 */
export class ToolCallStream {
	private readonly seen = new Map<string, Seen>();

	/** Whether this `toolcall_delta` of message `id` may keep its current display instead of a whole normalize. */
	skip(id: string, source: unknown, update: { contentIndex: number; delta: string }): boolean {
		const seen = this.seen.get(id);
		const content = asRecord(source).content;
		if (!seen || !Array.isArray(content)) return false;
		const index = update.contentIndex;
		const streamed = (seen.streamed[index] ?? 0) + update.delta.length;
		seen.streamed[index] = streamed;
		if (
			content.length === seen.blocks.length &&
			content.every((block, i) => block === seen.blocks[i] && asRecord(block).arguments === seen.args[i])
		)
			return true;
		const shown = seen.shown[index] ?? 0;
		return streamed > EVERY_DELTA_UNTIL && streamed - shown < Math.max(MIN_GROWTH, shown / 8);
	}

	/** Remember the source of a streaming message the transcript just normalized whole. */
	record(id: string, source: unknown): void {
		const content = asRecord(source).content;
		if (!Array.isArray(content)) return void this.seen.delete(id);
		const streamed = this.seen.get(id)?.streamed ?? [];
		this.seen.set(id, {
			blocks: [...content],
			args: content.map((block) => asRecord(block).arguments),
			streamed,
			shown: [...streamed],
		});
	}
	forget(id: string): void {
		this.seen.delete(id);
	}
	clear(): void {
		this.seen.clear();
	}
}
