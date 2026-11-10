import { normalizeToLF } from "../../../core/tools/edit-diff.ts";

/** One edit of the file tool to a whole-read file: lines up to `kept` stayed, lines after `tail` moved by `delta`, the rest was replaced. */
export interface OwnEdit {
	from: string;
	to: string;
	kept: number;
	tail: number;
	delta: number;
}

/** A source's lines as anchors count them: without a BOM, LF endings, no empty line after the final newline. */
function sourceLines(text: string): string[] {
	const normalized = normalizeToLF(text.startsWith("\ufeff") ? text.slice(1) : text);
	const lines = normalized.split("\n");
	if (normalized.endsWith("\n")) lines.pop();
	return lines;
}

/** The line map of an edit from `from` (bytes `before`) to `to` (text `after`): its unchanged head and tail. */
export function ownEdit(from: string, to: string, before: Buffer, after: string): OwnEdit {
	const old = sourceLines(before.toString("utf8"));
	const now = sourceLines(after);
	const shortest = Math.min(old.length, now.length);
	let kept = 0;
	while (kept < shortest && old[kept] === now[kept]) kept++;
	let same = 0;
	while (same < shortest - kept && old[old.length - 1 - same] === now[now.length - 1 - same]) same++;
	return { from, to, kept, tail: old.length - same, delta: now.length - old.length };
}

/** Per canonical path, the file tool's own edits since its last whole read, oldest first. */
export class OwnEdits {
	readonly #chains = new Map<string, OwnEdit[]>();

	/** Where `line` of the version `digest` is now; undefined when that version is not in the chain or the line was replaced. */
	line(real: string, digest: string, line: number): number | undefined {
		const chain = this.#chains.get(real) ?? [];
		const start = chain.findIndex((edit) => edit.from === digest);
		if (start < 0) return undefined;
		let at = line;
		for (const edit of chain.slice(start)) {
			if (at > edit.kept && at <= edit.tail) return undefined;
			if (at > edit.tail) at += edit.delta;
		}
		return at;
	}

	/** The chain before a change, to pass back to `extend`. */
	take(real: string): OwnEdit[] | undefined {
		const chain = this.#chains.get(real);
		this.#chains.delete(real);
		return chain;
	}

	/** Append `link` to `chain` (from `take`), starting over when it does not continue from the chain's last version. */
	extend(real: string, chain: OwnEdit[] | undefined, link: OwnEdit): void {
		this.#chains.set(real, [...(chain?.at(-1)?.to === link.from ? chain : []), link].slice(-32));
	}

	delete(real: string): void {
		this.#chains.delete(real);
	}

	clear(): void {
		this.#chains.clear();
	}
}
