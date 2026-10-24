import { resolveToolPath } from "../shared/home.ts";
import type { LineRange } from "./coverage.ts";

/**
 * Which files a `bash` command showed the model, for the file guard while Octocode's local readers are unavailable
 * (`BASH_READER`). Only a lone, fully literal command that prints file text is credited: `cat FILE...`,
 * `head [-n N] FILE`, `tail -n +N FILE` and `sed -n 'A,Bp' FILE`. A pipe, redirect, list, substitution, glob, variable or
 * unknown option shows nothing certain, so it is not credited; the model then reads again with one of these commands.
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
 * The files `command` showed. `truncated`: the tool cut the output, so no view is certain to be whole or to hold the
 * lines asked for; the files still count as read in part.
 */
export function bashReads(command: string, cwd: string, truncated = false): BashRead[] {
	const words = literalWords(command.trim());
	if (!words?.length) return [];
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
