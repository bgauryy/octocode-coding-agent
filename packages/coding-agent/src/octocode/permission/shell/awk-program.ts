import { awkWords, type Word } from "./program-forms.ts";

/**
 * gawk's in-place edit, `-i inplace` or `--include=inplace` (any abbreviation of `--include`): the one option outside
 * the allowlist read for what it writes, so team reservations and the isolated-tree guard see its operands.
 */
function inPlaceTakes(word: string, next: Word): number | undefined {
	const inplace = (value: Word) => value !== undefined && /^inplace(?:\.awk)?$/.test(value);
	if (word === "-i") return inplace(next) ? 1 : undefined;
	if (word.startsWith("-i")) return inplace(word.slice(2)) ? 0 : undefined;
	const long = /^--([a-z]+)(?:=(.*))?$/.exec(word);
	if (!long || !"include".startsWith(long[1])) return undefined;
	if (long[2] !== undefined) return inplace(long[2]) ? 0 : undefined;
	return inplace(next) ? 1 : undefined;
}

/** An awk call's words read: its program (undefined when an expansion holds it), the first option outside the allowlist, `-i inplace`, and its operands. */
interface AwkCall {
	program: Word;
	hasProgram: boolean;
	option?: string;
	inPlace: boolean;
	files: Word[];
}

/** gawk and mawk options that take the next word as their value when it is not attached: `-f prog`, `-W posix`. */
const SHORT_WITH_VALUE = /^-[fEilWe]$/;
const LONG_WITH_VALUE = /^--(?:file|exec|include|load|source)$/;
/** Options whose value is a program file: the operands that follow are all input files. */
const PROGRAM_FILE = /^(?:-[fE]|--(?:file|exec))(?:$|=)|^-[fE]./;

/**
 * Reads options until the program. Only `-F sep`, `-Fsep`, `-v var=val`, `-vvar=val` and `--` are known: the first other
 * option is recorded (`option`, which makes the call uncertain) and the reading goes on by gawk's option arity, so an
 * in-place edit next to it still yields its operands for workspace reservations and receipts. The value after `-F` or
 * `-v` must be a literal word: an expansion, brace expansion, glob or substitution (undefined) can split into more options
 * (`-f /dev/stdin`), and a missing one is not read either.
 */
function readCall(words: readonly Word[]): AwkCall {
	let inPlace = false;
	let option: string | undefined;
	let programFile = false;
	let at = 0;
	for (; at < words.length; at++) {
		const word = words[at];
		if (word === "--") {
			at++;
			break;
		}
		if (word === undefined || word === "-" || !word.startsWith("-")) break;
		if (word === "-F" || word === "-v") {
			if (words[++at] === undefined) option ??= word;
			continue;
		}
		if (/^-[Fv]./.test(word)) continue;
		const takes = inPlaceTakes(word, words[at + 1]);
		if (takes !== undefined) {
			inPlace = true;
			at += takes;
			continue;
		}
		option ??= word;
		if (PROGRAM_FILE.test(word)) programFile = true;
		if (SHORT_WITH_VALUE.test(word) || LONG_WITH_VALUE.test(word)) at++;
	}
	if (programFile) return { program: undefined, hasProgram: false, option, inPlace, files: words.slice(at) };
	return { program: words[at], hasProgram: at < words.length, option, inPlace, files: words.slice(at + 1) };
}

/**
 * Text that makes an awk program uncertain, searched in the raw program with its strings and regular expressions left in:
 * a redirect, pipe or comparison (`>`, `|`), an indirect call, `@include` or `@load` (`@`), a command or input it runs
 * (`system`, `getline`, `close`, `fflush`), or a backslash-newline.
 */
const UNREAD: ReadonlyArray<[RegExp, string]> = [
	[/\\\r?\n/, "continues a line with a backslash-newline"],
	[/>/, "has `>` (`print > f` writes a file; the guard does not tell a comparison apart)"],
	[/\|/, "has `|` (`print | cmd` and `cmd | getline` run a command; the guard does not tell a regex or string apart)"],
	[/@/, "has `@` (an indirect call `@f()`, `@include` or `@load`)"],
	[/system/, "names `system` (`system()` runs a command)"],
	[/getline/, "names `getline` (it reads from a file or a command)"],
	[/close|fflush/, "names `close` or `fflush` (they act on a command or file the program opened)"],
];

/**
 * Why an awk call is uncertain, or undefined when the guard reads it all. Fail-safe: options other than `-F`, `-v` and
 * `--` (and `-i inplace`, read as an in-place edit) are not read, and a program is read only when its raw text has none
 * of `UNREAD`. The caller records the call as uncertain, as for sed's `w` it cannot read (`sed-script.ts`).
 */
function awkUncertainty(call: AwkCall): string | undefined {
	if (call.option !== undefined)
		return `awk's program runs with \`${call.option}\`, outside the options the guard reads (\`-F\`, \`-v\`, \`--\`)`;
	if (!call.hasProgram) return undefined;
	if (call.program === undefined) return "awk's program is an expansion the guard cannot read";
	const program = call.program;
	const found = UNREAD.find(([pattern]) => pattern.test(program));
	return found ? `awk's program ${found[1]}` : undefined;
}

/**
 * gawk's in-place edit loads `inplace.awk` through AWKPATH, which looks in `.` first and which the command can set
 * (`AWKPATH=dir gawk -i inplace`): code the guard does not read, so the strict callers treat the call as uncertain.
 */
const IN_PLACE_LOAD =
	"`-i inplace` loads inplace.awk through AWKPATH, which looks in `.` first and which the command can set";

/**
 * What an awk call changes on its own: why it is uncertain (`awkUncertainty`, or the in-place edit's library), for the
 * read-only role and the isolated-tree guard only, and the files `gawk -i inplace` rewrites, for every caller.
 */
interface AwkEffect {
	because?: string;
	inPlace?: { description: string; files: Word[] };
}

/**
 * The effect of a call to `name` with words `rest` when it runs an awk (`awkWords`), or undefined when it is no awk or
 * changes nothing on its own.
 */
export function awkEffect(name: string, rest: readonly Word[]): AwkEffect | undefined {
	const words = awkWords(name, rest);
	if (words === undefined) return undefined;
	const call = readCall(words);
	const because = awkUncertainty(call) ?? (call.inPlace ? `awk's ${IN_PLACE_LOAD}` : undefined);
	const label = words === rest ? name : `${name} ${rest[0]}`;
	const inPlace = call.inPlace ? { description: `${label} -i inplace`, files: call.files } : undefined;
	if (!because && !inPlace) return undefined;
	return { ...(because ? { because } : {}), ...(inPlace ? { inPlace } : {}) };
}
