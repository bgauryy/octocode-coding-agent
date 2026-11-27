import { visibleWidth } from "../../utils/width.ts";
import { wordWrapLine, type TextChunk } from "./word-wrap.ts";

/** Keeps only the current draft's wrapping, shared by painting and cursor navigation. */
export class EditorWrapCache {
	private width = -1;
	private pasteIds = "";
	private entries: Array<{ text: string; chunks: TextChunk[] } | undefined> = [];

	forLines(
		lines: string[],
		width: number,
		pasteIds: Iterable<number>,
		segment: (text: string) => Intl.SegmentData[],
	): (line: string, index: number) => TextChunk[] {
		// Paste IDs affect which marker-shaped text is an atomic segment, including after undo or deletion.
		const ids = [...pasteIds].join(",");
		if (width !== this.width || ids !== this.pasteIds) {
			this.entries = [];
			this.width = width;
			this.pasteIds = ids;
		}
		this.entries.length = lines.length;
		// Empty drafts bypass wrapping in layoutText, so release the preceding line here as well.
		if (lines.length === 1 && lines[0] === "") this.entries[0] = undefined;
		return (line, index) => {
			const cached = this.entries[index];
			if (cached?.text === line) return cached.chunks;
			const chunks =
				visibleWidth(line) <= width
					? [{ text: line, startIndex: 0, endIndex: line.length }]
					: wordWrapLine(line, width, segment(line));
			this.entries[index] = { text: line, chunks };
			return chunks;
		};
	}
}
