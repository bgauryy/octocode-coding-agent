import { homedir } from "node:os";
import { isAbsolute, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";

/** A file path found in text, with its `:line[:col]` when written. */
export interface FileReference {
	/** Offset of the first character of the reference. */
	start: number;
	/** Offset just past the last character (line and column included). */
	end: number;
	/** The path as written, without line or column. */
	path: string;
	line?: number;
	column?: number;
}

/**
 * A path made of path characters that ends in an extension with a letter, optionally followed by a colon and a line
 * number and then a column. The lookbehind keeps it from starting inside a word, a URL (`://`), an email (`@`), a host
 * (`host:port`) or a longer path; the lookahead stops it before more identifier characters.
 */
const REFERENCE =
	/(?<![\w./\\@:~+-])((?:(?:[A-Za-z]:)?[\\/]|~[\\/]|\.{1,2}[\\/])?[\w.+~\\/-]*[\w-]\.([A-Za-z]\w{0,9}))(?::(\d+)(?::(\d+))?)?(?![\w/@\\]|:\d|\.\w)/g;

/**
 * Extensions that count as a file without a directory part when a line number follows: `example.com:8080` is a host,
 * `main.ts:4` is a file. Without a line number a path needs a directory part: `Node.js` is a name, `src/a.ts` a file.
 */
const BARE_FILE_EXTENSIONS = new Set(
	"ts tsx mts cts js jsx mjs cjs json jsonc md mdx py rb rs go java kt swift c h cc cpp hpp cs php sh bash zsh yml yaml toml xml html css scss vue svelte sql lock txt log ini cfg conf env".split(
		" ",
	),
);

/**
 * The file paths in `text`: `src/a.ts`, `~/x/b.md`, `src/a.ts:12[:3]`, `main.ts:4`; none for versions (`v1.2.3`), times
 * (`12:30`), names (`Node.js`), URLs and emails.
 */
export function findFileReferences(text: string): FileReference[] {
	const found: FileReference[] = [];
	// Every reference has a separator or a colon: most prose words have neither, and the scan is the costly part.
	if (!/[:\\/]/.test(text)) return found;
	for (const match of text.matchAll(REFERENCE)) {
		const path = match[1];
		const hasDirectory = /[\\/]/.test(path);
		if (match[3] === undefined) {
			if (!hasDirectory) continue;
			found.push({ start: match.index, end: match.index + match[0].length, path });
			continue;
		}
		if (!hasDirectory && !BARE_FILE_EXTENSIONS.has(match[2].toLowerCase())) continue;
		const line = Number(match[3]);
		if (line < 1) continue;
		const column = match[4] === undefined ? undefined : Number(match[4]);
		found.push({ start: match.index, end: match.index + match[0].length, path, line, column });
	}
	return found;
}

/** `text` when it is a single `http:`, `https:` or `file:` URL and nothing else, normalized; else undefined. */
export function wholeUrl(text: string): string | undefined {
	const trimmed = text.trim();
	if (!/^(?:https?|file):\/\/\S+$/i.test(trimmed) || !URL.canParse(trimmed)) return undefined;
	return new URL(trimmed).href;
}

/** A `file://` URL for `path`: absolute paths as written, `~/` from the home directory, others from `cwd`. */
export function fileReferenceUrl(path: string, cwd: string, line?: number, column?: number): string {
	const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(path) || /^[A-Za-z]:[\\/]|^\\\\/.test(cwd);
	const absolute = windows
		? win32.resolve(cwd, path)
		: path.startsWith("~/")
			? resolve(homedir(), path.slice(2))
			: isAbsolute(path)
				? path
				: resolve(cwd, path);
	const url = pathToFileURL(absolute, { windows });
	if (line !== undefined && Number.isSafeInteger(line) && line > 0) {
		url.hash = `L${line}${column !== undefined && Number.isSafeInteger(column) && column > 0 ? `:${column}` : ""}`;
	}
	return url.href;
}

/** Splits `text` into plain pieces and file references, in order; the pieces joined are `text` unchanged. */
export function splitFileReferences(text: string): Array<{ text: string; reference?: FileReference }> {
	const pieces: Array<{ text: string; reference?: FileReference }> = [];
	let at = 0;
	for (const reference of findFileReferences(text)) {
		if (reference.start > at) pieces.push({ text: text.slice(at, reference.start) });
		pieces.push({ text: text.slice(reference.start, reference.end), reference });
		at = reference.end;
	}
	if (at < text.length) pieces.push({ text: text.slice(at) });
	return pieces;
}
