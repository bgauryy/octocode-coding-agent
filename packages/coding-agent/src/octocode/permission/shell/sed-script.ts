import type { Word } from "./program-forms.ts";

/**
 * What sed's words say: its operands (input files, and the script unless `-e`/`-f` gave one), the `-e`/`--expression`
 * scripts in order, whether a script comes from a file (`-f`, `--file`), and whether it edits in place (`-i`,
 * `--in-place`, BSD `-I`). Option values (`-e s`, `-f file`, `-l 80`) are not operands, nor is the empty word BSD sed
 * takes as the backup suffix after a bare `-i` (`sed -i '' s/a/b/ f`). In a short cluster `i` takes the rest as GNU's
 * suffix. BSD's `-I EXT` (getopt `I:`, FreeBSD usr.bin/sed/main.c) always takes a value: the rest of its cluster
 * (`-I.bak`) or the next word, empty or not; GNU sed has no `-I` and refuses it before opening a file. Long options
 * count by any abbreviation getopt accepts (`--expr=`).
 */
interface SedWords {
	operands: Word[];
	expressions: Word[];
	scriptFile: boolean;
	inPlace: boolean;
}

/** Whether the long option `name` (without its value) spells `full` or an abbreviation of it. */
const spells = (name: string, full: string): boolean => name.length > 2 && full.startsWith(name);

function sedWords(words: Word[]): SedWords {
	const found: SedWords = { operands: [], expressions: [], scriptFile: false, inPlace: false };
	let options = true;
	for (let at = 0; at < words.length; at++) {
		const word = words[at];
		if (options && word === "--") options = false;
		else if (!options || word === undefined || !word.startsWith("-") || word === "-") found.operands.push(word);
		else if (word.startsWith("--")) {
			const equals = word.indexOf("=");
			const name = equals < 0 ? word : word.slice(0, equals);
			const [expression, file] = [spells(name, "--expression"), spells(name, "--file")];
			if (spells(name, "--in-place")) found.inPlace = true;
			if (!expression && !file && !spells(name, "--line-length")) continue;
			const value = equals < 0 ? words[++at] : word.slice(equals + 1);
			if (expression) found.expressions.push(value);
			if (file) found.scriptFile = true;
		} else if (word === "-i" && words[at + 1] === "") {
			found.inPlace = true;
			at++;
		} else {
			for (let letter = 1; letter < word.length; letter++) {
				const flag = word[letter];
				if (flag === "i" || flag === "I") found.inPlace = true;
				if (flag === "I" && letter === word.length - 1) at++;
				if (flag === "i" || flag === "I") break;
				if (flag !== "e" && flag !== "f" && flag !== "l") continue;
				const value = letter === word.length - 1 ? words[++at] : word.slice(letter + 1);
				if (flag === "e") found.expressions.push(value);
				if (flag === "f") found.scriptFile = true;
				break;
			}
		}
	}
	return found;
}

/** Whether sed, given its words after `sed`, edits files in place: `-i`, `--in-place` or BSD `-I`, also in a cluster (`-nI`). */
export const sedInPlace = (words: Word[]): boolean => sedWords(words).inPlace;

/**
 * The files `sed -i` (or `-I`) rewrites, from its words after `sed`: the operands less the script (the first operand, unless `-e`
 * or `-f` gave one). A non-empty word after a bare `-i` stays: BSD reads it as the suffix, GNU as the script or a file.
 */
export function sedFiles(words: Word[]): Word[] {
	const { operands, expressions, scriptFile } = sedWords(words);
	// An unresolved script (`sed -i $S f`) may split into more words, files among them: it stays, and stays uncertain.
	const scripted = expressions.length > 0 || scriptFile;
	return scripted || (operands.length > 0 && operands[0] === undefined) ? operands : operands.slice(1);
}

/** The files a sed script writes, and why the guard cannot read all of it (`unread`, completing "sed's script …"). */
export interface SedWrites {
	writes: string[];
	unread?: string;
}

/** Files sed opens without writing to disk: `w /dev/stdout` prints. */
const STREAMS = new Set(["/dev/stdout", "/dev/stderr"]);
/** Commands without an argument; `q`, `Q`, `l`, `L` take an optional number. */
const BARE = "=dDgGhHnNpPxzF";
/** Commands whose argument runs to the end of the line: labels and `v` stop at `;` too (GNU), which reads more commands. */
const LABELS = ":btTv";

/**
 * The files sed's `script` writes: the `w` and `W` commands and the `w` flag of `s///w`, each naming a file up to the end
 * of its line. The scan follows sed's grammar so that a `w` in a regular expression, a replacement, `a`/`i`/`c` text, a
 * label, a `r` file name or a comment is not taken for a command: addresses (`3`, `$`, `/re/I`, `\%re%`, `1~2`, `a,+3`,
 * `!`), `s` and `y` with any delimiter and escapes, flags, `{`/`}` blocks and `;` or newline between commands. The
 * script is `unread` when it runs a command (`e`, or the `e` flag), has a command the scan does not know, an
 * unterminated part, or its delimiter inside a bracket expression (GNU ends the part there, BSD does not).
 */
function sedScriptWrites(script: string): SedWrites {
	const writes: string[] = [];
	let at = 0;
	const unread = (why: string): SedWrites => ({ writes, unread: why });
	const blank = () => {
		while (script[at] === " " || script[at] === "\t") at++;
	};
	const digits = () => {
		while (/\d/.test(script[at] ?? "")) at++;
	};
	/** `~N` or `+N` after a line number. */
	const step = () => {
		at++;
		digits();
	};
	const restOfLine = (stops = "\n"): string => {
		const from = at;
		while (at < script.length && !stops.includes(script[at])) at++;
		return script.slice(from, at);
	};
	const file = () => {
		const name = restOfLine().replace(/^[ \t]+/, "");
		if (name !== "" && !STREAMS.has(name)) writes.push(name);
	};
	/** Reads up to the unescaped `delimiter` closing a part; a regular expression also tracks bracket expressions. */
	const part = (delimiter: string | undefined, regex: boolean): string | undefined => {
		if (delimiter === undefined || delimiter === "\n" || delimiter === "\\")
			return "has a missing or invalid delimiter";
		let bracket = -1;
		while (at < script.length) {
			const char = script[at++];
			if (char === "\\") at++;
			else if (char === delimiter) return bracket < 0 ? undefined : "uses its delimiter inside a bracket expression";
			else if (regex && char === "[" && bracket < 0) bracket = script[at] === "^" ? ++at : at;
			else if (char === "]" && bracket >= 0 && at - 1 > bracket) bracket = -1;
		}
		return "has an unterminated part";
	};
	/** One address: a line number or step, `$`, or a regular expression with its flags. */
	const address = (): string | undefined => {
		const char = script[at];
		if (char === "/" || char === "\\") {
			const delimiter = char === "/" ? "/" : script[++at];
			at++;
			const wrong = part(delimiter, true);
			while (script[at] === "I" || script[at] === "M") at++;
			return wrong;
		}
		if (char === "$") at++;
		digits();
		if (script[at] === "~") step();
		return undefined;
	};
	while (at < script.length) {
		if (/[\s;}]/.test(script[at])) {
			at++;
			continue;
		}
		let wrong = address();
		if (!wrong && script[at] === ",") {
			at++;
			blank();
			if (script[at] === "+" || script[at] === "~") step();
			else wrong = address();
		}
		if (wrong) return unread(wrong);
		blank();
		while (script[at] === "!") {
			at++;
			blank();
		}
		const command = script[at++] ?? "";
		if (command === "") return unread("has an address without a command");
		if (command === "{" || command === "#" || command === "r" || command === "R") {
			if (command !== "{") restOfLine();
			continue;
		} else if (command === "w" || command === "W") {
			file();
			continue;
		} else if (command === "a" || command === "i" || command === "c") {
			// The text runs to the end of the line, and on while a line ends in an odd number of backslashes (`a\` then text).
			blank();
			if (script[at] === "\\") at += script[at + 1] === "\n" ? 2 : 1;
			while (/(?:^|[^\\])(?:\\\\)*\\$/.test(restOfLine()) && at < script.length) at++;
			continue;
		} else if (command === "s" || command === "y") {
			const delimiter = script[at++];
			wrong = part(delimiter, command === "s") ?? part(delimiter, false);
			if (wrong) return unread(wrong);
			if (command === "s") {
				while (/[gpiImM\d]/.test(script[at] ?? "")) at++;
				if (script[at] === "e") return unread("runs the pattern space as a command (the `e` flag)");
				if (script[at] === "w") {
					at++;
					file();
					continue;
				}
			}
		} else if (LABELS.includes(command)) restOfLine(";\n");
		else if ("qQlL".includes(command)) {
			blank();
			digits();
		} else if (command === "e") return unread("runs a command (`e`)");
		else if (!BARE.includes(command)) return unread(`has a command the guard does not know (\`${command}\`)`);
		blank();
		if (at < script.length && !";\n}#".includes(script[at])) return unread("has text after a command");
	}
	return { writes };
}

/**
 * The files sed writes by its script, from its words after `sed` (not the files `-i` rewrites: `sedFiles`). A script from
 * a file (`-f`) or an expansion (`sed "$S" f`) is `unread`; the visible `-e` scripts are still scanned.
 */
export function sedWrites(words: Word[]): SedWrites {
	const { operands, expressions, scriptFile } = sedWords(words);
	const parts = expressions.length > 0 || scriptFile ? expressions : operands.slice(0, 1);
	const scanned = parts.includes(undefined)
		? { writes: [], unread: "is an expansion the guard cannot read" }
		: sedScriptWrites(parts.join("\n"));
	if (scriptFile) scanned.unread ??= "is a file (`-f`) the guard does not read";
	return scanned;
}
