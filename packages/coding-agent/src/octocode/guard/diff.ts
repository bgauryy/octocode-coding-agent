import { lineChanges } from "../../core/tools/edit-diff/line-changes.ts";
import { visible } from "./visible.ts";
import type { ItemFile, StoredFile } from "./types.ts";

/**
 * What changed in an approved item since the approval. An approval stores the files it covered (`snapshotOf`), so a
 * later change can be shown line by line. Content that is too large or binary is not stored: the diff says so
 * rather than guessing.
 */

const MAX_FILE = 64 * 1024;
const MAX_TOTAL = 512 * 1024;
const MAX_LINES = 120;

/** The JSON the store keeps for an approval of `files`. */
export function snapshotOf(files: readonly ItemFile[]): string {
	let total = 0;
	const stored = files.map((file): StoredFile => {
		const size = file.text.length;
		if (file.bytes || size > MAX_FILE || total + size > MAX_TOTAL) return { name: file.name, omitted: true };
		total += size;
		return { name: file.name, text: file.text };
	});
	return JSON.stringify(stored);
}

/** Reads a stored snapshot; undefined when the text is not one (the item then shows no diff). */
export function parseSnapshot(text: string): StoredFile[] | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!Array.isArray(value)) return undefined;
	const files: StoredFile[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null || typeof (entry as StoredFile).name !== "string") return undefined;
		const { name, text: body } = entry as StoredFile;
		files.push(typeof body === "string" ? { name, text: body } : { name, omitted: true });
	}
	return files;
}

function fileDiff(name: string, before: string, after: string): string[] {
	const lines: string[] = [];
	for (const part of lineChanges(before, after)) {
		if (!part.added && !part.removed) continue;
		for (const line of part.value.replace(/\n$/, "").split("\n"))
			lines.push(`${part.added ? "+" : "-"} ${visible(line)}`);
	}
	return [`~ ${visible(name)}`, ...lines];
}

/**
 * The change since approval, as report lines: files added, removed and edited, with the changed lines. Empty when
 * there is nothing stored to compare with.
 */
export function renderChanges(approved: readonly StoredFile[] | undefined, now: readonly ItemFile[]): string[] {
	if (!approved) return [];
	const before = new Map(approved.map((file) => [file.name, file]));
	const after = new Map(now.map((file) => [file.name, file]));
	const lines: string[] = [];
	for (const [name, file] of after) {
		const old = before.get(name);
		if (!old) lines.push(`+ ${visible(name)}  (new file)`);
		else if (old.omitted || file.bytes) {
			const same = !old.omitted && !file.bytes && old.text === file.text;
			if (!same) lines.push(`~ ${visible(name)}  (changed; content not kept for a line comparison)`);
		} else if (old.text !== file.text) lines.push(...fileDiff(name, old.text ?? "", file.text));
	}
	for (const name of before.keys()) if (!after.has(name)) lines.push(`- ${visible(name)}  (file removed)`);
	if (lines.length > MAX_LINES)
		return [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more changed lines not shown`];
	return lines.length ? lines : ["The files read the same; the content hash differs (for example a file's bytes)."];
}
