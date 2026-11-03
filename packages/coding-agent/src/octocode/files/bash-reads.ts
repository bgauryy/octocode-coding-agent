import fs from "node:fs";
import { followableCdTarget } from "../permission/bash-cwd.ts";
import { resolveToolPath } from "../shared/home.ts";
import type { LineRange } from "./coverage.ts";

/**
 * Which files a `bash` command showed the model, for the file guard, whichever reader its refusals name. Each fully
 * literal command that prints file text is credited with what it printed: `cat FILE...`, `head [-n N] FILE`,
 * `tail -n +N FILE` and `sed -n 'A,Bp' FILE`, alone or as a segment of a list joined only by `;` or only by `&&` (the
 * tool succeeded, so each ran), after `cd DIR` steps that relative files resolve against (DIR is `.`, or starts with `/`
 * or `./`, with no `..`: `followableCdTarget`). A list mixing `;` and `&&` credits only its last command after `cd` steps.
 * Besides prints and `cd`, only `echo`, `printf`, `pwd`, `ls`, `true` and `wc` may share the list. A pipe, redirect, `||`, substitution, glob,
 * variable or unknown option, or any other command in the list shows nothing certain, so nothing in it is credited; the
 * model then reads again with one of these commands.
 */

/** What one command showed of one file. */
interface BashRead {
	file: string;
	/** The whole file. */
	whole: boolean;
	/** For a partial view: the lines it showed, when known. */
	lines?: LineRange;
}

const UNQUOTED_META = /[|&;<>()$`*?[\]{}~!#\\\n\r]/;
const CAT_FLAGS = /^-[AbeEnstTuv]+$/;
const COUNT = /^\d+$/;

/** The literal words of a single simple command, or undefined when the text is anything else. */
function literalWords(command: string): string[] | undefined {
	const words: string[] = [];
	let word: string | undefined;
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (char === "'") {
			const end = command.indexOf("'", i + 1);
			if (end === -1) return undefined;
			word = (word ?? "") + command.slice(i + 1, end);
			i = end;
		} else if (char === '"') {
			const end = command.indexOf('"', i + 1);
			if (end === -1) return undefined;
			const text = command.slice(i + 1, end);
			if (/[$`\\]/.test(text)) return undefined;
			word = (word ?? "") + text;
			i = end;
		} else if (char === " " || char === "\t") {
			if (word !== undefined) words.push(word);
			word = undefined;
		} else if (UNQUOTED_META.test(char)) {
			return undefined;
		} else {
			word = (word ?? "") + char;
		}
	}
	if (word !== undefined) words.push(word);
	return words;
}

function line(value: string | undefined): number | undefined {
	const number = value !== undefined && COUNT.test(value) ? Number(value) : undefined;
	return number !== undefined && Number.isSafeInteger(number) && number >= 1 ? number : undefined;
}

/** `head`'s line count and file: `-n N`, `-nN`, `-N` or none (10), then exactly one file. */
function headOf(args: string[]): { count: number; file: string } | undefined {
	let count = 10;
	let rest = args;
	const first = args[0] ?? "";
	if (first === "-n" && line(args[1])) {
		count = line(args[1])!;
		rest = args.slice(2);
	} else if (/^-n\d+$/.test(first) && line(first.slice(2))) {
		count = line(first.slice(2))!;
		rest = args.slice(1);
	} else if (/^-\d+$/.test(first) && line(first.slice(1))) {
		count = line(first.slice(1))!;
		rest = args.slice(1);
	}
	return rest.length === 1 && !rest[0].startsWith("-") ? { count, file: rest[0] } : undefined;
}

/** A `sed -n` script that prints one range: `5p`, `5,9p` or `5,$p`. */
function sedRange(script: string): LineRange | undefined {
	const match = /^(\d+)(?:,(\d+|\$))?p$/.exec(script);
	const first = line(match?.[1]);
	if (!first) return undefined;
	if (match![2] === undefined) return [first, first];
	if (match![2] === "$") return [first, Number.POSITIVE_INFINITY];
	const last = line(match![2]);
	return last && last >= first ? [first, last] : undefined;
}

/**
 * The other commands a credited list may hold: they write no file and change no directory or variable, so the printed
 * files are what the model saw. Any other segment (`sed -i`, `rm`, `source`, an assignment) could change them after the print.
 */
const HARMLESS = new Set(["echo", "printf", "pwd", "ls", "true", "wc"]);

/**
 * `command` split at unquoted `;` and `&&` into segments and the operators between them; undefined when the text holds a
 * backslash or newline, an unterminated quote (where a split could land inside a quoted word) or an empty segment.
 */
function chain(command: string): { segments: string[]; ops: string[] } | undefined {
	if (/[\\\n\r]/.test(command)) return undefined;
	const segments: string[] = [];
	const ops: string[] = [];
	let quote = "";
	let start = 0;
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (quote) {
			if (char === quote) quote = "";
		} else if (char === "'" || char === '"') {
			quote = char;
		} else if (char === ";" || (char === "&" && command[i + 1] === "&")) {
			const op = char === ";" ? ";" : "&&";
			segments.push(command.slice(start, i).trim());
			ops.push(op);
			i += op.length - 1;
			start = i + 1;
		}
	}
	if (quote) return undefined;
	const last = command.slice(start).trim();
	// A trailing `;` ends the list; a trailing `&&` waits for more input.
	if (last === "" && ops.at(-1) === ";") ops.pop();
	else segments.push(last);
	return segments.length === ops.length + 1 && segments.every((segment) => segment !== "")
		? { segments, ops }
		: undefined;
}

/** What one literal command printed of a file, `cwd` being its directory; `truncated`: the tool cut the output. */
function printed(words: string[], cwd: string, truncated: boolean): BashRead[] {
	const [name, ...args] = words;
	const read = (file: string, whole: boolean, lines?: LineRange): BashRead => ({
		file: resolveToolPath(cwd, file),
		whole: whole && !truncated,
		...(!whole && lines && !truncated ? { lines } : {}),
	});
	if (name === "cat") {
		const files = args.filter((arg) => !CAT_FLAGS.test(arg));
		return files.length > 0 && files.every((file) => !file.startsWith("-") && file !== "")
			? files.map((file) => read(file, true))
			: [];
	}
	if (name === "head") {
		const head = headOf(args);
		return head ? [read(head.file, false, [1, head.count])] : [];
	}
	if (name === "tail") {
		const [flag, count, file, ...extra] = args;
		const start = flag === "-n" && count?.startsWith("+") ? line(count.slice(1)) : undefined;
		return start && file && !file.startsWith("-") && extra.length === 0
			? [read(file, false, [start, Number.POSITIVE_INFINITY])]
			: [];
	}
	if (name === "sed") {
		const [flag, script, file, ...extra] = args;
		const range = flag === "-n" && script !== undefined ? sedRange(script) : undefined;
		return range && file && !file.startsWith("-") && extra.length === 0 ? [read(file, false, range)] : [];
	}
	return [];
}

/** The directory a literal `cd DIR` segment leads to, or undefined when it is not a followable literal one. */
function cdTarget(words: string[], cwd: string): string | undefined {
	const [, target, ...extra] = words;
	return target && extra.length === 0 && followableCdTarget(target) ? resolveToolPath(cwd, target) : undefined;
}

/**
 * The files `command` showed. `truncated`: the tool cut the output, so no view is certain to be whole or to hold the
 * lines asked for; the files still count as read in part.
 */
export function bashReads(command: string, shellCwd: string, truncated = false): BashRead[] {
	const parts = chain(command.trim());
	if (!parts) return [];
	const { segments, ops } = parts;
	// The command succeeded (a failed one is no result here), so every segment of an all-`&&` list ran, and every one of an
	// all-`;` list runs whatever its exit. A mix proves neither (`a && b; c` succeeds when `a` failed): then only leading
	// `cd` steps may precede the final command.
	const uniform = ops.every((op) => op === ops[0]);
	const steps = segments.map((segment) => literalWords(segment));
	// One segment that is not a print, a literal `cd` or harmless, or is not literal, voids the list: it may change what was printed.
	const known = (words: string[] | undefined): words is string[] =>
		words !== undefined &&
		words.length > 0 &&
		(words[0] === "cd" || HARMLESS.has(words[0]) || printed(words, shellCwd, false).length > 0);
	if (!steps.every(known)) return [];
	const reads: BashRead[] = [];
	let cwd = shellCwd;
	for (const [index, words] of steps.entries()) {
		if (words[0] === "cd") {
			const dir = cdTarget(words, cwd);
			// After `;` the next step runs even when the `cd` failed, in the old directory, so the new one must exist.
			if (!dir || (ops[index] === ";" && !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())) return [];
			cwd = dir;
		} else if (!HARMLESS.has(words[0])) {
			if (!uniform && index < segments.length - 1) return [];
			reads.push(...printed(words, cwd, truncated));
		}
	}
	return reads;
}
